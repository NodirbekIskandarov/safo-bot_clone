import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, resetStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { runningCount } from "../runtime/registry.js";
import { adminTgIds, audit, isAdmin, isRootAdmin } from "./access.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { BTN, isMenuButton } from "./menu.js";
import { templateList } from "../templates/index.js";
import { InsufficientFunds, move } from "../billing/wallet.js";
import { premiumActive } from "../billing/subscription.js";

const SCOPE = "padmin";
export const PANEL_BUTTON = BTN.panel;

function panelKeyboard(pending: number, unanswered: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(pending > 0 ? `🧾 To'lovlar (${pending})` : "🧾 To'lovlar", "pa:pay")
    .text("📊 Statistika", "pa:stat")
    .row()
    .text("💳 To'lov sozlamalari", "pa:payset")
    .row()
    .text(unanswered > 0 ? `✉️ Murojaatlar (${unanswered})` : "✉️ Murojaatlar", "pa:sup")
    .text("👑 Adminlar", "pa:admins")
    .row()
    .text("💰 Balanslar", "pa:bal")
    .text("💎 Premium", "pa:prem")
    .row()
    .text("🤖 Botlar", "pa:bots");
}

export async function showPanel(ctx: Context, edit = false) {
  const [pending, unanswered] = await Promise.all([
    db.payment.count({ where: { status: "pending" } }),
    db.supportMessage.count({ where: { answered: false } }),
  ]);
  const text = `🛠 <b>Platforma boshqaruvi</b>\n\nKerakli bo'limni tanlang.`;
  const kb = panelKeyboard(pending, unanswered);
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

const back = new InlineKeyboard().text("◀️ Orqaga", "pa:menu");

// ----------------------------------------------------------- payment settings

async function showPaySettings(ctx: Context) {
  const [card, holder, plans] = await Promise.all([
    getSetting(SETTING_KEYS.cardNumber),
    getSetting(SETTING_KEYS.cardHolder),
    db.plan.count({ where: { isActive: true, isArchived: false } }),
  ]);
  await ctx.editMessageText(
    `💳 <b>To'lov sozlamalari</b>\n\n` +
      `💳 Karta: ${card ? `<code>${esc(card)}</code>` : "<i>sozlanmagan</i>"}${holder ? ` · ${esc(holder)}` : ""}\n` +
      `📦 Faol tariflar: <b>${plans}</b>\n\n` +
      `• <b>Tariflar</b> — har bir tarifning oylik narxi, obunachi limiti, kunlik xabar limiti\n` +
      `• <b>Shablonlar</b> — har bir bot turining narxi va qaysi tarifda ishlashi`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("💳 Karta", "pa:card").text("📦 Tariflar", "pa:plans").row()
        .text("🧩 Shablonlar (bot turlari)", "pa:tpl").row()
        .text("◀️ Orqaga", "pa:menu"),
    },
  ).catch(() => {});
}

async function showPlans(ctx: Context) {
  const plans = await db.plan.findMany({ where: { isArchived: false }, orderBy: { sortOrder: "asc" } });
  const kb = new InlineKeyboard();
  for (const p of plans) {
    const mark = p.isActive ? "" : "🚫 ";
    const price = p.priceUzs > 0 ? money(p.priceUzs) : "bepul";
    kb.text(`${mark}${p.name} · ${price} · ${p.maxBotUsers}👥`, `pa:plv:${p.code}`).row();
  }
  kb.text("◀️ Orqaga", "pa:payset");
  await ctx.editMessageText(
    `📦 <b>Tariflar</b>\n\nTahrirlash uchun tarifni bosing.\n\n` +
      `<i>Narx o'zgarsa, allaqachon to'langan muddat o'zgarmaydi — yangi narx keyingi to'lovdan amal qiladi.</i>`,
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

async function showPlan(ctx: Context, code: string) {
  const p = await db.plan.findUnique({ where: { code } });
  if (!p) return;
  const f = JSON.parse(p.features) as { broadcastDailyLimit: number; orders: boolean };
  const subs = await db.subscription.count({ where: { planId: p.id, status: { in: ["active", "grace"] } } });
  const kb = new InlineKeyboard();
  if (p.code !== "trial") kb.text("💵 Oylik narx", `pa:ple:${p.code}:price`);
  kb.text("👥 Obunachi limiti", `pa:ple:${p.code}:users`).row()
    .text("📢 Kunlik xabar limiti", `pa:ple:${p.code}:bc`).row();
  if (p.code !== "trial") kb.text(p.isActive ? "🚫 Sotuvdan olish" : "✅ Sotuvga qo'yish", `pa:plh:${p.code}`).row();
  kb.text("◀️ Tariflar", "pa:plans");

  await ctx.editMessageText(
    `📦 <b>${esc(p.name)}</b> <code>${p.code}</code>\n\n` +
      `💵 Narx: <b>${p.priceUzs > 0 ? `${money(p.priceUzs)}/oy` : "bepul"}</b>\n` +
      (p.code === "trial" ? `⏱ Muddat: ${p.intervalDays} kun\n` : "") +
      `👥 Obunachi limiti: <b>${p.maxBotUsers}</b>\n` +
      `📢 Kunlik xabar: <b>${f.broadcastDailyLimit}</b>\n` +
      `🛒 Buyurtma: <b>${f.orders ? "bor (biznes)" : "yo'q"}</b>\n` +
      `${p.isActive ? "✅ Sotuvda" : "🚫 Sotuvda emas"} · Faol obunalar: ${subs}`,
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

async function showTemplate(ctx: Context, key: string) {
  const t = templateList.find((x) => x.key === key);
  const p = await db.templatePrice.findUnique({ where: { key } });
  if (!t || !p) return;
  const [sold, built] = await Promise.all([
    db.ownerTemplate.count({ where: { templateKey: key } }),
    db.bot.count({ where: { templateKey: key } }),
  ]);

  await ctx.editMessageText(
    `${t.emoji} <b>${esc(t.name)}</b>\n\n` +
      `👁 Holat: ${p.isEnabled ? "✅ ro'yxatda ko'rinadi" : "🚫 yashirilgan"}\n` +
      `💵 Narx: ${p.isForSale && p.priceUzs > 0 ? `🔒 ${money(p.priceUzs)} (bir martalik)` : "🆓 bepul (tarifga kiradi)"}\n` +
      `📦 Tarif: ${p.planGroup === "business" ? "🛒 faqat biznes tariflarda" : "🌐 har qanday tarifda"}\n\n` +
      `📊 Sotib olganlar: <b>${sold}</b>\n🤖 Yaratilgan botlar: <b>${built}</b>`,
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("💵 Narx belgilash", `pa:tplp:${key}`)
        .row()
        .text(p.isForSale ? "🆓 Bepul qilish" : "🔒 Pullik qilish", `pa:tpls:${key}`)
        .row()
        .text(p.planGroup === "business" ? "🌐 Har qanday tarifga ruxsat" : "🛒 Faqat biznes tarif", `pa:tplg:${key}`)
        .row()
        .text(p.isEnabled ? "🚫 Yashirish" : "✅ Ko'rsatish", `pa:tple:${key}`)
        .row()
        .text("◀️ Orqaga", "pa:tpl"),
    },
  ).catch(() => {});
}

export function registerPlatformAdmin(bot: Bot) {
  const guard = async (ctx: Context): Promise<boolean> => {
    const ok = await isAdmin(BigInt(ctx.from!.id));
    if (!ok && ctx.callbackQuery) await ctx.answerCallbackQuery("Ruxsat yo'q");
    return ok;
  };

  const openPanel = async (ctx: Context) => {
    if (!(await isAdmin(BigInt(ctx.from!.id)))) return;
    clearStep(SCOPE, ctx.from!.id);
    await showPanel(ctx);
  };
  bot.command("panel", openPanel);
  bot.hears(PANEL_BUTTON, openPanel);

  bot.callbackQuery("pa:menu", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showPanel(ctx, true);
  });

  // ------------------------------------------------------------- payments

  bot.callbackQuery("pa:pay", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();

    const pending = await db.payment.findMany({
      where: { status: "pending" },
      include: { owner: true, plan: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    // Premium members are reviewed first — that is part of what they pay for.
    pending.sort((a, b) => Number(premiumActive(b.owner)) - Number(premiumActive(a.owner)));

    if (pending.length === 0) {
      return void ctx.editMessageText("🧾 Kutilayotgan to'lov yo'q.", { reply_markup: back });
    }

    const kb = new InlineKeyboard();
    for (const p of pending.slice(0, 10)) {
      const star = premiumActive(p.owner) ? "💎 " : "";
      kb.text(`${star}${p.reference} · ${money(p.amountUzs)} · ${p.owner.fullName.slice(0, 15)}`, `pa:payv:${p.id}`).row();
    }
    kb.text("◀️ Orqaga", "pa:menu");

    await ctx.editMessageText(`🧾 <b>Kutilayotgan to'lovlar: ${pending.length}</b>`, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^pa:payv:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();

    const payment = await db.payment.findUnique({
      where: { id: ctx.match[1]! },
      include: { owner: true, plan: true, subscription: { include: { bot: true } } },
    });
    if (!payment) return;

    const caption =
      `🧾 <b>${payment.reference}</b>\n\n` +
      `👤 ${esc(payment.owner.fullName)}` +
      (payment.owner.username ? ` (@${esc(payment.owner.username)})` : "") +
      `\n🆔 <code>${payment.owner.tgUserId}</code>\n` +
      `🤖 @${esc(payment.subscription?.bot.tgUsername ?? "—")}\n` +
      `📦 ${esc(payment.plan?.name ?? (payment.kind === "topup" ? "Balans to'ldirish" : payment.templateKey ?? "—"))} — <b>${money(payment.amountUzs)}</b>` +
      (payment.receiptText ? `\n\n💬 ${esc(payment.receiptText)}` : "");

    const kb = new InlineKeyboard()
      .text("✅ Tasdiqlash", `adm:pay:ok:${payment.id}`)
      .text("❌ Rad etish", `adm:pay:no:${payment.id}`)
      .row()
      .text("◀️ Orqaga", "pa:pay");

    if (payment.receiptFileId) {
      await ctx.replyWithPhoto(payment.receiptFileId, { caption, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.editMessageText(caption, { parse_mode: "HTML", reply_markup: kb });
    }
  });

  // ------------------------------------------------------ payment settings

  bot.callbackQuery("pa:payset", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showPaySettings(ctx);
  });

  bot.callbackQuery("pa:plans", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showPlans(ctx);
  });

  bot.callbackQuery(/^pa:plv:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showPlan(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^pa:ple:(\w+):(price|users|bc)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const [, code, field] = ctx.match;
    const label = { price: "oylik narxini (so'mda)", users: "obunachi limitini", bc: "kunlik xabar limitini" }[field!];
    resetStep(SCOPE, ctx.from!.id, "await_plan_field", { code, field });
    await ctx.editMessageText(`✏️ Tarifning yangi ${label} yuboring — faqat raqam.\n\nBekor: /bekor`, {
      reply_markup: new InlineKeyboard().text("◀️ Orqaga", `pa:plv:${code}`),
    });
  });

  bot.callbackQuery(/^pa:plh:(\w+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const plan = await db.plan.findUnique({ where: { code: ctx.match[1]! } });
    if (!plan || plan.code === "trial") return ctx.answerCallbackQuery();
    await db.plan.update({ where: { id: plan.id }, data: { isActive: !plan.isActive } });
    await audit(BigInt(ctx.from.id), "plan.active", plan.code, { isActive: !plan.isActive });
    await ctx.answerCallbackQuery(plan.isActive ? "Sotuvdan olindi" : "Sotuvga qo'yildi");
    await showPlan(ctx, plan.code);
  });

  // --------------------------------------------------------------- admins

  bot.callbackQuery("pa:admins", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();

    const ids = await adminTgIds();
    const owners = await db.owner.findMany({ where: { tgUserId: { in: ids } } });
    const byId = new Map(owners.map((o) => [o.tgUserId.toString(), o]));

    const lines = ids.map((id) => {
      const o = byId.get(id.toString());
      const root = isRootAdmin(id) ? " 👑" : "";
      const name = o ? esc(o.fullName) : "—";
      const handle = o?.username ? ` @${esc(o.username)}` : "";
      return `• <code>${id}</code> — ${name}${handle}${root}`;
    });

    await ctx.editMessageText(
      `👑 <b>Adminlar: ${ids.length}</b>\n\n${lines.join("\n")}\n\n` +
        `👑 — asosiy admin (.env da), uni bot orqali olib bo'lmaydi.\n\n` +
        `Har bir admin yangi admin qo'sha oladi.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Admin qo'shish", "pa:adminadd")
          .text("➖ Olib tashlash", "pa:admindel")
          .row()
          .text("◀️ Orqaga", "pa:menu"),
      },
    );
  });

  bot.callbackQuery("pa:adminadd", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_admin_add");
    await ctx.editMessageText(
      `➕ <b>Admin qo'shish</b>\n\nYangi adminning <b>Telegram ID</b> raqamini yuboring.\n\n` +
        `<i>ID ni @userinfobot beradi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("pa:admindel", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_admin_del");
    await ctx.editMessageText(`➖ <b>Adminlikdan olish</b>\n\nTelegram ID raqamini yuboring.\n\nBekor: /bekor`, {
      parse_mode: "HTML",
    });
  });

  // ----------------------------------------------------------------- card

  bot.callbackQuery("pa:card", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const [card, holder] = await Promise.all([
      getSetting(SETTING_KEYS.cardNumber),
      getSetting(SETTING_KEYS.cardHolder),
    ]);
    // No auto-edit mode: entering it on open turned every later tap into a
    // failed card number.
    await ctx.editMessageText(
      `💳 <b>To'lov kartasi</b>\n\n` +
        `Karta: ${card ? `<code>${esc(card)}</code>` : "<i>sozlanmagan</i>"}\n` +
        `Egasi: ${holder ? esc(holder) : "<i>sozlanmagan</i>"}\n\n` +
        (card ? "Mijozlar to'lov oynasida shu rekvizitni ko'radi." : "⚠️ Kartasiz to'lov oynasi ochilmaydi."),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✏️ O'zgartirish", "pa:cardedit")
          .row()
          .text("◀️ Orqaga", "pa:payset"),
      },
    );
  });

  bot.callbackQuery("pa:cardedit", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_card");
    await ctx.editMessageText(
      `✏️ <b>Karta o'zgartirish</b>\n\nQuyidagi ko'rinishda yuboring:\n\n` +
        `<code>8600 1234 5678 9012\nISM FAMILIYA</code>\n\n` +
        `<i>Birinchi qator — karta, ikkinchi qator — egasining ismi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // ----------------------------------------------------------- stats/bots

  bot.callbackQuery("pa:stat", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();

    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [owners, bots, users, paidThisMonth, pending, live] = await Promise.all([
      db.owner.count(),
      db.bot.count(),
      db.botUser.count(),
      db.payment.aggregate({
        where: { status: "approved", reviewedAt: { gte: monthStart } },
        _sum: { amountUzs: true },
        _count: true,
      }),
      db.payment.count({ where: { status: "pending" } }),
      db.subscription.count({ where: { status: { in: ["trial", "active", "grace"] } } }),
    ]);

    const byStatus = await db.subscription.groupBy({ by: ["status"], _count: true });
    const statusLine = byStatus.map((s) => `${s.status}: ${s._count}`).join(" · ");

    await ctx.editMessageText(
      `📊 <b>Platforma statistikasi</b>\n\n` +
        `👤 Ownerlar: <b>${owners}</b>\n` +
        `🤖 Botlar: <b>${bots}</b> (ishlayapti: ${runningCount()})\n` +
        `👥 Bot foydalanuvchilari: <b>${users}</b>\n\n` +
        `💰 <b>Shu oy tushum: ${money(paidThisMonth._sum.amountUzs ?? 0)}</b>\n` +
        `   To'lovlar soni: ${paidThisMonth._count}\n` +
        `   Kutilmoqda: ${pending}\n\n` +
        `📋 Faol obunalar: <b>${live}</b>\n<i>${statusLine}</i>`,
      { parse_mode: "HTML", reply_markup: back },
    );
  });

  bot.callbackQuery("pa:bots", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();

    const bots = await db.bot.findMany({
      include: { owner: true, subscription: { include: { plan: true } }, _count: { select: { users: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const lines = bots.map((b) => {
      const mark = b.status === "active" ? "🟢" : b.status === "error" ? "🔴" : "⚪️";
      const sub = b.subscription;
      const plan = sub ? `${sub.plan.name}/${sub.status}` : "—";
      return `${mark} @${esc(b.tgUsername)} · ${b._count.users}👥 · ${esc(plan)}`;
    });

    await ctx.editMessageText(`🤖 <b>Botlar: ${bots.length}</b>\n\n${lines.join("\n") || "Hali yo'q."}`, {
      parse_mode: "HTML",
      reply_markup: back,
    });
  });

  // -------------------------------------------------------------- support

  bot.callbackQuery("pa:sup", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const open = await db.supportMessage.findMany({ where: { answered: false }, orderBy: { createdAt: "asc" }, take: 10 });
    const owners = await db.owner.findMany({ where: { id: { in: open.map((m) => m.ownerId) } } });
    const byId = new Map(owners.map((o) => [o.id, o]));
    const kb = new InlineKeyboard();
    for (const m of open) {
      kb.text(`✍️ ${byId.get(m.ownerId)?.fullName.slice(0, 15) ?? "?"}: ${m.text.slice(0, 25)}`, `sup:pl:${m.id}`).row();
    }
    kb.text("◀️ Orqaga", "pa:menu");
    await ctx.editMessageText(
      `✉️ <b>Javobsiz murojaatlar: ${open.length}</b>` + (open.length ? "\n\nJavob berish uchun bosing." : ""),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^sup:pl:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const message = await db.supportMessage.findUnique({ where: { id: ctx.match[1]! } });
    if (!message) return ctx.answerCallbackQuery("Topilmadi");
    if (message.answered) return ctx.answerCallbackQuery({ text: "Bu murojaatga allaqachon javob berilgan", show_alert: true });
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_sup_reply", { messageId: message.id });
    await ctx.reply(
      `✍️ <b>Javob yozing</b>\n\n<i>${esc(message.text.slice(0, 300))}</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // ---------------------------------------------------------------- premium

  bot.callbackQuery("pa:prem", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const members = await db.owner.findMany({ where: { isPremium: true }, take: 20 });
    const lines = members.map(
      (o) =>
        `• ${esc(o.fullName)} — <code>${o.tgUserId}</code>` +
        (o.premiumUntil ? ` (${o.premiumUntil.toLocaleDateString("uz-UZ")}${premiumActive(o) ? "" : ", tugagan"})` : ""),
    );
    await ctx.editMessageText(
      `💎 <b>Premium a'zolar: ${members.length}</b>\n\n` +
        (lines.join("\n") || "<i>Hali yo'q.</i>") +
        `\n\n<b>Premium nima beradi:</b>\n` +
        `• Barcha tariflarga <b>−10%</b> chegirma\n` +
        `• To'lovlari ro'yxatda birinchi ko'riladi\n` +
        `• Ilovada 💎 belgisi\n\n` +
        `<i>Premium 1 yilga beriladi.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Premium berish", "pa:premadd")
          .text("➖ Bekor qilish", "pa:premdel")
          .row()
          .text("◀️ Orqaga", "pa:menu"),
      },
    );
  });

  bot.callbackQuery(/^pa:prem(add|del)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, ctx.match[1] === "add" ? "await_prem_add" : "await_prem_del");
    await ctx.editMessageText(`💎 <b>Premium</b>\n\nFoydalanuvchining <b>Telegram ID</b> raqamini yuboring.\n\nBekor: /bekor`, {
      parse_mode: "HTML",
    });
  });

  // ------------------------------------------------- template price control

  bot.callbackQuery("pa:tpl", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    const prices = await db.templatePrice.findMany({ orderBy: { sortOrder: "asc" } });
    const byKey = new Map(prices.map((p) => [p.key, p]));

    const kb = new InlineKeyboard();
    for (const t of templateList) {
      const p = byKey.get(t.key);
      const state = !p?.isEnabled ? "🚫" : p.isForSale && p.priceUzs > 0 ? `🔒 ${money(p.priceUzs)}` : "🆓";
      const group = p?.planGroup === "business" ? " · 🛒" : "";
      kb.text(`${state} ${t.emoji} ${t.name}${group}`, `pa:tplv:${t.key}`).row();
    }
    kb.text("◀️ Orqaga", "pa:payset");

    await ctx.editMessageText(
      `🧩 <b>Shablonlar (bot turlari)</b>\n\n` +
        `🆓 — har qanday tarifga kiradi\n` +
        `🔒 — alohida sotiladi (bir martalik to'lov)\n` +
        `🛒 — faqat biznes tariflarda ishlaydi\n` +
        `🚫 — ro'yxatda ko'rinmaydi\n\n` +
        `O'zgartirish uchun shablonni bosing.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^pa:tplv:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showTemplate(ctx, ctx.match[1]!);
  });

  const toggleTemplate = (
    pattern: RegExp,
    field: "isForSale" | "isEnabled" | "planGroup",
    action: string,
  ) =>
    bot.callbackQuery(pattern, async (ctx) => {
      if (!(await guard(ctx))) return;
      const key = (ctx.match as RegExpMatchArray)[1]!;
      const p = await db.templatePrice.findUnique({ where: { key } });
      if (!p) return ctx.answerCallbackQuery("Topilmadi");
      const data =
        field === "planGroup"
          ? { planGroup: p.planGroup === "business" ? "any" : "business" }
          : { [field]: !p[field] };
      await db.templatePrice.update({ where: { key }, data });
      await audit(BigInt(ctx.from!.id), action, key, data);
      await ctx.answerCallbackQuery("O'zgartirildi");
      await showTemplate(ctx, key);
    });
  toggleTemplate(/^pa:tpls:(.+)$/, "isForSale", "template.forsale");
  toggleTemplate(/^pa:tple:(.+)$/, "isEnabled", "template.enabled");
  toggleTemplate(/^pa:tplg:(.+)$/, "planGroup", "template.plangroup");

  bot.callbackQuery(/^pa:tplp:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_tpl_price", { key: ctx.match[1] });
    await ctx.editMessageText(
      `💵 <b>Narx belgilash</b>\n\nSummani so'mda yuboring (faqat raqam).\n\n` +
        `<i>0 yozsangiz shablon bepul bo'ladi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // ------------------------------------------------------ balance control

  bot.callbackQuery("pa:bal", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const top = await db.owner.findMany({ where: { balanceUzs: { gt: 0 } }, orderBy: { balanceUzs: "desc" }, take: 10 });
    const total = await db.owner.aggregate({ _sum: { balanceUzs: true } });
    const lines = top.map((o) => `• ${esc(o.fullName)} — <b>${money(o.balanceUzs)}</b>\n     <code>${o.tgUserId}</code>`);

    await ctx.editMessageText(
      `💰 <b>Foydalanuvchi balanslari</b>\n\n` +
        `Jami majburiyat: <b>${money(total._sum.balanceUzs ?? 0)}</b>\n` +
        `<i>Bu — foydalanuvchilar to'lagan, lekin hali sarflanmagan pul.</i>\n\n` +
        (lines.join("\n") || "Hech kimda balans yo'q."),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("➕ Balans o'zgartirish", "pa:baladd").row().text("◀️ Orqaga", "pa:menu"),
      },
    );
  });

  bot.callbackQuery("pa:baladd", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_bal_add");
    await ctx.editMessageText(
      `➕ <b>Qo'lda balans o'zgartirish</b>\n\nQuyidagi ko'rinishda yuboring:\n\n` +
        `<code>123456789 50000</code>\n\n` +
        `<i>Telegram ID, bo'sh joy, summa. Manfiy summa yechib oladi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // --------------------------------------------------------- text handler

  /** Consumes text typed into an admin wizard; everything else passes through. */
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith("/") || !ctx.from || isMenuButton(text)) return next();

    const state = getStep(SCOPE, ctx.from.id);
    if (!state) return next();
    if (!(await isAdmin(BigInt(ctx.from.id)))) return next();

    const actor = BigInt(ctx.from.id);
    // Every amount ends up in an INT column: refuse anything that would not fit.
    const INT_MAX = 2_000_000_000;
    const digitsOnly = (s: string) => {
      if (!/^\s*\d[\d\s]*$/.test(s)) return null;
      const n = Number(s.replace(/\s/g, ""));
      return Number.isSafeInteger(n) && n <= INT_MAX ? n : null;
    };

    switch (state.step) {
      case "await_admin_add": {
        const id = text.replace(/\D/g, "");
        if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
        const tgId = BigInt(id);
        await db.owner.upsert({
          where: { tgUserId: tgId },
          create: { tgUserId: tgId, fullName: `Admin ${id}`, isPlatformAdmin: true, adminAddedBy: actor, adminAddedAt: new Date() },
          update: { isPlatformAdmin: true, adminAddedBy: actor, adminAddedAt: new Date() },
        });
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, "admin.add", id);
        await ctx.reply(`✅ <code>${id}</code> admin qilindi.`, { parse_mode: "HTML" });
        await ctx.api
          .sendMessage(Number(tgId), `👑 Sizga <b>platforma administratori</b> huquqi berildi.\n\n/start bosing — pastda «${PANEL_BUTTON}» tugmasi paydo bo'ladi.`, {
            parse_mode: "HTML",
          })
          .catch(() => {
            void ctx.reply("<i>Eslatma: u hali botga /start bosmagan, shuning uchun xabar yetmadi.</i>", { parse_mode: "HTML" });
          });
        return;
      }

      case "await_admin_del": {
        const id = text.replace(/\D/g, "");
        if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
        const tgId = BigInt(id);
        if (isRootAdmin(tgId)) return void ctx.reply("❌ Asosiy adminni (.env dagi) bot orqali olib bo'lmaydi.");
        await db.owner.updateMany({ where: { tgUserId: tgId }, data: { isPlatformAdmin: false } });
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, "admin.remove", id);
        return void ctx.reply(`✅ <code>${id}</code> adminlikdan olindi.`, { parse_mode: "HTML" });
      }

      case "await_prem_add":
      case "await_prem_del": {
        const grant = state.step === "await_prem_add";
        const id = text.replace(/\D/g, "");
        if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
        const target = await db.owner.findUnique({ where: { tgUserId: BigInt(id) } });
        if (!target) return void ctx.reply("Foydalanuvchi topilmadi (u botga /start bosganmi?).");

        await db.owner.update({
          where: { id: target.id },
          data: { isPremium: grant, premiumUntil: grant ? new Date(Date.now() + 365 * 24 * 3600 * 1000) : null },
        });
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, grant ? "premium.grant" : "premium.revoke", id);
        await ctx.reply(grant ? `💎 ${esc(target.fullName)} — premium berildi.` : `Premium bekor qilindi.`, { parse_mode: "HTML" });
        if (grant) {
          await ctx.api
            .sendMessage(
              Number(target.tgUserId),
              `💎 <b>Sizga Premium berildi!</b>\n\n` +
                `• Barcha tariflarga <b>−10%</b> chegirma\n` +
                `• To'lovlaringiz birinchi ko'riladi\n\n` +
                `Chegirma keyingi to'lovingizda avtomatik qo'llanadi.`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
        return;
      }

      case "await_tpl_price": {
        const key = state.data.key as string;
        const price = digitsOnly(text);
        if (price === null) return void ctx.reply("Faqat raqam yuboring, masalan 50000. Bepul qilish uchun: 0");
        await db.templatePrice.update({ where: { key }, data: { priceUzs: price, isForSale: price > 0 } });
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, "template.price", key, { priceUzs: price });
        return void ctx.reply(price > 0 ? `✅ Narx belgilandi: <b>${money(price)}</b>` : "✅ Shablon bepul qilindi.", {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Shablon", `pa:tplv:${key}`),
        });
      }

      case "await_plan_field": {
        const code = state.data.code as string;
        const field = state.data.field as "price" | "users" | "bc";
        const value = digitsOnly(text);
        if (value === null || (field !== "bc" && value <= 0)) return void ctx.reply("Faqat musbat raqam yuboring.");
        const plan = await db.plan.findUnique({ where: { code } });
        if (!plan) return void clearStep(SCOPE, ctx.from.id);

        if (field === "price") await db.plan.update({ where: { id: plan.id }, data: { priceUzs: value } });
        if (field === "users") await db.plan.update({ where: { id: plan.id }, data: { maxBotUsers: value } });
        if (field === "bc") {
          const features = { ...(JSON.parse(plan.features) as Record<string, unknown>), broadcastDailyLimit: value };
          await db.plan.update({ where: { id: plan.id }, data: { features: JSON.stringify(features) } });
        }
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, `plan.${field}`, code, { value });
        return void ctx.reply(`✅ Saqlandi: <b>${esc(plan.name)}</b>`, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ Tarif", `pa:plv:${code}`),
        });
      }

      case "await_bal_add": {
        const parts = text.split(/\s+/);
        const tgId = parts[0]?.replace(/\D/g, "");
        const amount = Number(parts[1]?.replace(/[^\d-]/g, ""));
        if (!tgId || !Number.isInteger(amount) || amount === 0 || Math.abs(amount) > INT_MAX) {
          return void ctx.reply("Format: <code>123456789 50000</code>", { parse_mode: "HTML" });
        }
        const target = await db.owner.findUnique({ where: { tgUserId: BigInt(tgId) } });
        if (!target) return void ctx.reply("Bunday foydalanuvchi topilmadi (u botga /start bosganmi?).");

        let left: number;
        try {
          // "adjust", not "bonus": a manual credit must not show up as referral earnings.
          left = await move(target.id, amount, "adjust", { note: `Admin ${ctx.from.id}` });
        } catch (err) {
          if (err instanceof InsufficientFunds) {
            return void ctx.reply(`❌ Balansda faqat ${money(err.haveUzs)} bor — bunchalik yechib bo'lmaydi.`);
          }
          throw err;
        }
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, "balance.manual", tgId, { amount });
        await ctx.reply(`✅ ${esc(target.fullName)} balansi: <b>${money(left)}</b> (${amount > 0 ? "+" : ""}${money(amount)})`, {
          parse_mode: "HTML",
        });
        await ctx.api
          .sendMessage(
            Number(target.tgUserId),
            amount > 0
              ? `💰 Balansingizga <b>${money(amount)}</b> qo'shildi.\nYangi balans: <b>${money(left)}</b>`
              : `ℹ️ Balansingizdan <b>${money(-amount)}</b> yechildi.\nQolgan: <b>${money(left)}</b>`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
        return;
      }

      case "await_card": {
        const [card, ...rest] = text.split("\n");
        const digits = (card ?? "").replace(/\D/g, "");
        if (digits.length < 12) return void ctx.reply("Karta raqami noto'g'ri. Kamida 12 ta raqam bo'lishi kerak.");
        const pretty = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
        await setSetting(SETTING_KEYS.cardNumber, pretty);
        if (rest.length > 0) await setSetting(SETTING_KEYS.cardHolder, rest.join(" ").trim());
        clearStep(SCOPE, ctx.from.id);
        await audit(actor, "settings.card");
        return void ctx.reply(`✅ Karta saqlandi:\n\n<code>${esc(pretty)}</code>`, {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("◀️ To'lov sozlamalari", "pa:payset"),
        });
      }

      case "await_sup_reply": {
        const message = await db.supportMessage.findUnique({ where: { id: state.data.messageId as string } });
        clearStep(SCOPE, ctx.from.id);
        if (!message) return void ctx.reply("Murojaat topilmadi.");
        const owner = await db.owner.findUnique({ where: { id: message.ownerId } });
        if (!owner) return void ctx.reply("Foydalanuvchi topilmadi.");

        const outcome = await sendSafe(() =>
          ctx.api.sendMessage(
            Number(owner.tgUserId),
            `✉️ <b>Administrator javobi</b>\n\n<i>Savolingiz: ${esc(message.text.slice(0, 200))}</i>\n\n${esc(text)}`,
            { parse_mode: "HTML" },
          ),
        );
        await db.supportMessage.update({
          where: { id: message.id },
          data: { answered: true, answer: text, answeredBy: actor },
        });
        await audit(actor, "support.reply", message.id);
        return void ctx.reply(outcome === "sent" ? "✅ Javob yuborildi." : "⚠️ Javob saqlandi, lekin foydalanuvchiga yetmadi.", {
          reply_markup: new InlineKeyboard().text("✉️ Murojaatlar", "pa:sup"),
        });
      }
    }

    return next();
  });
}

import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { runningCount } from "../runtime/registry.js";
import { adminTgIds, audit, isAdmin, isRootAdmin } from "./access.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { isMenuButton } from "./menu.js";
import { templateList } from "../templates/index.js";
import { move } from "../billing/wallet.js";

const SCOPE = "padmin";

function panelKeyboard(pending: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(pending > 0 ? `🧾 To'lovlar (${pending})` : "🧾 To'lovlar", "pa:pay")
    .text("📊 Statistika", "pa:stat")
    .row()
    .text("👑 Adminlar", "pa:admins")
    .text("💳 Karta", "pa:card")
    .row()
    .text("🧩 Shablon narxlari", "pa:tpl")
    .text("💰 Balanslar", "pa:bal")
    .row()
    .text("💎 Premium", "pa:prem")
    .row()
    .text("🤖 Botlar", "pa:bots");
}

async function showPanel(ctx: Context, edit = false) {
  const pending = await db.payment.count({ where: { status: "pending" } });
  const text = `🛠 <b>Platforma boshqaruvi</b>\n\nKerakli bo'limni tanlang.`;
  const kb = panelKeyboard(pending);
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

const back = new InlineKeyboard().text("◀️ Orqaga", "pa:menu");

export function registerPlatformAdmin(bot: Bot) {
  const guard = async (ctx: Context): Promise<boolean> => {
    const ok = await isAdmin(BigInt(ctx.from!.id));
    if (!ok && ctx.callbackQuery) await ctx.answerCallbackQuery("Ruxsat yo'q");
    return ok;
  };

  bot.command("panel", async (ctx) => {
    if (!(await isAdmin(BigInt(ctx.from!.id)))) return;
    clearStep(SCOPE, ctx.from!.id);
    await showPanel(ctx);
  });

  bot.callbackQuery("pa:menu", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
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
      take: 10,
    });

    if (pending.length === 0) {
      return void ctx.editMessageText("🧾 Kutilayotgan to'lov yo'q.", { reply_markup: back });
    }

    const kb = new InlineKeyboard();
    for (const p of pending) {
      kb.text(`${p.reference} · ${money(p.amountUzs)} · ${p.owner.fullName.slice(0, 15)}`, `pa:payv:${p.id}`).row();
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
    setStep(SCOPE, ctx.from!.id, "await_admin_add");
    await ctx.editMessageText(
      `➕ <b>Admin qo'shish</b>\n\nYangi adminning <b>Telegram ID</b> raqamini yuboring.\n\n` +
        `<i>ID ni @userinfobot beradi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("pa:admindel", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_admin_del");
    await ctx.editMessageText(
      `➖ <b>Adminlikdan olish</b>\n\nTelegram ID raqamini yuboring.\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
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
          .text("◀️ Orqaga", "pa:menu"),
      },
    );
  });

  bot.callbackQuery("pa:cardedit", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_card");
    await ctx.editMessageText(
      `✏️ <b>Karta o'zgartirish</b>\n\nQuyidagi ko'rinishda yuboring:\n\n` +
        `<code>8600 1234 5678 9012\nISKANDAROV NODIRBEK</code>\n\n` +
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
        `💰 <b>Shu oy daromad: ${money(paidThisMonth._sum.amountUzs ?? 0)}</b>\n` +
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

    await ctx.editMessageText(
      `🤖 <b>Botlar: ${bots.length}</b>\n\n${lines.join("\n") || "Hali yo'q."}`,
      { parse_mode: "HTML", reply_markup: back },
    );
  });

  // ---------------------------------------------------------------- premium

  bot.callbackQuery("pa:prem", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const members = await db.owner.findMany({ where: { isPremium: true }, take: 20 });
    const lines = members.map(
      (o) => `• ${esc(o.fullName)} — <code>${o.tgUserId}</code>` +
        (o.premiumUntil ? ` (${o.premiumUntil.toLocaleDateString("uz-UZ")})` : ""),
    );
    await ctx.editMessageText(
      `💎 <b>Premium a'zolar: ${members.length}</b>\n\n` +
        (lines.join("\n") || "<i>Hali yo'q.</i>") +
        `\n\n<b>Premium nima beradi:</b>\n` +
        `• Barcha tariflarga <b>−10%</b> chegirma\n` +
        `• To'lovlari navbatsiz ko'riladi\n` +
        `• Ilovada 💎 belgisi`,
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
    setStep(SCOPE, ctx.from!.id, ctx.match[1] === "add" ? "await_prem_add" : "await_prem_del");
    await ctx.editMessageText(
      `💎 <b>Premium</b>\n\nFoydalanuvchining <b>Telegram ID</b> raqamini yuboring.\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // ------------------------------------------------- template price control

  bot.callbackQuery("pa:tpl", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const prices = await db.templatePrice.findMany({ orderBy: { sortOrder: "asc" } });
    const byKey = new Map(prices.map((p) => [p.key, p]));

    const kb = new InlineKeyboard();
    for (const t of templateList) {
      const p = byKey.get(t.key);
      const state = !p?.isEnabled ? "🚫" : p.isForSale && p.priceUzs > 0 ? `🔒 ${p.priceUzs / 1000}k` : "🆓";
      kb.text(`${state} ${t.emoji} ${t.name}`, `pa:tplv:${t.key}`).row();
    }
    kb.text("◀️ Orqaga", "pa:menu");

    await ctx.editMessageText(
      `🧩 <b>Shablon narxlari</b>\n\n` +
        `🆓 — har qanday tarifga kiradi\n` +
        `🔒 — alohida sotiladi (bir martalik to'lov)\n` +
        `🚫 — ro'yxatda ko'rinmaydi\n\n` +
        `O'zgartirish uchun shablonni bosing.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^pa:tplv:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    const key = ctx.match[1]!;
    const t = templateList.find((x) => x.key === key);
    const p = await db.templatePrice.findUnique({ where: { key } });
    if (!t || !p) return;

    const sold = await db.ownerTemplate.count({ where: { templateKey: key } });
    const built = await db.bot.count({ where: { templateKey: key } });

    await ctx.editMessageText(
      `${t.emoji} <b>${esc(t.name)}</b>\n\n` +
        `Holat: ${p.isEnabled ? "✅ ko'rinadi" : "🚫 yashirilgan"}\n` +
        `Sotuv: ${p.isForSale && p.priceUzs > 0 ? `🔒 ${money(p.priceUzs)}` : "🆓 bepul (tarifga kiradi)"}\n\n` +
        `📊 Sotib olganlar: <b>${sold}</b>\n🤖 Yaratilgan botlar: <b>${built}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💵 Narx belgilash", `pa:tplp:${key}`)
          .row()
          .text(p.isForSale ? "🆓 Bepul qilish" : "🔒 Pullik qilish", `pa:tpls:${key}`)
          .row()
          .text(p.isEnabled ? "🚫 Yashirish" : "✅ Ko'rsatish", `pa:tple:${key}`)
          .row()
          .text("◀️ Orqaga", "pa:tpl"),
      },
    );
  });

  bot.callbackQuery(/^pa:tpls:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const key = ctx.match[1]!;
    const p = await db.templatePrice.findUniqueOrThrow({ where: { key } });
    await db.templatePrice.update({ where: { key }, data: { isForSale: !p.isForSale } });
    await audit(BigInt(ctx.from.id), "template.forsale", key, { isForSale: !p.isForSale });
    await ctx.answerCallbackQuery("O'zgartirildi");
    await ctx.editMessageText("Yangilandi.", {
      reply_markup: new InlineKeyboard().text("◀️ Ko'rish", `pa:tplv:${key}`),
    });
  });

  bot.callbackQuery(/^pa:tple:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    const key = ctx.match[1]!;
    const p = await db.templatePrice.findUniqueOrThrow({ where: { key } });
    await db.templatePrice.update({ where: { key }, data: { isEnabled: !p.isEnabled } });
    await audit(BigInt(ctx.from.id), "template.enabled", key, { isEnabled: !p.isEnabled });
    await ctx.answerCallbackQuery("O'zgartirildi");
    await ctx.editMessageText("Yangilandi.", {
      reply_markup: new InlineKeyboard().text("◀️ Ko'rish", `pa:tplv:${key}`),
    });
  });

  bot.callbackQuery(/^pa:tplp:(.+)$/, async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_tpl_price", { key: ctx.match[1] });
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
    const top = await db.owner.findMany({
      where: { balanceUzs: { gt: 0 } },
      orderBy: { balanceUzs: "desc" },
      take: 10,
    });
    const total = await db.owner.aggregate({ _sum: { balanceUzs: true } });
    const lines = top.map((o) => `• ${esc(o.fullName)} — <b>${money(o.balanceUzs)}</b>\n     <code>${o.tgUserId}</code>`);

    await ctx.editMessageText(
      `💰 <b>Foydalanuvchi balanslari</b>\n\n` +
        `Jami majburiyat: <b>${money(total._sum.balanceUzs ?? 0)}</b>\n` +
        `<i>Bu — foydalanuvchilar to'lagan, lekin hali sarflanmagan pul.</i>\n\n` +
        (lines.join("\n") || "Hech kimda balans yo'q."),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Balans qo'shish", "pa:baladd")
          .row()
          .text("◀️ Orqaga", "pa:menu"),
      },
    );
  });

  bot.callbackQuery("pa:baladd", async (ctx) => {
    if (!(await guard(ctx))) return;
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_bal_add");
    await ctx.editMessageText(
      `➕ <b>Qo'lda balans qo'shish</b>\n\nQuyidagi ko'rinishda yuboring:\n\n` +
        `<code>123456789 50000</code>\n\n` +
        `<i>Telegram ID, bo'sh joy, summa. Manfiy summa yechib oladi.</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // --------------------------------------------------------- text handler

  /** Returns true when the message was consumed by an admin wizard. */
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text?.trim();
    if (!text || text.startsWith("/") || !ctx.from || isMenuButton(text)) return next();

    const state = getStep(SCOPE, ctx.from.id);
    if (!state) return next();
    if (!(await isAdmin(BigInt(ctx.from.id)))) return next();

    const actor = BigInt(ctx.from.id);

    if (state.step === "await_admin_add") {
      const id = text.replace(/\D/g, "");
      if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
      const tgId = BigInt(id);

      const owner = await db.owner.upsert({
        where: { tgUserId: tgId },
        create: { tgUserId: tgId, fullName: `Admin ${id}`, isPlatformAdmin: true, adminAddedBy: actor, adminAddedAt: new Date() },
        update: { isPlatformAdmin: true, adminAddedBy: actor, adminAddedAt: new Date() },
      });
      clearStep(SCOPE, ctx.from.id);
      await audit(actor, "admin.add", id);
      await ctx.reply(`✅ <code>${id}</code> admin qilindi.\n\nEndi u ham /panel dan foydalana oladi va yangi admin qo'sha oladi.`, {
        parse_mode: "HTML",
      });

      await ctx.api
        .sendMessage(
          Number(tgId),
          `👑 Sizga <b>platforma administratori</b> huquqi berildi.\n\n/panel — boshqaruv paneli`,
          { parse_mode: "HTML" },
        )
        .catch(() => {
          void ctx.reply("<i>Eslatma: u hali botga /start bosmagan, shuning uchun xabar yetmadi.</i>", {
            parse_mode: "HTML",
          });
        });
      void owner;
      return;
    }

    if (state.step === "await_admin_del") {
      const id = text.replace(/\D/g, "");
      if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
      const tgId = BigInt(id);

      if (isRootAdmin(tgId)) {
        return void ctx.reply("❌ Asosiy adminni (.env dagi) bot orqali olib bo'lmaydi.");
      }
      await db.owner.updateMany({ where: { tgUserId: tgId }, data: { isPlatformAdmin: false } });
      clearStep(SCOPE, ctx.from.id);
      await audit(actor, "admin.remove", id);
      return void ctx.reply(`✅ <code>${id}</code> adminlikdan olindi.`, { parse_mode: "HTML" });
    }

    if (state.step === "await_prem_add" || state.step === "await_prem_del") {
      const grant = state.step === "await_prem_add";
      const id = text.replace(/\D/g, "");
      if (!id) return void ctx.reply("ID faqat raqamlardan iborat bo'lishi kerak.");
      const target = await db.owner.findUnique({ where: { tgUserId: BigInt(id) } });
      if (!target) return void ctx.reply("Foydalanuvchi topilmadi (u botga /start bosganmi?).");

      await db.owner.update({
        where: { id: target.id },
        data: {
          isPremium: grant,
          premiumUntil: grant ? new Date(Date.now() + 365 * 24 * 3600 * 1000) : null,
        },
      });
      clearStep(SCOPE, ctx.from.id);
      await audit(actor, grant ? "premium.grant" : "premium.revoke", id);
      await ctx.reply(grant ? `💎 ${esc(target.fullName)} — premium berildi.` : `Premium bekor qilindi.`, {
        parse_mode: "HTML",
      });
      if (grant) {
        await ctx.api
          .sendMessage(
            Number(target.tgUserId),
            `💎 <b>Sizga Premium berildi!</b>\n\n` +
              `• Barcha tariflarga <b>−10%</b> chegirma\n` +
              `• To'lovlaringiz navbatsiz ko'riladi\n\n` +
              `Chegirma keyingi to'lovingizda avtomatik qo'llanadi.`,
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }
      return;
    }

    if (state.step === "await_tpl_price") {
      const key = state.data.key as string;
      const price = Number(text.replace(/\D/g, ""));
      if (Number.isNaN(price)) return void ctx.reply("Faqat raqam yuboring.");
      await db.templatePrice.update({
        where: { key },
        data: { priceUzs: price, isForSale: price > 0 },
      });
      clearStep(SCOPE, ctx.from.id);
      await audit(actor, "template.price", key, { priceUzs: price });
      return void ctx.reply(
        price > 0 ? `✅ Narx belgilandi: <b>${money(price)}</b>` : "✅ Shablon bepul qilindi.",
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Shablonlar", "pa:tpl") },
      );
    }

    if (state.step === "await_bal_add") {
      const parts = text.split(/\s+/);
      const tgId = parts[0]?.replace(/\D/g, "");
      const amount = Number(parts[1]?.replace(/[^\d-]/g, ""));
      if (!tgId || !amount) return void ctx.reply("Format: <code>123456789 50000</code>", { parse_mode: "HTML" });

      const target = await db.owner.findUnique({ where: { tgUserId: BigInt(tgId) } });
      if (!target) return void ctx.reply("Bunday foydalanuvchi topilmadi (u botga /start bosganmi?).");

      const left = await move(target.id, amount, amount > 0 ? "bonus" : "refund", {
        note: `Admin ${ctx.from.id}`,
      });
      clearStep(SCOPE, ctx.from.id);
      await audit(actor, "balance.manual", tgId, { amount });
      await ctx.reply(
        `✅ ${esc(target.fullName)} balansi: <b>${money(left)}</b> (${amount > 0 ? "+" : ""}${money(amount)})`,
        { parse_mode: "HTML" },
      );
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

    if (state.step === "await_card") {
      const [card, ...rest] = text.split("\n");
      const digits = (card ?? "").replace(/\D/g, "");
      if (digits.length < 12) return void ctx.reply("Karta raqami noto'g'ri. Kamida 12 ta raqam bo'lishi kerak.");

      const pretty = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
      await setSetting(SETTING_KEYS.cardNumber, pretty);
      if (rest.length > 0) await setSetting(SETTING_KEYS.cardHolder, rest.join(" ").trim());

      clearStep(SCOPE, ctx.from.id);
      await audit(actor, "settings.card");
      return void ctx.reply(`✅ Karta saqlandi:\n\n<code>${esc(pretty)}</code>`, { parse_mode: "HTML" });
    }

    return next();
  });
}

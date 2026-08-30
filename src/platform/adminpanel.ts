import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { runningCount } from "../runtime/registry.js";
import { adminTgIds, audit, isAdmin, isRootAdmin } from "./access.js";
import { SETTING_KEYS, getSetting, setSetting } from "./settings.js";
import { isMenuButton } from "./menu.js";

const SCOPE = "padmin";

function panelKeyboard(pending: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(pending > 0 ? `🧾 To'lovlar (${pending})` : "🧾 To'lovlar", "pa:pay")
    .text("📊 Statistika", "pa:stat")
    .row()
    .text("👑 Adminlar", "pa:admins")
    .text("💳 Karta", "pa:card")
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
      `📦 ${esc(payment.plan.name)} — <b>${money(payment.amountUzs)}</b>` +
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

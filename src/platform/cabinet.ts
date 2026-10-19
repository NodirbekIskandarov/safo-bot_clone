import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { config } from "../config.js";
import { db } from "../db.js";
import { KIND_LABEL, move } from "../billing/wallet.js";
import { premiumActive } from "../billing/subscription.js";
import { clearStep, getStep, resetStep } from "../lib/state.js";
import { withEffect } from "../lib/effects.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { adminTgIds } from "./access.js";

const SCOPE = "platform";

/** Share of a referral's first top-up paid to whoever invited them. */
export const REFERRAL_SHARE = 0.1;

async function ownerRow(ctx: Context) {
  return db.owner.findUnique({ where: { tgUserId: BigInt(ctx.from!.id) } });
}

export async function showCabinet(ctx: Context, edit = false) {
  const owner = await ownerRow(ctx);
  if (!owner) return void ctx.reply("Avval /start bosing.");

  const [bots, referrals, topups] = await Promise.all([
    db.bot.count({ where: { ownerId: owner.id } }),
    db.owner.count({ where: { referredBy: owner.id } }),
    db.balanceTx.aggregate({ where: { ownerId: owner.id, kind: "topup" }, _sum: { amountUzs: true } }),
  ]);

  const text =
    `📱 <b>Shaxsiy kabinet</b>\n\n` +
    `<b>ID:</b> <code>${owner.tgUserId}</code>\n` +
    `├ 💰 <b>Balansingiz:</b> ${money(owner.balanceUzs)}\n` +
    `├ 👥 <b>Referallaringiz:</b> ${referrals} ta\n` +
    `├ 🤖 <b>Botlaringiz:</b> ${bots} ta\n` +
    `└ 💵 <b>Kiritgan pullaringiz:</b> ${money(topups._sum.amountUzs ?? 0)}\n` +
    (premiumActive(owner)
      ? `\n💎 <b>Premium a'zo</b> — barcha tariflarga −10%` +
        (owner.premiumUntil ? ` (${owner.premiumUntil.toLocaleDateString("uz-UZ")} gacha)` : "")
      : "");

  const kb = new InlineKeyboard()
    .text("📊 Balans harakati", "cb:hist")
    .row()
    .text("💳 Hisob to'ldirish", "w:top")
    .text("💼 Daromad", "cb:income");
  if (config.WEB_APP_URL) kb.row().webApp("🌐 Saytda ochish", config.WEB_APP_URL);

  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

/**
 * Money the owner's bots brought in. Subscription sales and shop orders are
 * paid straight to the owner's card, so this is a report, not a balance.
 */
export async function showIncome(ctx: Context, edit = false) {
  const owner = await ownerRow(ctx);
  if (!owner) return void ctx.reply("Avval /start bosing.");

  const bots = await db.bot.findMany({ where: { ownerId: owner.id }, select: { id: true } });
  const ids = bots.map((b) => b.id);
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const paidStatuses = ["confirmed", "delivering", "done"];

  const [subsAll, subsMonth, ordersAll, ordersMonth, refAll, refMonth] = await Promise.all([
    db.botPayment.aggregate({ where: { botId: { in: ids }, status: "approved" }, _sum: { amountUzs: true }, _count: true }),
    db.botPayment.aggregate({
      where: { botId: { in: ids }, status: "approved", reviewedAt: { gte: monthStart } },
      _sum: { amountUzs: true },
    }),
    db.order.aggregate({ where: { botId: { in: ids }, status: { in: paidStatuses } }, _sum: { totalUzs: true }, _count: true }),
    db.order.aggregate({
      where: { botId: { in: ids }, status: { in: paidStatuses }, createdAt: { gte: monthStart } },
      _sum: { totalUzs: true },
    }),
    db.balanceTx.aggregate({ where: { ownerId: owner.id, kind: "bonus" }, _sum: { amountUzs: true } }),
    db.balanceTx.aggregate({
      where: { ownerId: owner.id, kind: "bonus", createdAt: { gte: monthStart } },
      _sum: { amountUzs: true },
    }),
  ]);

  const total =
    (subsAll._sum.amountUzs ?? 0) + (ordersAll._sum.totalUzs ?? 0) + (refAll._sum.amountUzs ?? 0);

  const text =
    `💼 <b>Daromad</b>\n\n` +
    `Botlaringiz orqali tushgan pul:\n\n` +
    `💎 <b>Obuna sotuvi</b>\n   Jami: <b>${money(subsAll._sum.amountUzs ?? 0)}</b> (${subsAll._count} ta to'lov)\n` +
    `   Shu oy: ${money(subsMonth._sum.amountUzs ?? 0)}\n\n` +
    `🛒 <b>Do'kon savdosi</b>\n   Jami: <b>${money(ordersAll._sum.totalUzs ?? 0)}</b> (${ordersAll._count} ta buyurtma)\n` +
    `   Shu oy: ${money(ordersMonth._sum.totalUzs ?? 0)}\n\n` +
    `🗣 <b>Referal bonuslari</b>\n   Jami: <b>${money(refAll._sum.amountUzs ?? 0)}</b>\n` +
    `   Shu oy: ${money(refMonth._sum.amountUzs ?? 0)}\n\n` +
    `━━━━━━━━━━━━━━\n<b>Umumiy: ${money(total)}</b>\n\n` +
    `<i>Obuna va do'kon puli to'g'ridan-to'g'ri sizning kartangizga tushadi, platforma komissiya olmaydi. ` +
    `Referal bonuslari balansingizga qo'shiladi.</i>`;

  const kb = new InlineKeyboard().text("🗣 Referal", "cb:ref").text("📱 Kabinet", "cb:home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showReferral(ctx: Context, botUsername: string) {
  const owner = await ownerRow(ctx);
  if (!owner) return void ctx.reply("Avval /start bosing.");
  const link = `https://t.me/${botUsername}?start=ref_${owner.tgUserId}`;

  const [count, earned] = await Promise.all([
    db.owner.count({ where: { referredBy: owner.id } }),
    db.balanceTx.aggregate({ where: { ownerId: owner.id, kind: "bonus" }, _sum: { amountUzs: true } }),
  ]);

  await ctx.reply(
    `🗣 <b>Referal dasturi</b>\n\n` +
      `Do'stingiz sizning havolangiz orqali kelib hisobini to'ldirsa — ` +
      `uning <b>birinchi to'lovidan ${Math.round(REFERRAL_SHARE * 100)}%</b> sizning balansingizga tushadi.\n\n` +
      `👥 Taklif qilganlaringiz: <b>${count}</b>\n` +
      `💰 Ishlab topganingiz: <b>${money(earned._sum.amountUzs ?? 0)}</b>\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `<b>Sizning havolangiz:</b>\n<code>${link}</code>\n\n` +
      `<i>Havolani bosib nusxalang va do'stlaringizga yuboring.</i>`,
    {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().url(
        "📤 Do'stlarga yuborish",
        `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(
          "Telegram bot yaratish platformasi — kod yozmasdan, 5 daqiqada",
        )}`,
      ),
    },
  );
}

/** Credit the inviter when a referral's first top-up lands. */
export async function payReferralBonus(ownerId: string, topupUzs: number): Promise<void> {
  const owner = await db.owner.findUnique({ where: { id: ownerId } });
  if (!owner?.referredBy || owner.refBonusPaid) return;

  const bonus = Math.round((topupUzs * REFERRAL_SHARE) / 1000) * 1000;
  if (bonus <= 0) return;

  // Flag first, conditionally: a second approval racing this one pays nothing.
  const flagged = await db.owner.updateMany({ where: { id: ownerId, refBonusPaid: false }, data: { refBonusPaid: true } });
  if (flagged.count === 0) return;
  await move(owner.referredBy, bonus, "bonus", { note: `Referal: ${owner.fullName}`, refId: ownerId });
  log.info("referral bonus paid", { to: owner.referredBy, bonus });
}

export function registerCabinet(bot: Bot, botUsername: string) {
  bot.command("kabinet", (ctx) => showCabinet(ctx));
  bot.command("referal", (ctx) => showReferral(ctx, botUsername));

  bot.callbackQuery("cb:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx, true);
  });

  bot.callbackQuery("cb:income", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showIncome(ctx, true);
  });

  bot.callbackQuery("cb:ref", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showReferral(ctx, botUsername);
  });

  bot.callbackQuery("cb:hist", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerRow(ctx);
    if (!owner) return;
    const txs = await db.balanceTx.findMany({ where: { ownerId: owner.id }, orderBy: { createdAt: "desc" }, take: 20 });

    const lines = txs.map((t) => {
      const when = t.createdAt.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" });
      const sign = t.amountUzs > 0 ? "+" : "−";
      return `${when} · ${KIND_LABEL[t.kind] ?? t.kind}\n     <b>${sign}${money(Math.abs(t.amountUzs))}</b> → ${money(t.balanceAfter)}`;
    });

    await ctx.editMessageText(`📊 <b>Balans harakati</b>\n\n${lines.join("\n") || "<i>Hali amallar yo'q.</i>"}`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("◀️ Kabinet", "cb:home"),
    });
  });

  bot.callbackQuery("cb:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_support");
    await ctx.editMessageText("✉️ Murojaatingizni yozing:\n\nBekor: /bekor");
  });
}

export async function askSupport(ctx: Context) {
  resetStep(SCOPE, ctx.from!.id, "await_support");
  await ctx.reply(
    `✉️ <b>Murojaat</b>\n\nSavolingiz, taklifingiz yoki muammoingizni yozing — ` +
      `administratorga yetkazamiz va shu yerda javob beramiz.\n\nBekor: /bekor`,
    { parse_mode: "HTML" },
  );
}

/** Handles the pending support message, if any. Returns true when consumed. */
export async function takeSupportMessage(ctx: Context, text: string): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (state?.step !== "await_support") return false;

  const owner = await ownerRow(ctx);
  if (!owner) return false;
  const message = await db.supportMessage.create({ data: { ownerId: owner.id, text } });
  clearStep(SCOPE, ctx.from!.id);

  await ctx.reply("✅ Murojaatingiz yuborildi. Javob shu chatga keladi.", withEffect("thumbsUp"));

  const body =
    `✉️ <b>Yangi murojaat</b>\n\n` +
    `👤 ${esc(owner.fullName)}${owner.username ? ` (@${esc(owner.username)})` : ""}\n` +
    `🆔 <code>${owner.tgUserId}</code>\n\n` +
    `${esc(text)}`;

  for (const adminId of await adminTgIds()) {
    await sendSafe(() =>
      ctx.api.sendMessage(Number(adminId), body, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✍️ Javob berish", `sup:pl:${message.id}`),
      }),
    );
  }
  return true;
}

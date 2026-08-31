import { InlineKeyboard } from "grammy";
import type { Bot, Context } from "grammy";
import { config } from "../config.js";
import { db } from "../db.js";
import { move } from "../billing/wallet.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { withEffect } from "../lib/effects.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { adminTgIds } from "./access.js";

const SCOPE = "platform";

/** Share of a referral's first top-up paid to whoever invited them. */
export const REFERRAL_SHARE = 0.1;

async function ownerRow(ctx: Context) {
  return db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
}

export async function showCabinet(ctx: Context, edit = false) {
  const owner = await ownerRow(ctx);

  const [bots, referrals, topups] = await Promise.all([
    db.bot.count({ where: { ownerId: owner.id } }),
    db.owner.count({ where: { referredBy: owner.id } }),
    db.balanceTx.aggregate({
      where: { ownerId: owner.id, kind: "topup" },
      _sum: { amountUzs: true },
    }),
  ]);

  const text =
    `🪪 <b>Shaxsiy kabinet</b>\n\n` +
    `<b>ID:</b> <code>${owner.tgUserId}</code>\n` +
    `├ 💰 <b>Balansingiz:</b> ${money(owner.balanceUzs)}\n` +
    `├ 👥 <b>Referallaringiz:</b> ${referrals} ta\n` +
    `├ 🤖 <b>Botlaringiz:</b> ${bots} ta\n` +
    `└ 💵 <b>Kiritgan pullaringiz:</b> ${money(topups._sum.amountUzs ?? 0)}\n` +
    (owner.isPremium ? `\n💎 <b>Premium a'zo</b> — barcha tariflarga −10%` : "");

  const kb = new InlineKeyboard()
    .text("📊 Balans harakati", "cb:hist")
    .row()
    .text("💵 Hisob to'ldirish", "w:top");
  if (config.WEB_APP_URL) kb.row().webApp("📱 Ilovada ochish", config.WEB_APP_URL);

  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export async function showReferral(ctx: Context, botUsername: string) {
  const owner = await ownerRow(ctx);
  const link = `https://t.me/${botUsername}?start=ref_${owner.tgUserId}`;

  const [count, earned] = await Promise.all([
    db.owner.count({ where: { referredBy: owner.id } }),
    db.balanceTx.aggregate({
      where: { ownerId: owner.id, kind: "bonus" },
      _sum: { amountUzs: true },
    }),
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

  await db.owner.update({ where: { id: ownerId }, data: { refBonusPaid: true } });
  await move(owner.referredBy, bonus, "bonus", {
    note: `Referal: ${owner.fullName}`,
    refId: ownerId,
  });
  log.info("referral bonus paid", { to: owner.referredBy, bonus });
}

export function registerCabinet(bot: Bot, botUsername: string) {
  bot.hears("🪪 Shaxsiy kabinet", (ctx) => showCabinet(ctx));
  bot.hears("🗣 Referal", (ctx) => showReferral(ctx, botUsername));
  bot.command("kabinet", (ctx) => showCabinet(ctx));
  bot.command("referal", (ctx) => showReferral(ctx, botUsername));

  bot.callbackQuery("cb:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCabinet(ctx, true);
  });

  bot.callbackQuery("cb:hist", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerRow(ctx);
    const txs = await db.balanceTx.findMany({
      where: { ownerId: owner.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    const label: Record<string, string> = {
      topup: "💰 To'ldirish", subscription: "📦 Obuna", template: "🧩 Shablon",
      refund: "↩️ Qaytarish", bonus: "🎁 Bonus",
    };
    const lines = txs.map((t) => {
      const when = t.createdAt.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" });
      const sign = t.amountUzs > 0 ? "+" : "−";
      return `${when} · ${label[t.kind] ?? t.kind}\n     <b>${sign}${money(Math.abs(t.amountUzs))}</b> → ${money(t.balanceAfter)}`;
    });

    await ctx.editMessageText(
      `📊 <b>Balans harakati</b>\n\n${lines.join("\n") || "<i>Hali amallar yo'q.</i>"}`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Kabinet", "cb:home") },
    );
  });

  // ---------------------------------------------------------------- support

  bot.hears("✉️ Murojaat", async (ctx) => {
    setStep(SCOPE, ctx.from!.id, "await_support");
    await ctx.reply(
      `✉️ <b>Murojaat</b>\n\nSavolingiz, taklifingiz yoki muammoingizni yozing — ` +
        `administratorga yetkazamiz va javob beramiz.\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("cb:support", async (ctx) => {
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_support");
    await ctx.editMessageText("✉️ Murojaatingizni yozing:\n\nBekor: /bekor");
  });
}

/** Handles the pending support message, if any. Returns true when consumed. */
export async function takeSupportMessage(ctx: Context, text: string): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (state?.step !== "await_support") return false;

  const owner = await ownerRow(ctx);
  await db.supportMessage.create({ data: { ownerId: owner.id, text } });
  clearStep(SCOPE, ctx.from!.id);

  await ctx.reply("✅ Murojaatingiz yuborildi. Tez orada javob beramiz.", withEffect("thumbsUp"));

  const body =
    `✉️ <b>Yangi murojaat</b>\n\n` +
    `👤 ${esc(owner.fullName)}${owner.username ? ` (@${esc(owner.username)})` : ""}\n` +
    `🆔 <code>${owner.tgUserId}</code>\n\n` +
    `${esc(text)}`;

  for (const adminId of await adminTgIds()) {
    await sendSafe(() =>
      ctx.api.sendMessage(Number(adminId), body, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("✍️ Javob berish", `sup:pl:${owner.tgUserId}`),
      }),
    );
  }
  return true;
}

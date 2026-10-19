import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import { db } from "../db.js";
import { activate, premiumActive } from "../billing/subscription.js";
import { payablePlans } from "../billing/plans.js";
import { InsufficientFunds, KIND_LABEL, charge, history } from "../billing/wallet.js";
import { clearStep, getStep, resetStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { withEffect } from "../lib/effects.js";
import { log } from "../lib/log.js";
import { reloadBot, startBot } from "../runtime/registry.js";
import { paymentReference } from "./access.js";
import { paymentDetails } from "./settings.js";
import { termPrice } from "./menu.js";
import { notifyAdmins } from "./payments.js";

const SCOPE = "platform";
const TOPUP_PRESETS = [50_000, 100_000, 200_000, 500_000];
export const MIN_TOPUP = 5_000;
/**
 * Upper bound for one top-up. Without it a typed 900 000 000 000 000 was
 * stored, overflowed the INT column, and broke the admin payments list.
 */
export const MAX_TOPUP = 50_000_000;

export async function showWallet(ctx: Context, edit = false) {
  const owner = await db.owner.findUnique({ where: { tgUserId: BigInt(ctx.from!.id) } });
  if (!owner) return void ctx.reply("Avval /start bosing.");
  const txs = await history(owner.id, 8);

  const lines = txs.map((t) => {
    const sign = t.amountUzs > 0 ? "+" : "−";
    const date = t.createdAt.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" });
    return `${date}  ${KIND_LABEL[t.kind] ?? t.kind}  <b>${sign}${money(Math.abs(t.amountUzs))}</b>`;
  });

  const text =
    `💳 <b>Balans</b>\n\n` +
    `Hozirgi mablag': <b>${money(owner.balanceUzs)}</b>\n\n` +
    `Balansni oldindan to'ldirib qo'yasiz, keyin tarif va shablonlarni <b>bir bosishda</b> ` +
    `sotib olasiz. Avto uzaytirish ham shu balansdan ishlaydi — pul bo'lsa bot to'xtamaydi.\n\n` +
    (lines.length > 0 ? `━━━━━━━━━━━━━━\n\n<b>Oxirgi amallar</b>\n${lines.join("\n")}` : `<i>Hali amallar yo'q.</i>`);

  const kb = new InlineKeyboard()
    .text("➕ Balansni to'ldirish", "w:top")
    .row()
    .text("📊 Balans harakati", "cb:hist")
    .row()
    .text("◀️ Kabinet", "cb:home");
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

async function showTopupMenu(ctx: Context) {
  const kb = new InlineKeyboard();
  TOPUP_PRESETS.forEach((amount, i) => {
    kb.text(money(amount), `w:amt:${amount}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("✏️ Boshqa summa", "w:custom").row().text("◀️ Balans", "w:home");

  const text =
    `➕ <b>Balansni to'ldirish</b>\n\nQancha to'ldirasiz?\n\n` +
    `<i>To'ldirilgan mablag' yonmaydi — istagan vaqt ishlatasiz.</i>`;
  if (ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export function registerWallet(bot: Bot) {
  bot.callbackQuery("w:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showWallet(ctx, true);
  });

  bot.callbackQuery("w:top", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTopupMenu(ctx);
  });

  bot.callbackQuery("w:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    resetStep(SCOPE, ctx.from!.id, "await_topup_amount");
    await ctx.editMessageText(
      `✏️ <b>Summa</b>\n\nQancha to'ldirmoqchisiz? Faqat raqam yuboring.\n\n` +
        `<i>Masalan: 150000</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery(/^w:amt:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const amount = Number(ctx.match[1]);
    if (amount < MIN_TOPUP || amount > MAX_TOPUP) return;
    await showTopupInvoice(ctx, amount);
  });
}

export { showTopupMenu };

export async function showTopupInvoice(ctx: Context, amountUzs: number) {
  const details = await paymentDetails();
  if (!details.card) {
    const text = "⚠️ To'lov kartasi sozlanmagan. Administratorga murojaat qiling.";
    return void (ctx.callbackQuery
      ? ctx.editMessageText(text, { reply_markup: new InlineKeyboard().text("◀️ Orqaga", "w:home") }).catch(() => {})
      : ctx.reply(text));
  }

  // Fresh state: a top-up must never inherit a subscription invoice's fields.
  resetStep(SCOPE, ctx.from!.id, "await_receipt", { topupAmount: amountUzs });

  const body =
    `➕ <b>Balansni to'ldirish</b>\n\n` +
    `Summa: <b>${money(amountUzs)}</b>\n\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `<code>${esc(details.card)}</code>\n` +
    (details.holder ? `<i>${esc(details.holder)}</i>\n` : "") +
    `\n━━━━━━━━━━━━━━\n\n` +
    `Summani <b>aynan</b> shu miqdorda o'tkazing, so'ng <b>chek skrinshotini</b> shu yerga tashlang.\n\n` +
    `Bekor: /bekor`;

  const kb = new InlineKeyboard().text("◀️ Boshqa summa", "w:top");
  if (ctx.callbackQuery) {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  } else {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

/** Receipt for a top-up: same review queue as everything else. */
export async function submitTopup(ctx: Context, api: Api, fileId: string | undefined, text?: string) {
  const state = getStep(SCOPE, ctx.from!.id);
  const amount = state?.step === "await_receipt" ? (state.data.topupAmount as number | undefined) : undefined;
  if (!amount) return false;

  const owner = await db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const payment = await db.payment.create({
    data: {
      reference: paymentReference(),
      ownerId: owner.id,
      amountUzs: amount,
      kind: "topup",
      receiptFileId: fileId ?? null,
      receiptText: text ?? null,
    },
  });
  clearStep(SCOPE, ctx.from!.id);

  await ctx.reply(
    `✅ <b>Chek qabul qilindi</b>\n\nRaqam: <code>${payment.reference}</code>\n` +
      `Summa: ${money(amount)}\n\nAdmin tasdiqlagach balansingizga tushadi.`,
    { parse_mode: "HTML" },
  );

  const caption =
    `💰 <b>Balans to'ldirish</b> <code>${payment.reference}</code>` + (premiumActive(owner) ? " 💎" : "") + `\n\n` +
    `👤 ${esc(owner.fullName)}${owner.username ? ` (@${esc(owner.username)})` : ""}\n` +
    `🆔 <code>${owner.tgUserId}</code>\n` +
    `💵 <b>${money(amount)}</b>` +
    (text ? `\n\n💬 ${esc(text)}` : "");
  await notifyAdmins(api, payment.id, caption, fileId);
  log.info("topup submitted", { paymentId: payment.id, amount });
  return true;
}

/** Buy a subscription straight from balance — no receipt, no waiting. */
export async function buyFromBalance(ctx: Context, botId: string, planCode: string, months: number): Promise<void> {
  const owner = await db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const record = await db.bot.findFirst({ where: { id: botId, ownerId: owner.id }, include: { subscription: true } });
  if (!record?.subscription) return void ctx.answerCallbackQuery("Bot topilmadi");
  const plan = (await payablePlans(record.templateKey)).find((p) => p.code === planCode);
  if (!plan) return void ctx.answerCallbackQuery("Bu tarif mavjud emas");
  const amount = termPrice(plan.priceUzs, months, premiumActive(owner));
  const subscriptionId = record.subscription.id;

  try {
    // Charge and extend together: money must never leave without the days arriving.
    const left = await db.$transaction(async (tx) => {
      const rest = await charge(owner.id, amount, "subscription", {
        note: `${plan.name} · ${months} oy · @${record.tgUsername}`,
        refId: subscriptionId,
      }, tx);
      await activate(subscriptionId, plan.id, months, tx);
      return rest;
    });

    if (record.status !== "active") {
      const fresh = await db.bot.update({ where: { id: botId }, data: { status: "active", lastError: null } });
      await startBot(fresh).catch((err) => log.error("restart after balance purchase failed", { err }));
    } else {
      await reloadBot(botId);
    }

    await ctx.answerCallbackQuery("To'landi ✅");
    await ctx.editMessageText(
      `🎉 <b>Tarif faollashdi!</b>\n\n` +
        `Bot: @${esc(record.tgUsername)}\n` +
        `Tarif: <b>${esc(plan.name)}</b> · ${months} oy\n` +
        `Yechildi: ${money(amount)}\n` +
        `Qolgan balans: <b>${money(left)}</b>\n\n` +
        `Botingiz ishlayapti. Chek yuborish shart emas edi 🙌`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Botga qaytish", `p:bot:${botId}`) },
    );
    await ctx.reply("🎉", withEffect("party")).catch(() => {});
    log.info("subscription bought from balance", { botId, planCode, months, amount });
  } catch (err) {
    if (err instanceof InsufficientFunds) {
      const short = err.needUzs - err.haveUzs;
      await ctx.answerCallbackQuery({ text: "Balans yetarli emas", show_alert: true });
      await ctx.editMessageText(
        `💰 <b>Balans yetarli emas</b>\n\n` +
          `Kerak: <b>${money(err.needUzs)}</b>\n` +
          `Bor: ${money(err.haveUzs)}\n` +
          `Yetishmayapti: <b>${money(short)}</b>\n\n` +
          `Balansni to'ldiring yoki to'g'ridan-to'g'ri karta orqali to'lang.`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("➕ Balansni to'ldirish", "w:top")
            .row()
            .text("💳 Karta orqali to'lash", `pyc:${botId}:${planCode}:${months}`),
        },
      );
      return;
    }
    throw err;
  }
}

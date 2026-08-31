import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import { db } from "../db.js";
import { activate } from "../billing/subscription.js";
import { InsufficientFunds, charge, history } from "../billing/wallet.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { withEffect } from "../lib/effects.js";
import { log } from "../lib/log.js";
import { reloadBot, startBot } from "../runtime/registry.js";
import { adminTgIds, paymentReference } from "./access.js";
import { paymentDetails } from "./settings.js";
import { termPrice } from "./menu.js";

const SCOPE = "platform";
const TOPUP_PRESETS = [50_000, 100_000, 200_000, 500_000];

const KIND_LABEL: Record<string, string> = {
  topup: "💰 To'ldirish",
  subscription: "📦 Obuna",
  template: "🧩 Shablon",
  refund: "↩️ Qaytarish",
  bonus: "🎁 Bonus",
};

export async function showWallet(ctx: Context, edit = false) {
  const owner = await db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const txs = await history(owner.id, 8);

  const lines = txs.map((t) => {
    const sign = t.amountUzs > 0 ? "+" : "−";
    const date = t.createdAt.toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit" });
    return `${date}  ${KIND_LABEL[t.kind] ?? t.kind}  <b>${sign}${money(Math.abs(t.amountUzs))}</b>`;
  });

  const text =
    `💰 <b>Balans</b>\n\n` +
    `Hozirgi mablag': <b>${money(owner.balanceUzs)}</b>\n\n` +
    `Balansni oldindan to'ldirib qo'yasiz, keyin tarif va shablonlarni <b>bir bosishda</b> ` +
    `sotib olasiz — har safar chek yuborib, tasdiq kutib o'tirmaysiz.\n\n` +
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

export function registerWallet(bot: Bot) {
  bot.hears("💰 Balans", (ctx) => showWallet(ctx));
  bot.callbackQuery("w:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showWallet(ctx, true);
  });

  bot.callbackQuery("w:top", async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    TOPUP_PRESETS.forEach((amount, i) => {
      kb.text(money(amount), `w:amt:${amount}`);
      if (i % 2 === 1) kb.row();
    });
    kb.row().text("✏️ Boshqa summa", "w:custom").row().text("◀️ Orqaga", "w:home");

    await ctx.editMessageText(
      `➕ <b>Balansni to'ldirish</b>\n\nQancha to'ldirasiz?\n\n` +
        `<i>To'ldirilgan mablag' yonmaydi — istagan vaqt ishlatasiz.</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery("w:custom", async (ctx) => {
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_topup_amount");
    await ctx.editMessageText(
      `✏️ <b>Summa</b>\n\nQancha to'ldirmoqchisiz? Faqat raqam yuboring.\n\n` +
        `<i>Masalan: 150000</i>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery(/^w:amt:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTopupInvoice(ctx, Number(ctx.match[1]));
  });
}

export async function showTopupInvoice(ctx: Context, amountUzs: number) {
  const details = await paymentDetails();
  if (!details.card) {
    return void ctx
      .editMessageText("⚠️ To'lov kartasi sozlanmagan. Administratorga murojaat qiling.", {
        reply_markup: new InlineKeyboard().text("◀️ Orqaga", "w:home"),
      })
      .catch(() => {});
  }

  setStep(SCOPE, ctx.from!.id, "await_receipt", { topupAmount: amountUzs });

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
  const amount = state?.data.topupAmount as number | undefined;
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
    `💰 <b>Balans to'ldirish</b> <code>${payment.reference}</code>\n\n` +
    `👤 ${esc(owner.fullName)}${owner.username ? ` (@${esc(owner.username)})` : ""}\n` +
    `🆔 <code>${owner.tgUserId}</code>\n` +
    `💵 <b>${money(amount)}</b>`;
  const kb = new InlineKeyboard()
    .text("✅ Tasdiqlash", `adm:pay:ok:${payment.id}`)
    .text("❌ Rad etish", `adm:pay:no:${payment.id}`);

  for (const adminId of await adminTgIds()) {
    await sendSafe(async () => {
      if (fileId) await api.sendPhoto(Number(adminId), fileId, { caption, parse_mode: "HTML", reply_markup: kb });
      else await api.sendMessage(Number(adminId), caption, { parse_mode: "HTML", reply_markup: kb });
    });
  }
  log.info("topup submitted", { paymentId: payment.id, amount });
  return true;
}

/** Buy a subscription straight from balance — no receipt, no waiting. */
export async function buyFromBalance(
  ctx: Context,
  botId: string,
  planCode: string,
  months: number,
): Promise<void> {
  const owner = await db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const plan = await db.plan.findUniqueOrThrow({ where: { code: planCode } });
  const record = await db.bot.findUniqueOrThrow({ where: { id: botId }, include: { subscription: true } });
  const amount = termPrice(plan.priceUzs, months, owner.isPremium);

  if (!record.subscription) return void ctx.answerCallbackQuery("Obuna topilmadi");

  try {
    const left = await charge(owner.id, amount, "subscription", {
      note: `${plan.name} · ${months} oy · @${record.tgUsername}`,
      refId: record.subscription.id,
    });

    await activate(record.subscription.id, plan.id, months);

    if (record.status !== "active") {
      await db.bot.update({ where: { id: botId }, data: { status: "active", lastError: null } });
      const fresh = await db.bot.findUniqueOrThrow({ where: { id: botId } });
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
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🤖 Botlarim", "p:bots") },
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
            .text("💳 Karta orqali to'lash", `pyd:${botId}:${planCode}:${months}`),
        },
      );
      return;
    }
    throw err;
  }
}

import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import { activate } from "../billing/subscription.js";
import { payablePlans } from "../billing/plans.js";
import { db } from "../db.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { reloadBot, startBot } from "../runtime/registry.js";
import { adminTgIds, audit, isAdmin, paymentReference } from "./access.js";
import { paymentDetails } from "./settings.js";
import { TERMS, termPrice } from "./menu.js";

const SCOPE = "platform";

export async function showPlansFor(ctx: Context, botId: string) {
  const record = await db.bot.findUnique({ where: { id: botId }, include: { subscription: true } });
  if (!record) return;

  const plans = await payablePlans(record.templateKey);
  if (plans.length === 0) {
    return void ctx.editMessageText("Bu shablon uchun tarif topilmadi. Administratorga murojaat qiling.");
  }

  // callback_data is capped at 64 bytes by Telegram: two uuids do not fit, and
  // an oversized button makes the API reject the whole message silently.
  const kb = new InlineKeyboard();
  for (const p of plans) {
    kb.text(`${p.name} — ${money(p.priceUzs)} (${p.maxBotUsers} obunachi)`, `py:${botId}:${p.code}`).row();
  }
  kb.text("◀️ Orqaga", `p:bot:${botId}`);

  await ctx.editMessageText(
    `💳 <b>Tarif tanlang</b>\n\n@${esc(record.tgUsername)} uchun.\n\n` +
      `Har bir tarif <b>30 kunga</b>. Limitdan oshsangiz botga yangi obunachi qo'shilmaydi.`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function showTerms(ctx: Context, botId: string, planCode: string) {
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) return;

  const kb = new InlineKeyboard();
  for (const t of TERMS) {
    const total = termPrice(plan.priceUzs, t.months);
    const save = t.discount > 0 ? ` · −${Math.round(t.discount * 100)}%` : "";
    kb.text(`${t.label} — ${money(total)}${save}`, `pyd:${botId}:${planCode}:${t.months}`).row();
  }
  kb.text("◀️ Orqaga", `p:pay:${botId}`);

  await ctx.editMessageText(
    `📦 <b>${esc(plan.name)}</b> — ${plan.maxBotUsers} obunachi\n\n` +
      `Muddatni tanlang. Uzoq muddat arzonroq:`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function showInvoice(ctx: Context, botId: string, planCode: string, months: number) {
  const [record, plan, details] = await Promise.all([
    db.bot.findUnique({ where: { id: botId } }),
    db.plan.findUnique({ where: { code: planCode } }),
    paymentDetails(),
  ]);
  if (!record || !plan) return;
  const amount = termPrice(plan.priceUzs, months);

  if (!details.card) {
    return void ctx.editMessageText(
      "⚠️ To'lov kartasi hali sozlanmagan. Administratorga murojaat qiling.",
      { reply_markup: new InlineKeyboard().text("◀️ Orqaga", `p:bot:${botId}`) },
    );
  }

  setStep(SCOPE, ctx.from!.id, "await_receipt", { botId, planCode, months });

  await ctx.editMessageText(
    `💳 <b>To'lov</b>\n\n` +
      `Bot: @${esc(record.tgUsername)}\n` +
      `Tarif: <b>${esc(plan.name)}</b> — ${plan.maxBotUsers} obunachi\n` +
      `Muddat: <b>${months} oy</b>\n` +
      `Summa: <b>${money(amount)}</b>\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `Quyidagi kartaga o'tkazing:\n\n` +
      `<code>${esc(details.card)}</code>\n` +
      (details.holder ? `<i>${esc(details.holder)}</i>\n` : "") +
      `\n━━━━━━━━━━━━━━\n\n` +
      `Summani <b>aynan</b> shu miqdorda o'tkazing — tekshirish osonroq bo'ladi.\n\n` +
      `To'lagach <b>chek skrinshotini</b> shu yerga tashlang.\n` +
      `Admin tekshirib tasdiqlaydi — odatda bir necha daqiqada.\n\n` +
      `Bekor qilish: /bekor`,
    { parse_mode: "HTML" },
  );
}

/** The payer sent a receipt: record it and push it to every admin for review. */
export async function submitReceipt(
  ctx: Context,
  api: Api,
  input: { fileId?: string; text?: string },
): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (state?.step !== "await_receipt") return false;

  const botId = state.data.botId as string;
  const planCode = state.data.planCode as string;
  const months = (state.data.months as number) ?? 1;

  const [owner, plan, record] = await Promise.all([
    db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } }),
    db.plan.findUniqueOrThrow({ where: { code: planCode } }),
    db.bot.findUniqueOrThrow({ where: { id: botId }, include: { subscription: true } }),
  ]);

  const payment = await db.payment.create({
    data: {
      reference: paymentReference(),
      ownerId: owner.id,
      subscriptionId: record.subscription?.id ?? null,
      planId: plan.id,
      amountUzs: termPrice(plan.priceUzs, months),
      months,
      receiptFileId: input.fileId ?? null,
      receiptText: input.text ?? null,
    },
  });

  clearStep(SCOPE, ctx.from!.id);

  await ctx.reply(
    `✅ <b>Chek qabul qilindi</b>\n\n` +
      `Raqam: <code>${payment.reference}</code>\n` +
      `Summa: ${money(payment.amountUzs)} (${months} oy)\n\n` +
      `Admin tasdiqlagach botingiz darhol ishga tushadi. Xabar beramiz.`,
    { parse_mode: "HTML" },
  );

  const caption =
    `🧾 <b>Yangi to'lov</b> <code>${payment.reference}</code>\n\n` +
    `👤 ${esc(owner.fullName)}` +
    (owner.username ? ` (@${esc(owner.username)})` : "") +
    `\n🆔 <code>${owner.tgUserId}</code>\n` +
    `🤖 @${esc(record.tgUsername)}\n` +
    `📦 ${esc(plan.name)} · ${months} oy — <b>${money(payment.amountUzs)}</b>` +
    (input.text ? `\n\n💬 ${esc(input.text)}` : "");

  const kb = new InlineKeyboard()
    .text("✅ Tasdiqlash", `adm:pay:ok:${payment.id}`)
    .text("❌ Rad etish", `adm:pay:no:${payment.id}`);

  for (const adminId of await adminTgIds()) {
    await sendSafe(async () => {
      if (input.fileId) {
        await api.sendPhoto(Number(adminId), input.fileId, {
          caption, parse_mode: "HTML", reply_markup: kb,
        });
      } else {
        await api.sendMessage(Number(adminId), caption, { parse_mode: "HTML", reply_markup: kb });
      }
    });
  }

  log.info("payment submitted", { paymentId: payment.id, reference: payment.reference });
  return true;
}

export function registerPaymentReview(bot: Bot) {
  bot.callbackQuery(/^adm:pay:(ok|no):(.+)$/, async (ctx) => {
    const actor = BigInt(ctx.from.id);
    if (!(await isAdmin(actor))) return ctx.answerCallbackQuery("Ruxsat yo'q");

    const decision = ctx.match[1];
    const paymentId = ctx.match[2]!;
    const payment = await db.payment.findUnique({
      where: { id: paymentId },
      include: { owner: true, plan: true, subscription: { include: { bot: true } } },
    });
    if (!payment) return ctx.answerCallbackQuery("Topilmadi");
    if (payment.status !== "pending") {
      return ctx.answerCallbackQuery(`Allaqachon ${payment.status === "approved" ? "tasdiqlangan" : "rad etilgan"}`);
    }

    if (decision === "no") {
      await db.payment.update({
        where: { id: paymentId },
        data: { status: "rejected", reviewedBy: actor, reviewedAt: new Date() },
      });
      await audit(actor, "payment.reject", payment.reference, { amountUzs: payment.amountUzs });
      await ctx.answerCallbackQuery("Rad etildi");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `❌ To'lovingiz (<code>${payment.reference}</code>) tasdiqlanmadi.\n\n` +
            `Chek noto'g'ri yoki summa mos kelmagan bo'lishi mumkin. Qayta urinib ko'ring yoki admin bilan bog'laning.`,
          { parse_mode: "HTML" },
        ),
      );
      return;
    }

    if (!payment.subscription) return ctx.answerCallbackQuery("Obuna topilmadi");

    await activate(payment.subscription.id, payment.planId, payment.months);
    await db.payment.update({
      where: { id: paymentId },
      data: { status: "approved", reviewedBy: actor, reviewedAt: new Date() },
    });
    await audit(actor, "payment.approve", payment.reference, {
      amountUzs: payment.amountUzs, plan: payment.plan.code,
    });

    // Bring the bot back up if it was stopped for non-payment.
    const record = await db.bot.findUnique({ where: { id: payment.subscription.botId } });
    if (record) {
      if (record.status !== "active") {
        await db.bot.update({ where: { id: record.id }, data: { status: "active", lastError: null } });
        const fresh = await db.bot.findUniqueOrThrow({ where: { id: record.id } });
        await startBot(fresh).catch((err) => log.error("restart after payment failed", { err }));
      } else {
        await reloadBot(record.id);
      }
    }

    await ctx.answerCallbackQuery("Tasdiqlandi ✅");
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    await sendSafe(() =>
      ctx.api.sendMessage(
        Number(payment.owner.tgUserId),
        `🎉 <b>To'lov tasdiqlandi!</b>\n\n` +
          `Bot: @${esc(payment.subscription!.bot.tgUsername)}\n` +
          `Tarif: <b>${esc(payment.plan.name)}</b>\n` +
          `Amal qiladi: <b>${payment.months} oy</b>\n\n` +
          `Botingiz ishlayapti. Rahmat! 🙌`,
        { parse_mode: "HTML" },
      ),
    );

    log.info("payment approved", { paymentId, by: String(actor) });
  });
}

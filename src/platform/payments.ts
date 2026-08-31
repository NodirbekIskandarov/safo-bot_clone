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
import { move } from "../billing/wallet.js";
import { priceOf } from "../billing/templates.js";
import { payReferralBonus } from "./cabinet.js";
import { withEffect } from "../lib/effects.js";
import { TERMS, termPrice } from "./menu.js";
import { PLAN_COPY, perUser, recommend } from "./plancopy.js";

const SCOPE = "platform";

export async function showPlansFor(ctx: Context, botId: string) {
  const record = await db.bot.findUnique({ where: { id: botId }, include: { subscription: true } });
  if (!record) return;

  const plans = await payablePlans(record.templateKey);
  if (plans.length === 0) {
    return void ctx.editMessageText("Bu shablon uchun tarif topilmadi. Administratorga murojaat qiling.");
  }

  // Recommend against what this bot actually has today, with room to grow —
  // a generic list makes the owner guess, and guessing wrong costs them money.
  const current = await db.botUser.count({ where: { botId } });
  const headroom = Math.max(Math.ceil(current * 1.5), current + 50);
  const suggested = recommend(plans, headroom, record.templateKey === "shop");

  // callback_data is capped at 64 bytes by Telegram: two uuids do not fit, and
  // an oversized button makes the API reject the whole message silently.
  const kb = new InlineKeyboard();
  for (const p of plans) {
    const mark = p.code === suggested?.code ? "✅ " : "";
    kb.text(`${mark}${p.name} — ${money(p.priceUzs)} · ${p.maxBotUsers} obunachi`, `py:${botId}:${p.code}`).row();
  }
  kb.text("◀️ Orqaga", `p:bot:${botId}`);

  const lines = plans.map((p) => {
    const mark = p.code === suggested?.code ? "✅ " : "• ";
    return `${mark}<b>${esc(p.name)}</b> — ${money(p.priceUzs)}/oy · ${p.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ")} obunachi\n     <i>${esc(PLAN_COPY[p.code]?.audience ?? "")}</i> · ${perUser(p.priceUzs, p.maxBotUsers)}/obunachi`;
  });

  await ctx.editMessageText(
    `💳 <b>Tarif tanlang</b> — @${esc(record.tgUsername)}\n\n` +
      `Hozir botingizda: <b>${current}</b> obunachi\n` +
      (suggested
        ? `✅ bilan belgilangani — o'sish uchun joy qoldirib tanlangan tavsiya.\n\n`
        : `\n`) +
      lines.join("\n\n") +
      `\n\n<i>Limitga yetganda eski obunachilar ishlayveradi, faqat yangilari qo'shilmaydi. ` +
      `Tarifni istalgan vaqt oshirsangiz qolgan kunlar yo'qolmaydi.</i>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function showTerms(ctx: Context, botId: string, planCode: string) {
  const plan = await db.plan.findUnique({ where: { code: planCode } });
  if (!plan) return;
  const buyer = await db.owner.findUnique({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const premium = buyer?.isPremium ?? false;

  const kb = new InlineKeyboard();
  for (const t of TERMS) {
    const total = termPrice(plan.priceUzs, t.months, premium);
    const off = Math.round((t.discount + (premium ? 0.1 : 0)) * 100);
    const save = off > 0 ? ` · −${off}%` : "";
    kb.text(`${t.label} — ${money(total)}${save}`, `pyd:${botId}:${planCode}:${t.months}`).row();
  }
  kb.text("◀️ Orqaga", `p:pay:${botId}`);

  await ctx.editMessageText(
    `📦 <b>${esc(plan.name)}</b> — ${plan.maxBotUsers} obunachi\n\n` +
      `Muddatni tanlang. Uzoq muddat arzonroq:` +
      (premium ? `\n\n💎 <i>Premium chegirmangiz narxlarga qo'shilgan.</i>` : ""),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

export async function showInvoice(ctx: Context, botId: string, planCode: string, months: number) {
  return renderInvoice(ctx, botId, planCode, months, false);
}

/** Card details without the balance shortcut — used when the user chose card explicitly. */
export async function showCardInvoice(ctx: Context, botId: string, planCode: string, months: number) {
  return renderInvoice(ctx, botId, planCode, months, true);
}

async function renderInvoice(
  ctx: Context,
  botId: string,
  planCode: string,
  months: number,
  forceCard: boolean,
) {
  const [record, plan, details] = await Promise.all([
    db.bot.findUnique({ where: { id: botId } }),
    db.plan.findUnique({ where: { code: planCode } }),
    paymentDetails(),
  ]);
  if (!record || !plan) return;
  const buyer = await db.owner.findUnique({ where: { tgUserId: BigInt(ctx.from!.id) } });
  const amount = termPrice(plan.priceUzs, months, buyer?.isPremium ?? false);

  if (!details.card) {
    return void ctx.editMessageText(
      "⚠️ To'lov kartasi hali sozlanmagan. Administratorga murojaat qiling.",
      { reply_markup: new InlineKeyboard().text("◀️ Orqaga", `p:bot:${botId}`) },
    );
  }

  const owner = await db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
  if (!forceCard && owner.balanceUzs >= amount) {
    return void ctx.editMessageText(
      `💳 <b>To'lov</b>\n\n` +
        `Bot: @${esc(record.tgUsername)}\n` +
        `Tarif: <b>${esc(plan.name)}</b> · ${months} oy\n` +
        `Summa: <b>${money(amount)}</b>\n\n` +
        `💰 Balansingiz: <b>${money(owner.balanceUzs)}</b> — yetadi.\n\n` +
        `Balansdan to'lasangiz chek yuborish va tasdiq kutish shart emas, tarif <b>darhol</b> faollashadi.`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("⚡️ Balansdan to'lash", `wb:${botId}:${planCode}:${months}`)
          .row()
          .text("💳 Karta orqali", `pyc:${botId}:${planCode}:${months}`)
          .row()
          .text("◀️ Orqaga", `py:${botId}:${planCode}`),
      },
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
    {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("💰 Balansni to'ldirib, tez to'lash", "w:top"),
    },
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
      amountUzs: termPrice(plan.priceUzs, months, owner.isPremium),
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

    // ---- balance top-up
    if (payment.kind === "topup") {
      const left = await move(payment.ownerId, payment.amountUzs, "topup", {
        note: `To'lov ${payment.reference}`, refId: payment.id,
      });
      await db.payment.update({
        where: { id: paymentId },
        data: { status: "approved", reviewedBy: actor, reviewedAt: new Date() },
      });
      await audit(actor, "payment.topup", payment.reference, { amountUzs: payment.amountUzs });
      await ctx.answerCallbackQuery("Balans to'ldirildi ✅");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `💰 <b>Balans to'ldirildi</b>\n\n+${money(payment.amountUzs)}\n` +
            `Yangi balans: <b>${money(left)}</b>\n\nEndi «💳 Tariflar» dan bir bosishda sotib olasiz.`,
          { parse_mode: "HTML", ...withEffect("party") },
        ),
      );
      await payReferralBonus(payment.ownerId, payment.amountUzs);
      log.info("topup approved", { paymentId, by: String(actor) });
      return;
    }

    // ---- one-off template purchase
    if (payment.kind === "template" && payment.templateKey) {
      await db.ownerTemplate.upsert({
        where: { ownerId_templateKey: { ownerId: payment.ownerId, templateKey: payment.templateKey } },
        create: { ownerId: payment.ownerId, templateKey: payment.templateKey, pricePaid: payment.amountUzs },
        update: {},
      });
      await db.payment.update({
        where: { id: paymentId },
        data: { status: "approved", reviewedBy: actor, reviewedAt: new Date() },
      });
      await audit(actor, "payment.template", payment.reference, { templateKey: payment.templateKey });
      await ctx.answerCallbackQuery("Shablon ochildi ✅");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `🔓 <b>Shablon ochildi!</b>\n\nEndi «➕ Bot yaratish» da undan foydalanishingiz mumkin.`,
          { parse_mode: "HTML" },
        ),
      );
      return;
    }

    // ---- subscription
    if (!payment.subscription || !payment.planId || !payment.plan) {
      return ctx.answerCallbackQuery("Obuna topilmadi");
    }

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
          `Tarif: <b>${esc(payment.plan!.name)}</b>\n` +
          `Amal qiladi: <b>${payment.months} oy</b>\n\n` +
          `Botingiz ishlayapti. Rahmat! 🙌`,
        { parse_mode: "HTML" },
      ),
    );

    log.info("payment approved", { paymentId, by: String(actor) });
  });
}

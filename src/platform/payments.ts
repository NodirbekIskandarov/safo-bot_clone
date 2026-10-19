import { InlineKeyboard } from "grammy";
import type { Api, Bot, Context } from "grammy";
import { activate, premiumActive } from "../billing/subscription.js";
import { payablePlans } from "../billing/plans.js";
import { db } from "../db.js";
import { clearStep, getStep, resetStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { reloadBot, startBot } from "../runtime/registry.js";
import { adminTgIds, audit, isAdmin, paymentReference } from "./access.js";
import { paymentDetails } from "./settings.js";
import { move } from "../billing/wallet.js";
import { payReferralBonus } from "./cabinet.js";
import { withEffect } from "../lib/effects.js";
import { PREMIUM_DISCOUNT, TERMS, termPrice } from "./menu.js";
import { PLAN_COPY, perUser, recommend } from "./plancopy.js";

const SCOPE = "platform";

/** The bot, only if the person tapping owns it. Callback data can be forged by a modified client. */
async function ownedBot(ctx: Context, botId: string) {
  return db.bot.findFirst({
    where: { id: botId, owner: { tgUserId: BigInt(ctx.from!.id) } },
    include: { subscription: true },
  });
}

/** The plan, only if it is on sale and allowed for this bot's template. */
async function planForBot(templateKey: string, planCode: string) {
  const plans = await payablePlans(templateKey);
  return plans.find((p) => p.code === planCode) ?? null;
}

async function buyer(ctx: Context) {
  return db.owner.findUniqueOrThrow({ where: { tgUserId: BigInt(ctx.from!.id) } });
}

export async function showPlansFor(ctx: Context, botId: string) {
  const record = await ownedBot(ctx, botId);
  if (!record) return;

  const plans = await payablePlans(record.templateKey);
  if (plans.length === 0) {
    return void ctx.editMessageText("Bu shablon uchun tarif topilmadi. Administratorga murojaat qiling.").catch(() => {});
  }

  // Recommend against what this bot actually has today, with room to grow —
  // a generic list makes the owner guess, and guessing wrong costs them money.
  const current = await db.botUser.count({ where: { botId } });
  const headroom = Math.max(Math.ceil(current * 1.5), current + 50);
  const suggested = recommend(plans, headroom, false);

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
      (suggested ? `✅ bilan belgilangani — o'sish uchun joy qoldirib tanlangan tavsiya.\n\n` : `\n`) +
      lines.join("\n\n") +
      `\n\n<i>Limitga yetganda eski obunachilar ishlayveradi, faqat yangilari qo'shilmaydi. ` +
      `Tarifni istalgan vaqt oshirsangiz qolgan kunlar yo'qolmaydi.</i>`,
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

export async function showTerms(ctx: Context, botId: string, planCode: string) {
  const record = await ownedBot(ctx, botId);
  if (!record) return;
  const plan = await planForBot(record.templateKey, planCode);
  if (!plan) return;
  const premium = premiumActive(await buyer(ctx));

  const kb = new InlineKeyboard();
  for (const t of TERMS) {
    const total = termPrice(plan.priceUzs, t.months, premium);
    const off = Math.round((t.discount + (premium ? PREMIUM_DISCOUNT : 0)) * 100);
    const save = off > 0 ? ` · −${off}%` : "";
    kb.text(`${t.label} — ${money(total)}${save}`, `pyd:${botId}:${planCode}:${t.months}`).row();
  }
  kb.text("📦 Boshqa tarif", `p:pay:${botId}`).text("◀️ Orqaga", `p:bot:${botId}`);

  await ctx.editMessageText(
    `📦 <b>${esc(plan.name)}</b> — ${plan.maxBotUsers} obunachi · ${money(plan.priceUzs)}/oy\n\n` +
      `Muddatni tanlang. Uzoq muddat arzonroq:` +
      (premium ? `\n\n💎 <i>Premium chegirmangiz narxlarga qo'shilgan.</i>` : ""),
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

export async function showInvoice(ctx: Context, botId: string, planCode: string, months: number) {
  return renderInvoice(ctx, botId, planCode, months, false);
}

/** Card details without the balance shortcut — used when the user chose card explicitly. */
export async function showCardInvoice(ctx: Context, botId: string, planCode: string, months: number) {
  return renderInvoice(ctx, botId, planCode, months, true);
}

async function renderInvoice(ctx: Context, botId: string, planCode: string, months: number, forceCard: boolean) {
  const record = await ownedBot(ctx, botId);
  if (!record) return;
  const [plan, details, owner] = await Promise.all([
    planForBot(record.templateKey, planCode),
    paymentDetails(),
    buyer(ctx),
  ]);
  if (!plan || !TERMS.some((t) => t.months === months)) return;
  const amount = termPrice(plan.priceUzs, months, premiumActive(owner));

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
    ).catch(() => {});
  }

  if (!details.card) {
    return void ctx.editMessageText("⚠️ To'lov kartasi hali sozlanmagan. Administratorga murojaat qiling.", {
      reply_markup: new InlineKeyboard().text("◀️ Orqaga", `p:bot:${botId}`),
    }).catch(() => {});
  }

  // A fresh wizard, never merged into leftovers: a stale top-up amount once
  // turned a subscription receipt into a balance top-up.
  resetStep(SCOPE, ctx.from!.id, "await_receipt", { botId, planCode, months });

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
  ).catch(() => {});
}

/** The payer sent a receipt: record it and push it to every admin for review. */
export async function submitReceipt(
  ctx: Context,
  api: Api,
  input: { fileId?: string; text?: string },
): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (state?.step !== "await_receipt" || !state.data.botId) return false;

  const botId = state.data.botId as string;
  const planCode = state.data.planCode as string;
  const months = (state.data.months as number) ?? 1;

  const record = await ownedBot(ctx, botId);
  const plan = record ? await planForBot(record.templateKey, planCode) : null;
  if (!record || !plan) {
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply("Bu to'lov endi amal qilmaydi. «🤖 Botlarim» dan qaytadan boshlang.");
    return true;
  }
  const owner = await buyer(ctx);

  const payment = await db.payment.create({
    data: {
      reference: paymentReference(),
      ownerId: owner.id,
      subscriptionId: record.subscription?.id ?? null,
      planId: plan.id,
      amountUzs: termPrice(plan.priceUzs, months, premiumActive(owner)),
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
    `🧾 <b>Yangi to'lov</b> <code>${payment.reference}</code>` + (premiumActive(owner) ? " 💎" : "") + `\n\n` +
    `👤 ${esc(owner.fullName)}` +
    (owner.username ? ` (@${esc(owner.username)})` : "") +
    `\n🆔 <code>${owner.tgUserId}</code>\n` +
    `🤖 @${esc(record.tgUsername)}\n` +
    `📦 ${esc(plan.name)} · ${months} oy — <b>${money(payment.amountUzs)}</b>` +
    (input.text ? `\n\n💬 ${esc(input.text)}` : "");

  await notifyAdmins(api, payment.id, caption, input.fileId);
  log.info("payment submitted", { paymentId: payment.id, reference: payment.reference });
  return true;
}

export async function notifyAdmins(api: Api, paymentId: string, caption: string, fileId?: string) {
  const kb = new InlineKeyboard()
    .text("✅ Tasdiqlash", `adm:pay:ok:${paymentId}`)
    .text("❌ Rad etish", `adm:pay:no:${paymentId}`);
  for (const adminId of await adminTgIds()) {
    await sendSafe(async () => {
      if (fileId) await api.sendPhoto(Number(adminId), fileId, { caption, parse_mode: "HTML", reply_markup: kb });
      else await api.sendMessage(Number(adminId), caption, { parse_mode: "HTML", reply_markup: kb });
    });
  }
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

    // Claim the payment first, conditionally: two admins approving at once
    // (every admin gets the receipt) must not credit it twice.
    const claimed = await db.payment.updateMany({
      where: { id: paymentId, status: "pending" },
      data: { status: decision === "no" ? "rejected" : "approved", reviewedBy: actor, reviewedAt: new Date() },
    });
    if (claimed.count === 0) {
      const now = await db.payment.findUnique({ where: { id: paymentId }, select: { status: true } });
      return ctx.answerCallbackQuery(`Allaqachon ${now?.status === "approved" ? "tasdiqlangan" : "rad etilgan"}`);
    }
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

    if (decision === "no") {
      await audit(actor, "payment.reject", payment.reference, { amountUzs: payment.amountUzs });
      await ctx.answerCallbackQuery("Rad etildi");
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `❌ To'lovingiz (<code>${payment.reference}</code>) tasdiqlanmadi.\n\n` +
            `Chek noto'g'ri yoki summa mos kelmagan bo'lishi mumkin. Qayta urinib ko'ring yoki «✉️ Murojaat» orqali yozing.`,
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
      await audit(actor, "payment.topup", payment.reference, { amountUzs: payment.amountUzs });
      await ctx.answerCallbackQuery("Balans to'ldirildi ✅");
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `💰 <b>Balans to'ldirildi</b>\n\n+${money(payment.amountUzs)}\n` +
            `Yangi balans: <b>${money(left)}</b>\n\n` +
            `Endi tarifni bir bosishda olasiz, avto uzaytirish esa botingizni to'xtatmaydi.`,
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
      await audit(actor, "payment.template", payment.reference, { templateKey: payment.templateKey });
      await ctx.answerCallbackQuery("Shablon ochildi ✅");
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `🔓 <b>Shablon ochildi!</b>\n\nEndi «➕ Bot yaratish» da undan foydalanishingiz mumkin.`,
          { parse_mode: "HTML" },
        ),
      );
      return;
    }

    // ---- subscription whose bot was deleted meanwhile: the money is real, keep it
    if (!payment.subscription || !payment.planId || !payment.plan) {
      const left = await move(payment.ownerId, payment.amountUzs, "refund", {
        note: `To'lov ${payment.reference} — bot o'chirilgan`, refId: payment.id,
      });
      await audit(actor, "payment.refund_to_balance", payment.reference, { amountUzs: payment.amountUzs });
      await ctx.answerCallbackQuery("Bot yo'q — summa balansga qaytarildi");
      await sendSafe(() =>
        ctx.api.sendMessage(
          Number(payment.owner.tgUserId),
          `ℹ️ To'lovingiz (<code>${payment.reference}</code>) tasdiqlandi, lekin bot o'chirilgan ekan.\n\n` +
            `<b>${money(payment.amountUzs)}</b> balansingizga qo'shildi. Balans: <b>${money(left)}</b>`,
          { parse_mode: "HTML" },
        ),
      );
      return;
    }

    await activate(payment.subscription.id, payment.planId, payment.months);
    await audit(actor, "payment.approve", payment.reference, {
      amountUzs: payment.amountUzs, plan: payment.plan.code,
    });

    // Bring the bot back up if it was stopped for non-payment.
    const record = await db.bot.findUnique({ where: { id: payment.subscription.botId } });
    if (record) {
      if (record.status !== "active") {
        const fresh = await db.bot.update({ where: { id: record.id }, data: { status: "active", lastError: null } });
        await startBot(fresh).catch((err) => log.error("restart after payment failed", { err }));
      } else {
        await reloadBot(record.id);
      }
    }

    await ctx.answerCallbackQuery("Tasdiqlandi ✅");
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

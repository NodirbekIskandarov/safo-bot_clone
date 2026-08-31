import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import type { AdminItem } from "./admin.js";
import type { AppBot, BotCtx } from "./context.js";

const SCOPE = "botsub";
const ADMIN = "botsub_admin";

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 3600 * 1000);
}

export async function activeSubscription(botId: string, botUserId: string) {
  const sub = await db.botSubscription.findUnique({
    where: { botUserId },
    include: { botPlan: true },
  });
  if (!sub || sub.botId !== botId) return null;
  if (sub.endsAt <= new Date()) return null;
  return sub;
}

/** Owner's own card, kept per bot — they collect this money, not the platform. */
function payCard(ctx: BotCtx): { card?: string; holder?: string } {
  return {
    card: ctx.settings.payCard as string | undefined,
    holder: ctx.settings.payCardHolder as string | undefined,
  };
}

async function showPlans(ctx: BotCtx) {
  const plans = await db.botPlan.findMany({
    where: { botId: ctx.botId, isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  if (plans.length === 0) {
    return ctx.reply(
      ctx.isAdmin
        ? "Hali obuna tarifi yo'q. /admin → 💎 Obunalar → ➕ Tarif"
        : "Hozircha obuna tariflari yo'q.",
    );
  }

  const current = await activeSubscription(ctx.botId, ctx.appUser.id);
  const kb = new InlineKeyboard();
  for (const p of plans) kb.text(`${p.title} — ${money(p.priceUzs)}`, `bs:buy:${p.id}`).row();

  const body = plans
    .map((p) => `<b>${esc(p.title)}</b> — ${money(p.priceUzs)} / ${p.days} kun\n${p.description ? esc(p.description) : ""}`)
    .join("\n\n");

  await ctx.reply(
    `💎 <b>Obuna tariflari</b>\n\n${body}` +
      (current
        ? `\n\n━━━━━━━━━━━━━━\n✅ Sizda faol obuna bor: <b>${esc(current.botPlan.title)}</b>\n` +
          `Tugash sanasi: ${current.endsAt.toLocaleDateString("uz-UZ")}`
        : ""),
    { parse_mode: "HTML", reply_markup: kb },
  );
}

/**
 * Subscription selling inside a tenant bot. The money goes to the bot owner's
 * own card — the platform only records who paid and unlocks access.
 */
export function registerBotSubscriptions(bot: AppBot): AdminItem[] {
  bot.command("obuna", (ctx) => showPlans(ctx));
  bot.hears("💎 Obuna", (ctx) => showPlans(ctx));

  bot.callbackQuery(/^bs:buy:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = await db.botPlan.findFirst({ where: { id: ctx.match[1]!, botId: ctx.botId } });
    if (!plan) return;

    const { card, holder } = payCard(ctx);
    if (!card) {
      return void ctx.reply("⚠️ To'lov kartasi sozlanmagan. Bot administratoriga murojaat qiling.");
    }

    setStep(SCOPE, ctx.from!.id, "await_receipt", { planId: plan.id });
    await ctx.reply(
      `💎 <b>${esc(plan.title)}</b>\n\n` +
        `Summa: <b>${money(plan.priceUzs)}</b>\nMuddat: <b>${plan.days} kun</b>\n\n` +
        `━━━━━━━━━━━━━━\n\n<code>${esc(card)}</code>\n` +
        (holder ? `<i>${esc(holder)}</i>\n` : "") +
        `\n━━━━━━━━━━━━━━\n\n` +
        `To'lagach <b>chek skrinshotini</b> shu yerga tashlang. Admin tasdiqlaydi.\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // receipt from a subscriber
  bot.on("message:photo", async (ctx, next) => {
    const state = getStep(SCOPE, ctx.from!.id);
    if (state?.step !== "await_receipt") return next();

    const plan = await db.botPlan.findFirst({ where: { id: state.data.planId as string, botId: ctx.botId } });
    if (!plan) return void clearStep(SCOPE, ctx.from!.id);
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;

    const payment = await db.botPayment.create({
      data: {
        botId: ctx.botId, botUserId: ctx.appUser.id, botPlanId: plan.id,
        amountUzs: plan.priceUzs, receiptFileId: photo.file_id,
      },
    });
    clearStep(SCOPE, ctx.from!.id);

    await ctx.reply("✅ Chek qabul qilindi. Admin tasdiqlagach obunangiz faollashadi.");

    const caption =
      `💎 <b>Obuna to'lovi</b>\n\n` +
      `👤 ${esc(ctx.appUser.firstName ?? "")}${ctx.appUser.username ? ` (@${esc(ctx.appUser.username)})` : ""}\n` +
      `📦 ${esc(plan.title)} — <b>${money(plan.priceUzs)}</b> · ${plan.days} kun`;
    const kb = new InlineKeyboard()
      .text("✅ Tasdiqlash", `bs:ok:${payment.id}`)
      .text("❌ Rad etish", `bs:no:${payment.id}`);

    const admins = await db.botUser.findMany({ where: { botId: ctx.botId, isAdmin: true } });
    for (const admin of admins) {
      await sendSafe(
        () => ctx.api.sendPhoto(Number(admin.tgUserId), photo.file_id, {
          caption, parse_mode: "HTML", reply_markup: kb,
        }),
        { botId: ctx.botId, botUserId: admin.id },
      );
    }
  });

  bot.callbackQuery(/^bs:(ok|no):(.+)$/, async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    const approve = ctx.match[1] === "ok";
    const payment = await db.botPayment.findUnique({
      where: { id: ctx.match[2]! },
      include: { botUser: true, botPlan: true },
    });
    if (!payment || payment.status !== "pending") return ctx.answerCallbackQuery("Allaqachon ko'rilgan");

    await db.botPayment.update({
      where: { id: payment.id },
      data: {
        status: approve ? "approved" : "rejected",
        reviewedBy: BigInt(ctx.from.id),
        reviewedAt: new Date(),
      },
    });

    if (approve) {
      const existing = await db.botSubscription.findUnique({ where: { botUserId: payment.botUserId } });
      // Extend rather than replace, so renewing early is never a loss.
      const base = existing && existing.endsAt > new Date() ? existing.endsAt : new Date();
      await db.botSubscription.upsert({
        where: { botUserId: payment.botUserId },
        create: {
          botId: payment.botId, botUserId: payment.botUserId, botPlanId: payment.botPlanId,
          endsAt: addDays(base, payment.botPlan.days),
        },
        update: {
          botPlanId: payment.botPlanId, status: "active",
          endsAt: addDays(base, payment.botPlan.days),
        },
      });
      log.info("bot subscription activated", { botId: payment.botId, botUserId: payment.botUserId });
    }

    await ctx.answerCallbackQuery(approve ? "Tasdiqlandi ✅" : "Rad etildi");
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await sendSafe(
      () =>
        ctx.api.sendMessage(
          Number(payment.botUser.tgUserId),
          approve
            ? `🎉 <b>Obunangiz faollashdi!</b>\n\n${esc(payment.botPlan.title)} · ${payment.botPlan.days} kun`
            : `❌ To'lovingiz tasdiqlanmadi. Admin bilan bog'laning.`,
          { parse_mode: "HTML" },
        ),
      { botId: ctx.botId, botUserId: payment.botUserId },
    );
  });

  // ------------------------------------------------------------ owner side

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.isAdmin) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();
    const state = getStep(ADMIN, ctx.from!.id);
    if (!state) return next();

    if (state.step === "p_title") {
      setStep(ADMIN, ctx.from!.id, "p_price", { title: text });
      return void ctx.reply("2-qadam: narxini yuboring (so'mda, faqat raqam).");
    }
    if (state.step === "p_price") {
      const price = Number(text.replace(/\D/g, ""));
      if (!price) return void ctx.reply("Narx noto'g'ri.");
      setStep(ADMIN, ctx.from!.id, "p_days", { priceUzs: price });
      return void ctx.reply("3-qadam: necha kunga? (masalan 30)");
    }
    if (state.step === "p_days") {
      const days = Number(text.replace(/\D/g, "")) || 30;
      const count = await db.botPlan.count({ where: { botId: ctx.botId } });
      await db.botPlan.create({
        data: {
          botId: ctx.botId, title: state.data.title as string,
          priceUzs: state.data.priceUzs as number, days, sortOrder: count,
        },
      });
      clearStep(ADMIN, ctx.from!.id);
      return void ctx.reply(
        `✅ Tarif qo'shildi: <b>${esc(state.data.title as string)}</b> — ` +
          `${money(state.data.priceUzs as number)} / ${days} kun`,
        { parse_mode: "HTML" },
      );
    }
    if (state.step === "p_card") {
      const [card, ...rest] = text.split("\n");
      const digits = (card ?? "").replace(/\D/g, "");
      if (digits.length < 12) return void ctx.reply("Karta raqami noto'g'ri.");
      const record = await db.bot.findUniqueOrThrow({ where: { id: ctx.botId } });
      const settings = JSON.parse(record.settings || "{}") as Record<string, unknown>;
      settings.payCard = digits.replace(/(\d{4})(?=\d)/g, "$1 ");
      if (rest.length > 0) settings.payCardHolder = rest.join(" ").trim();
      await db.bot.update({ where: { id: ctx.botId }, data: { settings: JSON.stringify(settings) } });
      clearStep(ADMIN, ctx.from!.id);
      return void ctx.reply(
        `✅ Karta saqlandi.\n\n<i>Botni platforma botidan o'chirib-yoqing — yangi karta shundan keyin ko'rinadi.</i>`,
        { parse_mode: "HTML" },
      );
    }
    return next();
  });

  bot.callbackQuery("bs:adm", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await ctx.answerCallbackQuery();
    await ownerMenu(ctx);
  });

  async function ownerMenu(ctx: BotCtx) {
    const [plans, active, pending] = await Promise.all([
      db.botPlan.findMany({ where: { botId: ctx.botId }, orderBy: { sortOrder: "asc" } }),
      db.botSubscription.count({ where: { botId: ctx.botId, status: "active", endsAt: { gt: new Date() } } }),
      db.botPayment.count({ where: { botId: ctx.botId, status: "pending" } }),
    ]);
    const { card } = payCard(ctx);
    const lines = plans.map((p) => `• <b>${esc(p.title)}</b> — ${money(p.priceUzs)} / ${p.days} kun${p.isActive ? "" : " 🚫"}`);

    await ctx.editMessageText(
      `💎 <b>Obuna tariflari</b>\n\n` +
        (lines.join("\n") || "<i>Hali tarif yo'q.</i>") +
        `\n\n👥 Faol obunachilar: <b>${active}</b>` +
        (pending > 0 ? `\n⏳ Kutilayotgan to'lovlar: <b>${pending}</b>` : "") +
        `\n💳 Karta: ${card ? `<code>${esc(card)}</code>` : "<i>sozlanmagan</i>"}` +
        `\n\n<i>Pul to'g'ridan-to'g'ri sizning kartangizga tushadi — platforma komissiya olmaydi.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("➕ Tarif qo'shish", "bs:add")
          .text("💳 Karta", "bs:card")
          .row()
          .text("🗑 Tariflarni tozalash", "bs:clear")
          .row()
          .text("◀️ Orqaga", "adm:menu"),
      },
    ).catch(() => {});
  }

  bot.callbackQuery("bs:add", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await ctx.answerCallbackQuery();
    setStep(ADMIN, ctx.from!.id, "p_title");
    await ctx.editMessageText(
      "➕ <b>Yangi tarif</b>\n\n1-qadam: tarif nomini yozing.\n\n<i>Masalan: VIP kanal — 1 oy</i>\n\nBekor: /bekor",
      { parse_mode: "HTML" },
    ).catch(() => {});
  });

  bot.callbackQuery("bs:card", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await ctx.answerCallbackQuery();
    setStep(ADMIN, ctx.from!.id, "p_card");
    await ctx.editMessageText(
      `💳 <b>To'lov kartangiz</b>\n\nObunachilaringiz shu kartaga to'laydi.\n\n` +
        `Quyidagi ko'rinishda yuboring:\n\n<code>8600 1234 5678 9012\nISM FAMILIYA</code>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    ).catch(() => {});
  });

  bot.callbackQuery("bs:clear", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await db.botPlan.deleteMany({ where: { botId: ctx.botId } });
    await ctx.answerCallbackQuery("Tozalandi");
    await ownerMenu(ctx);
  });

  return [{ id: "subs", label: "💎 Obunalar", handler: (ctx) => ownerMenu(ctx) }];
}

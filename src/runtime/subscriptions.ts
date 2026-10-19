import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, resetStep, setStep } from "../lib/state.js";
import { esc, money, sendSafe } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { patchSettings } from "./registry.js";
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

    resetStep(SCOPE, ctx.from!.id, "await_receipt", { planId: plan.id });
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
    const payment = await db.botPayment.findFirst({
      where: { id: ctx.match[2]!, botId: ctx.botId },
      include: { botUser: true, botPlan: true },
    });
    if (!payment) return ctx.answerCallbackQuery("Topilmadi");

    // Conditional on "pending": two admins tapping at once cannot both apply it.
    const claimed = await db.botPayment.updateMany({
      where: { id: payment.id, status: "pending" },
      data: {
        status: approve ? "approved" : "rejected",
        reviewedBy: BigInt(ctx.from.id),
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) return ctx.answerCallbackQuery("Allaqachon ko'rilgan");

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
      await patchSettings(ctx.botId, {
        payCard: digits.replace(/(\d{4})(?=\d)/g, "$1 "),
        ...(rest.length > 0 ? { payCardHolder: rest.join(" ").trim() } : {}),
      });
      clearStep(ADMIN, ctx.from!.id);
      return void ctx.reply("✅ Karta saqlandi. Obunachilar endi shu kartani ko'radi.");
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

    const kb = new InlineKeyboard();
    for (const p of plans) {
      kb.text(`${p.isActive ? "✅" : "🚫"} ${p.title.slice(0, 30)}`, `bs:tg:${p.id}`).row();
    }
    kb.text("➕ Tarif qo'shish", "bs:add").text("💳 Karta", "bs:card").row();
    if (plans.some((p) => p.isActive)) kb.text("🚫 Hammasini yashirish", "bs:clear").row();
    kb.text("◀️ Orqaga", "adm:menu");

    await ctx.editMessageText(
      `💎 <b>Obuna tariflari</b>\n\n` +
        (lines.join("\n") || "<i>Hali tarif yo'q.</i>") +
        `\n\n👥 Faol obunachilar: <b>${active}</b>` +
        (pending > 0 ? `\n⏳ Kutilayotgan to'lovlar: <b>${pending}</b>` : "") +
        `\n💳 Karta: ${card ? `<code>${esc(card)}</code>` : "<i>sozlanmagan</i>"}` +
        `\n\n<i>Tarifni bosib yoqasiz yoki yashirasiz. Yashirilgan tarif sotilmaydi, ` +
        `lekin uni sotib olganlarning obunasi muddati tugaguncha saqlanadi.</i>` +
        `\n<i>Pul to'g'ridan-to'g'ri sizning kartangizga tushadi — platforma komissiya olmaydi.</i>`,
      { parse_mode: "HTML", reply_markup: kb },
    ).catch(() => {});
  }

  bot.callbackQuery(/^bs:tg:(.+)$/, async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    const plan = await db.botPlan.findFirst({ where: { id: ctx.match[1]!, botId: ctx.botId } });
    if (!plan) return ctx.answerCallbackQuery("Topilmadi");
    await db.botPlan.update({ where: { id: plan.id }, data: { isActive: !plan.isActive } });
    await ctx.answerCallbackQuery(plan.isActive ? "Yashirildi" : "Yoqildi");
    await ownerMenu(ctx);
  });

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

  // Deleting plans used to cascade into every paid subscription and payment.
  // Hiding keeps paying subscribers whole and is reversible.
  bot.callbackQuery("bs:clear", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "🚫 <b>Barcha tariflar yashirilsinmi?</b>\n\nYangi obuna sotilmay qoladi. " +
        "Hozirgi obunachilar muddati tugaguncha ishlayveradi.",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🚫 Ha, yashirish", "bs:clearyes").text("◀️ Yo'q", "bs:adm"),
      },
    ).catch(() => {});
  });

  bot.callbackQuery("bs:clearyes", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await db.botPlan.updateMany({ where: { botId: ctx.botId }, data: { isActive: false } });
    await ctx.answerCallbackQuery("Yashirildi");
    await ownerMenu(ctx);
  });

  return [{ id: "subs", label: "💎 Obunalar", handler: (ctx) => ownerMenu(ctx) }];
}

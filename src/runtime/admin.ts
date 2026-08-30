import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { createBroadcast, runBroadcast } from "../jobs/broadcast.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc } from "../lib/telegram.js";
import { accessFor } from "../billing/subscription.js";
import type { AppBot, BotCtx } from "./context.js";

export interface AdminItem {
  id: string;
  label: string;
  handler: (ctx: BotCtx) => Promise<void>;
}

const SCOPE = "tenant_admin";

function menuKeyboard(extra: AdminItem[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  extra.forEach((item, i) => {
    kb.text(item.label, `adm:x:${item.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (extra.length % 2 === 1) kb.row();
  return kb
    .text("📢 Xabar yuborish", "adm:bc")
    .text("📊 Statistika", "adm:stats")
    .row()
    .text("👥 Foydalanuvchilar", "adm:users");
}

async function showMenu(ctx: BotCtx, extra: AdminItem[], edit = false) {
  const text =
    `⚙️ <b>Admin panel</b>\n` +
    `<i>${esc(ctx.botTitle)}</i>\n\n` +
    `Kerakli bo'limni tanlang.`;
  const kb = menuKeyboard(extra);
  if (edit && ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

async function stats(ctx: BotCtx) {
  const botId = ctx.botId;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const week = new Date(Date.now() - 7 * 24 * 3600 * 1000);

  const [total, today, active7, blocked] = await Promise.all([
    db.botUser.count({ where: { botId } }),
    db.botUser.count({ where: { botId, joinedAt: { gte: startOfDay } } }),
    db.botUser.count({ where: { botId, lastSeenAt: { gte: week } } }),
    db.botUser.count({ where: { botId, status: { in: ["blocked_by_user", "banned"] } } }),
  ]);

  await ctx.editMessageText(
    `📊 <b>Statistika</b>\n\n` +
      `👥 Jami obunachilar: <b>${total}</b>\n` +
      `🆕 Bugun qo'shilgan: <b>${today}</b>\n` +
      `🔥 7 kunda faol: <b>${active7}</b>\n` +
      `🚫 Bloklaganlar: <b>${blocked}</b>`,
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
  );
}

async function users(ctx: BotCtx) {
  const list = await db.botUser.findMany({
    where: { botId: ctx.botId },
    orderBy: { joinedAt: "desc" },
    take: 15,
  });

  const lines = list.map((u, i) => {
    const name = esc(u.firstName ?? "—");
    const handle = u.username ? ` @${esc(u.username)}` : "";
    const mark = u.status === "active" ? "" : " 🚫";
    return `${i + 1}. ${name}${handle}${mark}`;
  });

  await ctx.editMessageText(
    `👥 <b>Oxirgi ${list.length} foydalanuvchi</b>\n\n` + (lines.join("\n") || "Hali hech kim yo'q."),
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
  );
}

/**
 * Mount the admin panel every tenant bot shares: broadcast, stats, users.
 * Templates pass their own items (add movie, add product, …) as `extra`.
 */
export function registerAdmin(bot: AppBot, extra: AdminItem[] = []) {
  bot.command("admin", async (ctx) => {
    if (!ctx.isAdmin) return;
    clearStep(SCOPE, ctx.from!.id);
    await showMenu(ctx, extra);
  });

  bot.callbackQuery("adm:menu", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.isAdmin) return;
    await showMenu(ctx, extra, true);
  });

  bot.callbackQuery("adm:stats", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.isAdmin) return;
    await stats(ctx);
  });

  bot.callbackQuery("adm:users", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.isAdmin) return;
    await users(ctx);
  });

  bot.callbackQuery("adm:bc", async (ctx) => {
    if (!ctx.isAdmin) return void ctx.answerCallbackQuery();

    const access = await accessFor(ctx.botId);
    if (access) {
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      const usedToday = await db.broadcast.count({ where: { botId: ctx.botId, createdAt: { gte: since } } });
      if (usedToday >= access.features.broadcastDailyLimit) {
        return void ctx.answerCallbackQuery({
          text: `Bugungi limit tugadi (${access.features.broadcastDailyLimit} ta). Tarifni oshiring.`,
          show_alert: true,
        });
      }
    }

    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_content");
    await ctx.editMessageText(
      `📢 <b>Xabar yuborish</b>\n\n` +
        `Yubormoqchi bo'lgan xabarni shu yerga tashlang — matn, rasm, video, fayl, ovozli xabar, hammasi bo'ladi.\n\n` +
        `Bekor qilish uchun /bekor`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery(/^adm:x:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.isAdmin) return;
    const id = ctx.match[1];
    const item = extra.find((e) => e.id === id);
    if (item) await item.handler(ctx);
  });

  bot.callbackQuery(/^adm:bcgo:(.+)$/, async (ctx) => {
    if (!ctx.isAdmin) return;
    await ctx.answerCallbackQuery("Yuborish boshlandi");
    const state = getStep(SCOPE, ctx.from!.id);
    clearStep(SCOPE, ctx.from!.id);
    const messageId = Number(ctx.match[1]);
    const fromChatId = state?.data.fromChatId as number | undefined;
    if (!fromChatId) return;

    const { id, total } = await createBroadcast(ctx.botId, BigInt(ctx.from!.id), { fromChatId, messageId });
    await ctx.editMessageText(`📤 Yuborilmoqda… 0/${total}`);

    const statusMsg = ctx.callbackQuery.message;
    let lastShown = 0;
    const result = await runBroadcast(ctx.botId ? id : id, ctx.api, (sent, failed) => {
      const done = sent + failed;
      if (done - lastShown >= 25 && statusMsg) {
        lastShown = done;
        void ctx.api
          .editMessageText(statusMsg.chat.id, statusMsg.message_id, `📤 Yuborilmoqda… ${done}/${total}`)
          .catch(() => {});
      }
    });

    await ctx.reply(
      `✅ <b>Yuborish tugadi</b>\n\n` +
        `📨 Yetkazildi: <b>${result.sent}</b>\n` +
        `🚫 Bloklagan: <b>${result.blocked}</b>\n` +
        `⚠️ Xato: <b>${result.failed}</b>`,
      { parse_mode: "HTML" },
    );
  });

  bot.callbackQuery("adm:bccancel", async (ctx) => {
    await ctx.answerCallbackQuery("Bekor qilindi");
    clearStep(SCOPE, ctx.from!.id);
    await ctx.editMessageText("Bekor qilindi.");
  });

  bot.command("bekor", async (ctx) => {
    if (!ctx.isAdmin) return;
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply("Bekor qilindi.");
  });

  // Capture the composed broadcast message. Runs before template handlers so a
  // photo meant for a broadcast is not mistaken for product content.
  bot.use(async (ctx, next) => {
    const state = ctx.from && ctx.isAdmin ? getStep(SCOPE, ctx.from.id) : undefined;
    if (!state || state.step !== "await_content" || !ctx.message) return next();

    const count = await db.botUser.count({ where: { botId: ctx.botId, status: "active" } });
    setStep(SCOPE, ctx.from!.id, "confirm", { fromChatId: ctx.chat!.id });

    await ctx.reply(
      `👆 Shu xabar <b>${count}</b> ta foydalanuvchiga yuboriladi.\n\nTasdiqlaysizmi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("✅ Yuborish", `adm:bcgo:${ctx.message.message_id}`)
          .text("❌ Bekor", "adm:bccancel"),
      },
    );
  });
}

import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { createBroadcast, runBroadcast } from "../jobs/broadcast.js";
import { clearAll, clearStep, getStep, setStep } from "../lib/state.js";
import { esc } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import { accessFor } from "../billing/subscription.js";
import { config } from "../config.js";
import { ADMIN_BUTTON, isReservedLabel, mainKeyboard } from "./keyboard.js";
import { templates } from "../templates/index.js";
import type { AppBot, BotCtx } from "./context.js";

export interface AdminItem {
  id: string;
  label: string;
  handler: (ctx: BotCtx) => Promise<void>;
}

const SCOPE = "tenant_admin";

function menuKeyboard(extra: AdminItem[], botId: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (config.WEB_APP_URL) {
    kb.webApp("📱 Ilova — to'liq statistika", `${config.WEB_APP_URL}?bot=${botId}`).row();
  }
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
  const kb = menuKeyboard(extra, ctx.botId);
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
  ).catch(() => {});
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
  ).catch(() => {});
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

  bot.hears(ADMIN_BUTTON, async (ctx) => {
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
    ).catch(() => {});
  });

  bot.callbackQuery(/^adm:x:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.isAdmin) return;
    const id = ctx.match[1];
    const item = extra.find((e) => e.id === id);
    if (item) await item.handler(ctx);
  });

  bot.callbackQuery(/^adm:bcgo:(.+)$/, async (ctx) => {
    if (!ctx.isAdmin) return void ctx.answerCallbackQuery();
    const state = getStep(SCOPE, ctx.from!.id);
    clearStep(SCOPE, ctx.from!.id);
    const messageId = Number(ctx.match[1]);
    const fromChatId = state?.data.fromChatId as number | undefined;
    if (!fromChatId) return void ctx.answerCallbackQuery("Xabar topilmadi, qaytadan boshlang");
    await ctx.answerCallbackQuery("Yuborish boshlandi");

    const { id, total } = await createBroadcast(ctx.botId, BigInt(ctx.from!.id), { fromChatId, messageId });
    const rate = (await accessFor(ctx.botId))?.features.broadcastRatePerSec;
    await ctx.editMessageText(`📤 Yuborilmoqda… 0/${total}`).catch(() => {});

    const statusMsg = ctx.callbackQuery.message;
    const api = ctx.api;
    const adminChat = ctx.chat!.id;
    let lastShown = 0;

    // Run detached: updates of one bot are handled one at a time, so awaiting
    // here froze the whole bot for every user until the last message went out.
    void runBroadcast(id, api, (sent, failed) => {
      const done = sent + failed;
      if (done - lastShown >= 25 && statusMsg) {
        lastShown = done;
        void api
          .editMessageText(statusMsg.chat.id, statusMsg.message_id, `📤 Yuborilmoqda… ${done}/${total}`)
          .catch(() => {});
      }
    }, rate)
      .then((result) =>
        api.sendMessage(
          adminChat,
          `✅ <b>Yuborish tugadi</b>\n\n` +
            `📨 Yetkazildi: <b>${result.sent}</b>\n` +
            `🚫 Bloklagan: <b>${result.blocked}</b>\n` +
            `⚠️ Xato: <b>${result.failed}</b>`,
          { parse_mode: "HTML" },
        ),
      )
      .catch((err) => log.error("broadcast failed", { botId: ctx.botId, err }));
  });

  bot.callbackQuery("adm:bccancel", async (ctx) => {
    await ctx.answerCallbackQuery("Bekor qilindi");
    clearStep(SCOPE, ctx.from!.id);
    await ctx.editMessageText("Bekor qilindi.").catch(() => {});
  });

  // The one /bekor of a tenant bot. It must clear every wizard of every scope:
  // a per-template handler registered later never ran, so an admin who
  // cancelled a reply still sent their next message to the customer.
  bot.command("bekor", async (ctx) => {
    clearAll(ctx.from!.id, ["shop_cart"]);
    const rows = templates[ctx.templateKey]?.menuButtons ?? [];
    await ctx.reply("Bekor qilindi.", { reply_markup: await mainKeyboard(ctx, rows) });
  });

  // Capture the composed broadcast message. Runs before template handlers so a
  // photo meant for a broadcast is not mistaken for product content.
  bot.use(async (ctx, next) => {
    const state = ctx.from && ctx.isAdmin ? getStep(SCOPE, ctx.from.id) : undefined;
    if (!state || state.step !== "await_content" || !ctx.message) return next();

    // A menu tap means "leave this wizard", not "broadcast this text".
    const rows = templates[ctx.templateKey]?.menuButtons ?? [];
    const label = ctx.message.text ?? "";
    if (label.startsWith("/")) return next();
    if (label && isReservedLabel(label, rows)) {
      clearStep(SCOPE, ctx.from!.id);
      return next();
    }

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

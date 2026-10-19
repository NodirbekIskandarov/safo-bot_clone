import { Bot as GrammyBot, InlineKeyboard } from "grammy";
import type { Bot as BotRecord } from "@prisma/client";
import { db } from "../db.js";
import { open } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { withStateNamespace } from "../lib/state.js";
import { templates } from "../templates/index.js";
import { accessFor } from "../billing/subscription.js";
import type { AppBot, BotCtx } from "./context.js";
import { activeSubscription } from "./subscriptions.js";
import { SUB_BUTTON, applyCommandAlias } from "./keyboard.js";

/** What a non-subscriber may still do in a subscribers-only bot: start, see plans, pay. */
async function mayPassPaywall(ctx: BotCtx): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (data) return data.startsWith("bs:");
  const text = ctx.message?.text?.trim();
  if (text) return /^\/(start|obuna|bekor)\b/.test(text) || text === SUB_BUTTON;
  // receipts and other media go to the payment flow, which checks its own state
  return Boolean(ctx.message?.photo);
}

interface Entry {
  bot: AppBot;
  record: BotRecord;
  /** Shared by reference with every ctx.settings of this bot. */
  settings: Record<string, unknown>;
  adminIds: bigint[];
}

const running = new Map<string, Entry>();

export function isRunning(botId: string): boolean {
  return running.has(botId);
}

export function instance(botId: string): AppBot | undefined {
  return running.get(botId)?.bot;
}

export function runningCount(): number {
  return running.size;
}

export function parseAdminIds(raw: string): bigint[] {
  try {
    return (JSON.parse(raw) as string[]).map((v) => BigInt(v));
  } catch {
    return [];
  }
}

/** Boot a tenant bot: attach identity middleware, install its template, start polling. */
export async function startBot(record: BotRecord): Promise<void> {
  if (running.has(record.id)) return;

  const template = templates[record.templateKey];
  if (!template) throw new Error(`Noma'lum shablon: ${record.templateKey}`);

  const token = open({ cipher: record.tokenCipher, iv: record.tokenIv, tag: record.tokenTag });
  const bot = new GrammyBot<BotCtx>(token);
  const adminIds = parseAdminIds(record.adminIds);
  const settings = JSON.parse(record.settings || "{}") as Record<string, unknown>;

  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;

    ctx.botId = record.id;
    ctx.botTitle = record.title;
    ctx.templateKey = record.templateKey;
    ctx.settings = settings;
    ctx.isAdmin = adminIds.includes(BigInt(from.id));

    // Plan limit: existing subscribers keep working, new ones are turned away
    // so the owner has a concrete reason to upgrade.
    const known = await db.botUser.findUnique({
      where: { botId_tgUserId: { botId: record.id, tgUserId: BigInt(from.id) } },
    });
    if (!known && !ctx.isAdmin) {
      const access = await accessFor(record.id);
      if (access) {
        const count = await db.botUser.count({ where: { botId: record.id } });
        if (count >= access.maxBotUsers) {
          await ctx
            .reply("⚠️ Bot hozircha yangi foydalanuvchi qabul qila olmayapti. Keyinroq urinib ko'ring.")
            .catch(() => {});
          return;
        }
      }
    }

    const existing = known;
    // Someone who blocked the bot and came back is reachable again. Someone who
    // pressed /stop stays unsubscribed until they press /start — any other tap
    // used to silently re-subscribe them.
    const isStart = ctx.message?.text?.startsWith("/start") ?? false;
    const revive =
      existing && (existing.status === "blocked_by_user" || existing.status === "banned" ||
        (existing.status === "unsubscribed" && isStart));

    // Writing on every single message was the busiest query of a popular bot.
    // Only touch the row when something changed or lastSeenAt is stale.
    const stale = !existing || Date.now() - existing.lastSeenAt.getTime() > 10 * 60 * 1000;
    const changed =
      !existing || existing.username !== (from.username ?? null) || existing.firstName !== from.first_name ||
      existing.isAdmin !== ctx.isAdmin || revive;

    ctx.appUser =
      existing && !stale && !changed
        ? existing
        : await db.botUser.upsert({
            where: { botId_tgUserId: { botId: record.id, tgUserId: BigInt(from.id) } },
            create: {
              botId: record.id,
              tgUserId: BigInt(from.id),
              username: from.username ?? null,
              firstName: from.first_name,
              languageCode: from.language_code ?? null,
              isAdmin: ctx.isAdmin,
            },
            update: {
              username: from.username ?? null,
              firstName: from.first_name,
              lastSeenAt: new Date(),
              isAdmin: ctx.isAdmin,
              ...(revive ? { status: "active" } : {}),
            },
          });

    applyCommandAlias(ctx, template.commandAliases);

    // "Subscribers only" mode: content is for people with an active plan.
    if (!ctx.isAdmin && settings.subsOnly === true && !(await mayPassPaywall(ctx))) {
      const plans = await db.botPlan.count({ where: { botId: record.id, isActive: true } });
      if (plans > 0 && !(await activeSubscription(record.id, ctx.appUser.id))) {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
        await ctx
          .reply("🔒 Bu bot faqat obunachilar uchun. Obuna bo'lib, barcha imkoniyatlardan foydalaning.", {
            reply_markup: new InlineKeyboard().text("💎 Obuna bo'lish", "bs:list"),
          })
          .catch(() => {});
        return;
      }
    }

    // Wizards of this bot live in their own namespace (see lib/state.ts).
    await withStateNamespace(record.id, () => next());
  });

  template.register({ bot, botId: record.id, settings });

  // Public menu for everyone; admins additionally see /admin in their own chats.
  const publicCommands = template.commands;
  void bot.api.setMyCommands(publicCommands).catch(() => {});
  for (const adminId of adminIds) {
    void bot.api
      .setMyCommands(
        [
          ...publicCommands,
          { command: "admin", description: "⚙️ Admin panel" },
          { command: "bekor", description: "Amalni bekor qilish" },
        ],
        { scope: { type: "chat", chat_id: Number(adminId) } },
      )
      .catch(() => {});
  }

  bot.catch((err) => {
    log.error("tenant bot error", { botId: record.id, err: err.error });
  });

  // Long polling: no domain, TLS or tunnel required. Swap to webhooks by
  // replacing this call with bot.api.setWebhook + a webhook receiver.
  // A revoked token fails inside start(); park the bot instead of letting the
  // rejection escape and retry forever.
  bot
    .start({
      onStart: () => log.info("bot started", { botId: record.id, username: record.tgUsername }),
      drop_pending_updates: false,
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error("bot polling stopped", { botId: record.id, message });
      running.delete(record.id);
      await db.bot
        .update({ where: { id: record.id }, data: { status: "error", lastError: message.slice(0, 200) } })
        .catch(() => {});
    });

  running.set(record.id, { bot, record, settings, adminIds });
}

/**
 * Persist setting changes and apply them to the running bot immediately.
 * Mutating the shared object means no restart, so in-flight wizards survive
 * and the owner sees the change on the very next message.
 */
export async function patchSettings(botId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const record = await db.bot.findUniqueOrThrow({ where: { id: botId } });
  const next = { ...(JSON.parse(record.settings || "{}") as Record<string, unknown>), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined || v === null) delete next[k];
  await db.bot.update({ where: { id: botId }, data: { settings: JSON.stringify(next) } });

  const entry = running.get(botId);
  if (entry) {
    for (const k of Object.keys(entry.settings)) if (!(k in next)) delete entry.settings[k];
    Object.assign(entry.settings, next);
  }
  return next;
}

/** Replace a running bot's admin list in place (the profile screen edits it). */
export function patchAdmins(botId: string, ids: bigint[]) {
  const entry = running.get(botId);
  if (!entry) return;
  entry.adminIds.splice(0, entry.adminIds.length, ...ids);
}

export async function stopBot(botId: string): Promise<void> {
  const entry = running.get(botId);
  if (!entry) return;
  running.delete(botId);
  await entry.bot.stop().catch(() => {});
  log.info("bot stopped", { botId });
}

/** Reload a bot so setting/admin changes take effect without a process restart. */
export async function reloadBot(botId: string): Promise<void> {
  await stopBot(botId);
  const record = await db.bot.findUnique({ where: { id: botId } });
  if (record && record.status === "active") await startBot(record);
}

export async function startAll(): Promise<void> {
  // "error" bots are retried: a network blip during the last boot must not
  // park a paying customer's bot until they notice and press start.
  const records = await db.bot.findMany({ where: { status: { in: ["active", "error"] } } });
  for (const record of records) {
    // A revoked token (401) stays revoked until the owner sends a new one;
    // retrying it on every boot only fills the log.
    if (record.status === "error" && /401|Unauthorized/i.test(record.lastError ?? "")) continue;
    // A lapsed subscription must not come back to life on restart.
    const access = await accessFor(record.id);
    if (access && !access.live) {
      await db.bot.update({ where: { id: record.id }, data: { status: "stopped" } });
      log.info("bot left stopped: subscription lapsed", { botId: record.id });
      continue;
    }
    try {
      if (record.status === "error") {
        await db.bot.update({ where: { id: record.id }, data: { status: "active", lastError: null } });
      }
      await startBot(record);
    } catch (err) {
      log.error("bot failed to start", { botId: record.id, err });
      await db.bot.update({
        where: { id: record.id },
        data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  log.info("registry ready", { count: running.size });
}

export async function stopAll(): Promise<void> {
  await Promise.all([...running.keys()].map((id) => stopBot(id)));
}

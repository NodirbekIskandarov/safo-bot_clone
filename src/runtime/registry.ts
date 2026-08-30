import { Bot as GrammyBot } from "grammy";
import type { Bot as BotRecord } from "@prisma/client";
import { db } from "../db.js";
import { open } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { templates } from "../templates/index.js";
import { accessFor } from "../billing/subscription.js";
import type { AppBot, BotCtx } from "./context.js";

interface Entry {
  bot: AppBot;
  record: BotRecord;
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

function parseAdminIds(raw: string): bigint[] {
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
    ctx.settings = settings;
    ctx.isAdmin = adminIds.includes(BigInt(from.id));

    // Plan limit: existing subscribers keep working, new ones are turned away
    // so the owner has a concrete reason to upgrade.
    const known = await db.botUser.findUnique({
      where: { botId_tgUserId: { botId: record.id, tgUserId: BigInt(from.id) } },
      select: { id: true },
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

    ctx.appUser = await db.botUser.upsert({
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
        // a user who returns after blocking is active again
        status: "active",
      },
    });

    await next();
  });

  template.register({ bot, botId: record.id, settings });

  // Public menu for everyone; admins additionally see /admin in their own chats.
  void bot.api.setMyCommands([{ command: "start", description: "Boshlash" }]).catch(() => {});
  for (const adminId of adminIds) {
    void bot.api
      .setMyCommands(
        [
          { command: "start", description: "Boshlash" },
          { command: "admin", description: "Admin panel" },
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
  void bot.start({
    onStart: () => log.info("bot started", { botId: record.id, username: record.tgUsername }),
    drop_pending_updates: false,
  });

  running.set(record.id, { bot, record });
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
  const records = await db.bot.findMany({ where: { status: "active" } });
  for (const record of records) {
    // A lapsed subscription must not come back to life on restart.
    const access = await accessFor(record.id);
    if (access && !access.live) {
      await db.bot.update({ where: { id: record.id }, data: { status: "stopped" } });
      log.info("bot left stopped: subscription lapsed", { botId: record.id });
      continue;
    }
    try {
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

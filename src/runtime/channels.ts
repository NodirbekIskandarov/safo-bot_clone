import { InlineKeyboard } from "grammy";
import { db } from "../db.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc } from "../lib/telegram.js";
import type { AdminItem } from "./admin.js";
import type { AppBot, BotCtx } from "./context.js";

/**
 * Required-channel subscription, shared by every template that gates on it
 * (kino, contest). The contest template used to check channels it gave the
 * owner no way to add.
 */

const SCOPE = "channels_admin";

/** Subscription answers are cached briefly: getChatMember on every message is wasteful. */
const subCache = new Map<string, { until: number }>();
const SUB_TTL_MS = 5 * 60 * 1000;

export interface MissingChannel {
  title: string;
  inviteUrl: string;
}

export async function missingChannels(ctx: BotCtx, opts: { fresh?: boolean } = {}): Promise<MissingChannel[]> {
  const channels = await db.requiredChannel.findMany({
    where: { botId: ctx.botId, isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  if (channels.length === 0) return [];

  const cacheKey = `${ctx.botId}:${ctx.from!.id}`;
  if (opts.fresh) subCache.delete(cacheKey);
  const hit = subCache.get(cacheKey);
  if (hit && hit.until > Date.now()) return [];

  const missing: MissingChannel[] = [];
  for (const ch of channels) {
    try {
      const member = await ctx.api.getChatMember(Number(ch.chatId), ctx.from!.id);
      const isIn =
        ["creator", "administrator", "member"].includes(member.status) ||
        (member.status === "restricted" && "is_member" in member && member.is_member);
      if (!isIn) missing.push({ title: ch.title, inviteUrl: ch.inviteUrl });
    } catch {
      // The bot lost admin rights in that channel — do not lock users out.
      continue;
    }
  }

  if (missing.length === 0) subCache.set(cacheKey, { until: Date.now() + SUB_TTL_MS });
  return missing;
}

export async function askToSubscribe(ctx: BotCtx, missing: MissingChannel[], checkData: string) {
  const kb = new InlineKeyboard();
  for (const ch of missing) kb.url(`📢 ${ch.title}`, ch.inviteUrl).row();
  kb.text("✅ Tekshirish", checkData);
  await ctx.reply(
    "🔒 Davom etish uchun quyidagi kanal(lar)ga obuna bo'ling, keyin «Tekshirish» tugmasini bosing.",
    { reply_markup: kb },
  );
}

function clearCache(botId: string) {
  for (const k of subCache.keys()) if (k.startsWith(`${botId}:`)) subCache.delete(k);
}

async function showChannels(ctx: BotCtx) {
  const channels = await db.requiredChannel.findMany({ where: { botId: ctx.botId }, orderBy: { sortOrder: "asc" } });
  const kb = new InlineKeyboard();
  for (const c of channels) kb.text(`🗑 ${c.title.slice(0, 40)}`, `ch:del:${c.id}`).row();
  kb.text("➕ Kanal qo'shish", "ch:add").row().text("◀️ Orqaga", "adm:menu");

  await ctx.editMessageText(
    `🔒 <b>Majburiy obuna</b>\n\n` +
      (channels.map((c) => `• ${esc(c.title)}`).join("\n") || "<i>Hozircha kanal qo'shilmagan.</i>") +
      `\n\n<i>Kanalni olib tashlash uchun uni bosing.</i>`,
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

/** Mount the channel admin. Returns its admin-panel item. */
export function registerChannels(bot: AppBot): AdminItem {
  bot.callbackQuery("ch:add", async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_channel");
    await ctx.editMessageText(
      `➕ <b>Kanal qo'shish</b>\n\n1. Botni kanalga <b>admin</b> qiling\n` +
        `2. Kanal usernameni yuboring: <code>@kanal</code>\n\nBekor: /bekor`,
      { parse_mode: "HTML" },
    ).catch(() => {});
  });

  bot.callbackQuery(/^ch:del:(.+)$/, async (ctx) => {
    if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
    await db.requiredChannel.deleteMany({ where: { id: ctx.match[1]!, botId: ctx.botId } });
    clearCache(ctx.botId);
    await ctx.answerCallbackQuery("Olib tashlandi");
    await showChannels(ctx);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.isAdmin) return next();
    const text = ctx.message.text.trim();
    if (text.startsWith("/") || getStep(SCOPE, ctx.from!.id)?.step !== "await_channel") return next();

    const handle = text.startsWith("@") ? text : `@${text.replace(/^https?:\/\/t\.me\//, "")}`;
    try {
      const chat = await ctx.api.getChat(handle);
      const member = await ctx.api.getChatMember(chat.id, ctx.me.id);
      if (!["administrator", "creator"].includes(member.status)) {
        return void ctx.reply("❌ Bot bu kanalda admin emas. Avval admin qiling, keyin qayta yuboring.");
      }
      const title = ("title" in chat && chat.title) || handle;
      const count = await db.requiredChannel.count({ where: { botId: ctx.botId } });
      await db.requiredChannel.upsert({
        where: { botId_chatId: { botId: ctx.botId, chatId: BigInt(chat.id) } },
        create: {
          botId: ctx.botId, chatId: BigInt(chat.id), title,
          inviteUrl: `https://t.me/${handle.slice(1)}`, sortOrder: count,
        },
        update: { isActive: true, title },
      });
      clearStep(SCOPE, ctx.from!.id);
      clearCache(ctx.botId);
      await ctx.reply(`✅ «${esc(title)}» majburiy obunaga qo'shildi.`, {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("🔒 Kanallar", "adm:x:channels"),
      });
    } catch {
      await ctx.reply("❌ Kanal topilmadi yoki bot unga kira olmadi. Usernameni tekshiring.");
    }
  });

  return { id: "channels", label: "🔒 Majburiy obuna", handler: (ctx) => showChannels(ctx) };
}

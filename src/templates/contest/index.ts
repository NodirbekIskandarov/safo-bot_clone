import { randomInt } from "node:crypto";
import { InlineKeyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc, sendSafe } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "contest";
const DEFAULT_WELCOME = "🎁 Konkursga xush kelibsiz! Ishtirok etish uchun tugmani bosing.";

async function currentContest(botId: string) {
  return db.contest.findFirst({ where: { botId, status: "open" }, orderBy: { createdAt: "desc" } });
}

async function missingChannels(ctx: BotCtx) {
  const channels = await db.requiredChannel.findMany({ where: { botId: ctx.botId, isActive: true } });
  const missing: { title: string; inviteUrl: string }[] = [];
  for (const ch of channels) {
    try {
      const m = await ctx.api.getChatMember(Number(ch.chatId), ctx.from!.id);
      if (!["creator", "administrator", "member"].includes(m.status)) {
        missing.push({ title: ch.title, inviteUrl: ch.inviteUrl });
      }
    } catch {
      continue;
    }
  }
  return missing;
}

export const contestTemplate: BotTemplate = {
  key: "contest",
  emoji: "🎁",
  name: "Konkurs boti",
  tagline: "Ishtirokchi yig'adi, g'olibni o'zi tanlaydi",
  description:
    "Foydalanuvchilar tugma bosib ishtirok etadi, har biriga bilet raqami beriladi. Kanalga majburiy " +
    "obuna qo'ysangiz — avval obuna bo'lishadi. G'olib tasodifiy tanlanadi va hammaga e'lon qilinadi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },
  commands: [
    { command: "start", description: "Boshlash" },
    { command: "ishtirok", description: "Ishtirok etish" },
  ],

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      const contest = await currentContest(ctx.botId);
      const kb = new InlineKeyboard();
      if (contest) kb.text("🎯 Ishtirok etish", "ct:join");
      if (ctx.isAdmin) kb.row().text("⚙️ Admin panel", "adm:menu");

      const body = contest
        ? `🎁 <b>${esc(contest.title)}</b>\n\n` +
          (contest.prize ? `🏆 Sovrin: <b>${esc(contest.prize)}</b>\n` : "") +
          `👥 G'oliblar soni: ${contest.winnerCount}\n\n` +
          ((ctx.settings.welcome as string) || DEFAULT_WELCOME)
        : ctx.isAdmin
          ? "Hozircha faol konkurs yo'q. /admin → ➕ Konkurs"
          : "Hozircha faol konkurs yo'q. Kuzatib boring 🙌";

      await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
    });

    bot.callbackQuery("ct:join", async (ctx) => {
      const contest = await currentContest(ctx.botId);
      if (!contest) return ctx.answerCallbackQuery({ text: "Konkurs tugagan", show_alert: true });

      if (contest.requireSub) {
        const missing = await missingChannels(ctx);
        if (missing.length > 0) {
          await ctx.answerCallbackQuery({ text: "Avval kanallarga obuna bo'ling", show_alert: true });
          const kb = new InlineKeyboard();
          for (const ch of missing) kb.url(`📢 ${ch.title}`, ch.inviteUrl).row();
          kb.text("✅ Tekshirish", "ct:join");
          return void ctx.reply("🔒 Ishtirok etish uchun obuna bo'ling:", { reply_markup: kb });
        }
      }

      const existing = await db.contestEntry.findUnique({
        where: { contestId_botUserId: { contestId: contest.id, botUserId: ctx.appUser.id } },
      });
      if (existing) {
        return ctx.answerCallbackQuery({
          text: `Siz allaqachon ishtirok etyapsiz. Bilet: #${existing.ticketNo}`,
          show_alert: true,
        });
      }

      const count = await db.contestEntry.count({ where: { contestId: contest.id } });
      const entry = await db.contestEntry.create({
        data: { contestId: contest.id, botUserId: ctx.appUser.id, ticketNo: count + 1 },
      });

      await ctx.answerCallbackQuery({ text: `✅ Bilet #${entry.ticketNo}`, show_alert: true });
      await ctx.reply(
        `🎯 <b>Ishtirok qabul qilindi!</b>\n\n` +
          `Bilet raqamingiz: <b>#${entry.ticketNo}</b>\n` +
          `Ishtirokchilar: ${count + 1}\n\n` +
          `Natijani shu botda e'lon qilamiz. Omad! 🍀`,
        { parse_mode: "HTML" },
      );
    });

    // ---------------------------------------------------------------- admin

    bot.on("message:text", async (ctx, next) => {
      if (!ctx.isAdmin) return next();
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      const state = getStep(SCOPE, ctx.from!.id);

      if (state?.step === "await_title") {
        setStep(SCOPE, ctx.from!.id, "await_prize", { title: text });
        return ctx.reply("2-qadam: sovrinni yozing (masalan: iPhone 15).");
      }
      if (state?.step === "await_prize") {
        setStep(SCOPE, ctx.from!.id, "await_winners", { prize: text });
        return ctx.reply("3-qadam: nechta g'olib bo'ladi? (raqam)");
      }
      if (state?.step === "await_winners") {
        const n = Number(text.replace(/\D/g, "")) || 1;
        await db.contest.updateMany({ where: { botId: ctx.botId, status: "open" }, data: { status: "finished" } });
        const contest = await db.contest.create({
          data: {
            botId: ctx.botId,
            title: state.data.title as string,
            prize: state.data.prize as string,
            winnerCount: n,
          },
        });
        clearStep(SCOPE, ctx.from!.id);
        return ctx.reply(
          `✅ <b>Konkurs boshlandi!</b>\n\n🎁 ${esc(contest.title)}\n🏆 ${esc(contest.prize ?? "")}\n👥 ${n} g'olib\n\n` +
            `Endi obunachilaringizga e'lon yuboring: /admin → 📢 Xabar yuborish`,
          { parse_mode: "HTML" },
        );
      }
      return next();
    });

    bot.callbackQuery("ct:draw", async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      const contest = await currentContest(ctx.botId);
      if (!contest) return ctx.answerCallbackQuery("Faol konkurs yo'q");

      const entries = await db.contestEntry.findMany({
        where: { contestId: contest.id },
        include: { botUser: true },
      });
      if (entries.length === 0) return ctx.answerCallbackQuery("Ishtirokchi yo'q");

      // crypto.randomInt, not Math.random: a prize draw has to be defensible
      const pool = [...entries];
      const winners: typeof entries = [];
      for (let i = 0; i < Math.min(contest.winnerCount, pool.length); i++) {
        const [picked] = pool.splice(randomInt(pool.length), 1);
        if (picked) winners.push(picked);
      }

      await db.$transaction([
        db.contestEntry.updateMany({
          where: { id: { in: winners.map((w) => w.id) } },
          data: { isWinner: true },
        }),
        db.contest.update({ where: { id: contest.id }, data: { status: "finished", finishedAt: new Date() } }),
      ]);

      await ctx.answerCallbackQuery("G'oliblar tanlandi 🎉");

      const list = winners
        .map((w, i) => `${i + 1}. ${esc(w.botUser.firstName ?? "")}${w.botUser.username ? ` (@${esc(w.botUser.username)})` : ""} — bilet #${w.ticketNo}`)
        .join("\n");

      const announcement =
        `🎉 <b>${esc(contest.title)} — natijalar!</b>\n\n` +
        `🏆 Sovrin: ${esc(contest.prize ?? "")}\n` +
        `👥 Ishtirokchilar: ${entries.length}\n\n` +
        `<b>G'oliblar:</b>\n${list}\n\nTabriklaymiz! 🥳`;

      await ctx.reply(announcement, { parse_mode: "HTML" });

      for (const entry of entries) {
        await sendSafe(
          () => ctx.api.sendMessage(Number(entry.botUser.tgUserId), announcement, { parse_mode: "HTML" }),
          { botId: ctx.botId, botUserId: entry.botUserId },
        );
      }
    });

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "ct_new",
        label: "➕ Konkurs",
        handler: async (ctx) => {
          setStep(SCOPE, ctx.from!.id, "await_title");
          await ctx.editMessageText(
            "🎁 <b>Yangi konkurs</b>\n\n1-qadam: konkurs nomini yozing.\n\nBekor: /bekor",
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
            },
          ).catch(() => {});
        },
      },
      {
        id: "ct_stat",
        label: "🎯 Holat",
        handler: async (ctx) => {
          const contest = await currentContest(ctx.botId);
          if (!contest) {
            return void ctx.editMessageText("Faol konkurs yo'q.", {
              reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
            });
          }
          const count = await db.contestEntry.count({ where: { contestId: contest.id } });
          await ctx.editMessageText(
            `🎁 <b>${esc(contest.title)}</b>\n\n🏆 ${esc(contest.prize ?? "")}\n` +
              `👥 Ishtirokchilar: <b>${count}</b>\n🎖 G'oliblar soni: ${contest.winnerCount}`,
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard()
                .text("🎲 G'olibni aniqlash", "ct:draw")
                .row()
                .text("◀️ Orqaga", "adm:menu"),
            },
          ).catch(() => {});
        },
      },
    ]);
  },
};

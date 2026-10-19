import { InlineKeyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { askToSubscribe, missingChannels, registerChannels } from "../../runtime/channels.js";
import { mainKeyboard } from "../../runtime/keyboard.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "kino";
const DEFAULT_WELCOME =
  "🎬 Salom! Kino kodini yuboring — men uni sizga darhol jo'nataman.\n\nKodlarni kanalimizdan topasiz.";
const MENU = [["🎬 Kinolar ro'yxati"], ["ℹ️ Qanday ishlaydi"]];

async function sendMovie(ctx: BotCtx, code: string): Promise<boolean> {
  const movie = await db.movie.findFirst({
    where: { botId: ctx.botId, code: code.trim(), isActive: true },
  });
  if (!movie) return false;

  const caption = `🎬 <b>${esc(movie.title)}</b>${movie.caption ? `\n\n${esc(movie.caption)}` : ""}`;
  const opts = { caption, parse_mode: "HTML" as const };

  if (movie.fileType === "document") await ctx.replyWithDocument(movie.fileId, opts);
  else if (movie.fileType === "animation") await ctx.replyWithAnimation(movie.fileId, opts);
  else await ctx.replyWithVideo(movie.fileId, opts);

  await db.movie.update({ where: { id: movie.id }, data: { views: { increment: 1 } } });
  await db.botEvent.create({
    data: { botId: ctx.botId, botUserId: ctx.appUser.id, type: "movie_view", payload: JSON.stringify({ code }) },
  });
  return true;
}

async function movieList(ctx: BotCtx) {
  const movies = await db.movie.findMany({ where: { botId: ctx.botId }, orderBy: { createdAt: "desc" }, take: 20 });
  const kb = new InlineKeyboard();
  for (const m of movies) kb.text(`🗑 ${m.code} — ${m.title.slice(0, 30)}`, `kino:del:${m.id}`).row();
  kb.text("◀️ Orqaga", "adm:menu");
  const lines = movies.map((m) => `<code>${esc(m.code)}</code> — ${esc(m.title)} (👁 ${m.views})`);
  await ctx.editMessageText(
    `📃 <b>Kinolar: ${movies.length}</b>\n\n${lines.join("\n") || "Hali kino qo'shilmagan."}\n\n` +
      `<i>O'chirish uchun kinoni bosing.</i>`,
    { parse_mode: "HTML", reply_markup: kb },
  ).catch(() => {});
}

export const kinoTemplate: BotTemplate = {
  key: "kino",
  emoji: "🎬",
  name: "Kino boti",
  tagline: "Kod yuboradi — kino keladi. Majburiy obuna bilan",
  description:
    "Siz botga video yuklab, unga kod berasiz (masalan 100). Foydalanuvchi shu kodni yozsa — kino " +
    "darhol jo'natiladi. Majburiy obuna qo'ysangiz, kino olishdan oldin kanalingizga obuna bo'lishadi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },
  menuButtons: MENU,

  commands: [
    { command: "start", description: "Boshlash" },
    { command: "bekor", description: "Bekor qilish" },
  ],

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      const missing = await missingChannels(ctx);
      if (missing.length > 0) return askToSubscribe(ctx, missing, "kino:check");

      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, {
        reply_markup: await mainKeyboard(ctx, MENU),
      });
      await db.botEvent.create({ data: { botId: ctx.botId, botUserId: ctx.appUser.id, type: "start" } });
    });

    bot.callbackQuery("kino:check", async (ctx) => {
      const missing = await missingChannels(ctx, { fresh: true });
      if (missing.length > 0) {
        await ctx.answerCallbackQuery({ text: "Hali obuna bo'lmadingiz", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery("Rahmat! ✅");
      await ctx.deleteMessage().catch(() => {});
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, {
        reply_markup: await mainKeyboard(ctx, MENU),
      });
    });

    // ---------------------------------------------------------------- admin

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "movie_add",
        label: "➕ Kino qo'shish",
        handler: async (ctx) => {
          setStep(SCOPE, ctx.from!.id, "await_file");
          await ctx.editMessageText(
            "🎬 <b>Kino qo'shish</b>\n\n1-qadam: videoni shu yerga yuboring.\n\nBekor qilish: /bekor",
            { parse_mode: "HTML" },
          ).catch(() => {});
        },
      },
      { id: "movie_list", label: "📃 Kinolar", handler: (ctx) => movieList(ctx) },
      registerChannels(bot),
    ]);

    bot.callbackQuery(/^kino:del:(.+)$/, async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      await db.movie.deleteMany({ where: { id: ctx.match[1]!, botId: ctx.botId } });
      await ctx.answerCallbackQuery("O'chirildi");
      await movieList(ctx);
    });

    bot.command("ochir", async (ctx) => {
      if (!ctx.isAdmin) return;
      const code = ctx.match?.trim();
      if (!code) return ctx.reply("Foydalanish: /ochir KOD");
      const res = await db.movie.deleteMany({ where: { botId: ctx.botId, code } });
      await ctx.reply(res.count > 0 ? `🗑 "${code}" o'chirildi.` : "Bunday kod topilmadi.");
    });

    bot.hears("🎬 Kinolar ro'yxati", async (ctx) => {
      const movies = await db.movie.findMany({
        where: { botId: ctx.botId, isActive: true },
        orderBy: { views: "desc" },
        take: 30,
      });
      if (movies.length === 0) return ctx.reply("Hozircha kino qo'shilmagan.");
      const lines = movies.map((m) => `<code>${esc(m.code)}</code> — ${esc(m.title)}`);
      await ctx.reply(
        `🎬 <b>Kinolar (${movies.length})</b>\n\n${lines.join("\n")}\n\n` +
          `<i>Kodni yuboring — kino keladi.</i>`,
        { parse_mode: "HTML" },
      );
    });

    bot.hears("ℹ️ Qanday ishlaydi", (ctx) =>
      ctx.reply(
        `ℹ️ <b>Qanday ishlaydi</b>\n\n` +
          `1. «🎬 Kinolar ro'yxati» dan kerakli kinoning <b>kodini</b> toping\n` +
          `2. Kodni shu yerga yuboring\n` +
          `3. Kino darhol keladi\n\n` +
          `<i>Kod odatda raqam bo'ladi, masalan 100.</i>`,
        { parse_mode: "HTML" },
      ),
    );

    // ------------------------------------------------------- admin wizards

    bot.on(["message:video", "message:document", "message:animation"], async (ctx, next) => {
      if (!ctx.isAdmin) return next();
      const state = getStep(SCOPE, ctx.from!.id);
      if (state?.step !== "await_file") return next();

      const video = ctx.message.video;
      const doc = ctx.message.document;
      const anim = ctx.message.animation;
      const fileId = video?.file_id ?? anim?.file_id ?? doc?.file_id;
      const fileType = video ? "video" : anim ? "animation" : "document";
      if (!fileId) return;

      setStep(SCOPE, ctx.from!.id, "await_code", { fileId, fileType });
      await ctx.reply("2-qadam: bu kinoga kod bering (masalan <code>100</code>)", { parse_mode: "HTML" });
    });

    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();

      // --- admin wizard steps take priority over movie lookup
      if (ctx.isAdmin) {
        const state = getStep(SCOPE, ctx.from!.id);

        if (state?.step === "await_code") {
          const exists = await db.movie.findFirst({ where: { botId: ctx.botId, code: text } });
          if (exists) return ctx.reply("Bu kod band. Boshqa kod kiriting.");
          setStep(SCOPE, ctx.from!.id, "await_title", { code: text });
          return ctx.reply("3-qadam: kino nomini yuboring.");
        }

        if (state?.step === "await_title") {
          await db.movie.create({
            data: {
              botId: ctx.botId,
              code: state.data.code as string,
              title: text,
              fileId: state.data.fileId as string,
              fileType: state.data.fileType as string,
            },
          });
          clearStep(SCOPE, ctx.from!.id);
          return ctx.reply(
            `✅ Qo'shildi!\n\nKod: <code>${esc(state.data.code as string)}</code>\nNom: ${esc(text)}`,
            { parse_mode: "HTML" },
          );
        }
      }

      // --- everyone else: the text is a movie code
      const missing = await missingChannels(ctx);
      if (missing.length > 0) return askToSubscribe(ctx, missing, "kino:check");

      const found = await sendMovie(ctx, text);
      if (!found) {
        await ctx.reply("❌ Bunday kod topilmadi. Kodni tekshirib qayta yuboring.");
      }
    });
  },
};

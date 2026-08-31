import { InlineKeyboard, InputFile, Keyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "survey";
const ADMIN = "survey_admin";
const DEFAULT_WELCOME = "📋 Salom! Bir necha savolga javob bering — ko'p vaqtingizni olmaydi.";

async function activeSurvey(botId: string) {
  return db.survey.findFirst({
    where: { botId, isActive: true },
    include: { questions: { orderBy: { order: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
}

async function askQuestion(ctx: BotCtx, surveyId: string, index: number) {
  const survey = await db.survey.findUnique({
    where: { id: surveyId },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  const question = survey?.questions[index];
  if (!survey || !question) return finish(ctx, surveyId);

  const options = JSON.parse(question.options) as string[];
  const keyboard =
    question.type === "choice" && options.length > 0
      ? new Keyboard(options.map((o) => [{ text: o }])).resized().oneTime()
      : question.type === "phone"
        ? new Keyboard().requestContact("📞 Raqamni yuborish").resized().oneTime()
        : { remove_keyboard: true as const };

  setStep(SCOPE, ctx.from!.id, "answering", { surveyId, index });
  await ctx.reply(`<b>${index + 1}/${survey.questions.length}.</b> ${esc(question.prompt)}`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

async function record(ctx: BotCtx, value: string) {
  const state = getStep(SCOPE, ctx.from!.id);
  if (!state || state.step !== "answering") return false;

  const surveyId = state.data.surveyId as string;
  const index = state.data.index as number;
  const answers = ((state.data.answers as Record<string, string>) ?? {}) as Record<string, string>;

  const survey = await db.survey.findUnique({
    where: { id: surveyId },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  const question = survey?.questions[index];
  if (!survey || !question) return false;

  if (question.type === "number" && !/^\d+$/.test(value.replace(/\s/g, ""))) {
    await ctx.reply("Iltimos, faqat raqam kiriting.");
    return true;
  }

  answers[question.prompt] = value;
  setStep(SCOPE, ctx.from!.id, "answering", { answers, index: index + 1 });

  if (index + 1 >= survey.questions.length) await finish(ctx, surveyId);
  else await askQuestion(ctx, surveyId, index + 1);
  return true;
}

async function finish(ctx: BotCtx, surveyId: string) {
  const state = getStep(SCOPE, ctx.from!.id);
  const answers = (state?.data.answers as Record<string, string>) ?? {};
  clearStep(SCOPE, ctx.from!.id);

  await db.surveyResponse.create({
    data: { surveyId, botUserId: ctx.appUser.id, answers: JSON.stringify(answers) },
  });

  await ctx.reply("✅ Rahmat! Javoblaringiz qabul qilindi.", { reply_markup: { remove_keyboard: true } });
}

function toCsv(rows: Record<string, string>[]): string {
  if (rows.length === 0) return "";
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  return [headers.map(escape).join(","), ...rows.map((r) => headers.map((h) => escape(r[h] ?? "")).join(","))].join(
    "\n",
  );
}

export const surveyTemplate: BotTemplate = {
  key: "survey",
  emoji: "📋",
  name: "Anketa boti",
  tagline: "Savol bering, javoblarni Excel'ga yuklab oling",
  description:
    "Savollar ro'yxatini tuzasiz, foydalanuvchi bosqichma-bosqich javob beradi. Barcha javoblarni " +
    "istalgan vaqt CSV fayl qilib yuklab olasiz — Excel'da ochiladi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },
  commands: [
    { command: "start", description: "Boshlash" },
    { command: "anketa", description: "Anketani boshlash" },
  ],

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      const survey = await activeSurvey(ctx.botId);
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, {
        reply_markup: ctx.isAdmin ? new InlineKeyboard().text("⚙️ Admin panel", "adm:menu") : undefined,
      });

      if (!survey || survey.questions.length === 0) {
        if (ctx.isAdmin) await ctx.reply("Hali savol qo'shilmagan. /admin → ➕ Savol qo'shish");
        return;
      }

      const already = await db.surveyResponse.findFirst({
        where: { surveyId: survey.id, botUserId: ctx.appUser.id },
      });
      if (already && !survey.multiple) {
        return ctx.reply("Siz allaqachon javob bergansiz. Rahmat! 🙌");
      }

      await askQuestion(ctx, survey.id, 0);
    });

    bot.on("message:contact", async (ctx, next) => {
      const handled = await record(ctx, ctx.message.contact.phone_number);
      if (!handled) return next();
    });

    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();

      if (ctx.isAdmin) {
        const admin = getStep(ADMIN, ctx.from!.id);

        if (admin?.step === "await_q_prompt") {
          const survey =
            (await activeSurvey(ctx.botId)) ??
            (await db.survey.create({
              data: { botId: ctx.botId, title: "Anketa" },
              include: { questions: true },
            }));
          const count = await db.surveyQuestion.count({ where: { surveyId: survey.id } });
          await db.surveyQuestion.create({
            data: { surveyId: survey.id, order: count, type: "text", prompt: text },
          });
          clearStep(ADMIN, ctx.from!.id);
          return ctx.reply(`✅ ${count + 1}-savol qo'shildi.\n\nYana qo'shish: /admin → ➕ Savol`);
        }
      }

      const handled = await record(ctx, text);
      if (!handled) return next();
    });

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "q_add",
        label: "➕ Savol",
        handler: async (ctx) => {
          setStep(ADMIN, ctx.from!.id, "await_q_prompt");
          await ctx.editMessageText(
            "➕ <b>Savol qo'shish</b>\n\nSavol matnini yuboring.\n\nBekor: /bekor",
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
            },
          ).catch(() => {});
        },
      },
      {
        id: "q_list",
        label: "📃 Savollar",
        handler: async (ctx) => {
          const survey = await activeSurvey(ctx.botId);
          const lines = (survey?.questions ?? []).map((q, i) => `${i + 1}. ${esc(q.prompt)}`);
          await ctx.editMessageText(
            `📃 <b>Savollar</b>\n\n${lines.join("\n") || "Hali savol yo'q."}\n\nHammasini o'chirish: /tozala`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
          ).catch(() => {});
        },
      },
      {
        id: "export",
        label: "📥 Javoblarni yuklash",
        handler: async (ctx) => {
          const survey = await activeSurvey(ctx.botId);
          if (!survey) return void ctx.answerCallbackQuery("Anketa yo'q");

          const responses = await db.surveyResponse.findMany({
            where: { surveyId: survey.id },
            include: { botUser: true },
            orderBy: { completedAt: "asc" },
          });
          if (responses.length === 0) {
            return void ctx.editMessageText("Hali javob yo'q.", {
              reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
            });
          }

          const rows = responses.map((r) => ({
            Sana: r.completedAt.toISOString().slice(0, 19).replace("T", " "),
            Ism: r.botUser.firstName ?? "",
            Username: r.botUser.username ?? "",
            ...(JSON.parse(r.answers) as Record<string, string>),
          }));

          // BOM so Excel opens UTF-8 correctly on Windows.
          const csv = "﻿" + toCsv(rows);
          await ctx.replyWithDocument(new InputFile(Buffer.from(csv, "utf8"), "javoblar.csv"), {
            caption: `📥 ${responses.length} ta javob`,
          });
        },
      },
    ]);

    bot.command("tozala", async (ctx) => {
      if (!ctx.isAdmin) return;
      const survey = await activeSurvey(ctx.botId);
      if (!survey) return;
      await db.surveyQuestion.deleteMany({ where: { surveyId: survey.id } });
      await ctx.reply("🗑 Barcha savollar o'chirildi.");
    });
  },
};

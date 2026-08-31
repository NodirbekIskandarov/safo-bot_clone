import { InlineKeyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "faq";
const DEFAULT_WELCOME =
  "🤖 Salom! Savolingizni yozing yoki quyidagi ro'yxatdan tanlang — darhol javob beraman.";

export const faqTemplate: BotTemplate = {
  key: "faq",
  emoji: "🤖",
  name: "Savol-javob boti",
  tagline: "Takrorlanuvchi savollarga o'zi javob beradi",
  description:
    "Savol va javoblar ro'yxatini kiritasiz. Mijoz savol yozsa bot kalit so'zlar bo'yicha mos " +
    "javobni topib beradi. Topolmasa — ro'yxatni ko'rsatadi. Xodimning vaqtini tejaydi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },
  commands: [
    { command: "start", description: "Boshlash" },
    { command: "savollar", description: "Barcha savollar" },
  ],

  register({ bot }: TemplateContext) {
    const listKeyboard = async (botId: string) => {
      const items = await db.faqItem.findMany({
        where: { botId, isActive: true },
        orderBy: { sortOrder: "asc" },
        take: 20,
      });
      const kb = new InlineKeyboard();
      for (const i of items) kb.text(i.question.slice(0, 60), `faq:a:${i.id}`).row();
      return { kb, count: items.length };
    };

    bot.command("start", async (ctx) => {
      const { kb, count } = await listKeyboard(ctx.botId);
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, {
        reply_markup: count > 0 ? kb : ctx.isAdmin ? new InlineKeyboard().text("⚙️ Admin panel", "adm:menu") : undefined,
      });
    });

    bot.callbackQuery(/^faq:a:(.+)$/, async (ctx) => {
      const item = await db.faqItem.findFirst({ where: { id: ctx.match[1]!, botId: ctx.botId } });
      if (!item) return ctx.answerCallbackQuery("Topilmadi");
      await ctx.answerCallbackQuery();
      await db.faqItem.update({ where: { id: item.id }, data: { hits: { increment: 1 } } });
      await ctx.reply(`<b>${esc(item.question)}</b>\n\n${esc(item.answer)}`, { parse_mode: "HTML" });
    });

registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "faq_add",
        label: "➕ Savol-javob",
        handler: async (ctx) => {
          setStep(SCOPE, ctx.from!.id, "await_q");
          await ctx.editMessageText(
            "➕ <b>Yangi savol</b>\n\n1-qadam: savol matnini yuboring.\n\nBekor: /bekor",
            {
              parse_mode: "HTML",
              reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
            },
          ).catch(() => {});
        },
      },
      {
        id: "faq_list",
        label: "📃 Ro'yxat",
        handler: async (ctx) => {
          const items = await db.faqItem.findMany({
            where: { botId: ctx.botId },
            orderBy: { hits: "desc" },
            take: 20,
          });
          const lines = items.map((i, n) => `${n + 1}. ${esc(i.question)} — 👁 ${i.hits}`);
          await ctx.editMessageText(
            `📃 <b>Savollar: ${items.length}</b>\n\n${lines.join("\n") || "Hali yo'q."}\n\n` +
              `Hammasini o'chirish: /tozala`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
          ).catch(() => {});
        },
      },
    ]);

    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();

      if (ctx.isAdmin) {
        const state = getStep(SCOPE, ctx.from!.id);
        if (state?.step === "await_q") {
          setStep(SCOPE, ctx.from!.id, "await_a", { question: text });
          return ctx.reply("2-qadam: shu savolga javobni yuboring.");
        }
        if (state?.step === "await_a") {
          const question = state.data.question as string;
          const count = await db.faqItem.count({ where: { botId: ctx.botId } });
          await db.faqItem.create({
            data: {
              botId: ctx.botId, question, answer: text, sortOrder: count,
              keywords: question.toLowerCase(),
            },
          });
          clearStep(SCOPE, ctx.from!.id);
          return ctx.reply(`✅ Qo'shildi: <b>${esc(question)}</b>`, { parse_mode: "HTML" });
        }
      }

      // keyword match: every word of the query is looked for in the stored text
      const needle = text.toLowerCase();
      const items = await db.faqItem.findMany({ where: { botId: ctx.botId, isActive: true } });
      const scored = items
        .map((i) => {
          const hay = `${i.question} ${i.keywords}`.toLowerCase();
          const words = needle.split(/\s+/).filter((w) => w.length > 2);
          const score = words.filter((w) => hay.includes(w)).length;
          return { item: i, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) {
        await db.faqItem.update({ where: { id: best.item.id }, data: { hits: { increment: 1 } } });
        return ctx.reply(`<b>${esc(best.item.question)}</b>\n\n${esc(best.item.answer)}`, { parse_mode: "HTML" });
      }

      const { kb, count } = await listKeyboard(ctx.botId);
      await ctx.reply(
        count > 0
          ? "🤔 Aniq javob topolmadim. Quyidagilardan tanlang:"
          : "🤔 Hozircha javoblar bazasi bo'sh.",
        { reply_markup: count > 0 ? kb : undefined },
      );
    });


    bot.command("tozala", async (ctx) => {
      if (!ctx.isAdmin) return;
      await db.faqItem.deleteMany({ where: { botId: ctx.botId } });
      await ctx.reply("🗑 Barcha savollar o'chirildi.");
    });
  },
};

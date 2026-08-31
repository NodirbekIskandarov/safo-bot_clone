import { InlineKeyboard } from "grammy";
import { db } from "../../db.js";
import { esc } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { mainKeyboard } from "../../runtime/keyboard.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotTemplate, TemplateContext } from "../../runtime/context.js";

const DEFAULT_WELCOME =
  "Assalomu alaykum! 👋\n\nYangiliklar va e'lonlardan birinchi bo'lib xabardor bo'lish uchun botga obuna bo'ldingiz.";

export const broadcastTemplate: BotTemplate = {
  key: "broadcast",
  emoji: "📢",
  name: "Reklama boti",
  tagline: "Obunachilar yig'ing, hammasiga bir tugmada xabar yuboring",
  description:
    "Foydalanuvchilar botga /start bosadi va obunachiga aylanadi. Siz istalgan vaqtda hammasiga " +
    "matn, rasm, video yoki fayl yuborasiz. Kim bloklagani, kimga yetib borgani hisobot bo'lib qaytadi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },  menuButtons: [["ℹ️ Ma'lumot"], ["🔕 Obunani bekor qilish"]],

  commands: [
    { command: "start", description: "Boshlash" },
    { command: "stop", description: "Obunani bekor qilish" },
  ],

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      const welcome = (ctx.settings.welcome as string) || DEFAULT_WELCOME;
      await ctx.reply(welcome, { reply_markup: await mainKeyboard(ctx, [["ℹ️ Ma'lumot"], ["🔕 Obunani bekor qilish"]]) });
      await db.botEvent.create({ data: { botId: ctx.botId, botUserId: ctx.appUser.id, type: "start" } });
    });

    bot.command("stop", async (ctx) => {
      await db.botUser.update({ where: { id: ctx.appUser.id }, data: { status: "unsubscribed" } });
      await ctx.reply("Obuna bekor qilindi. Qaytish uchun /start bosing.");
    });

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "welcome",
        label: "✏️ Salomlashuv matni",
        handler: async (ctx) => {
          await ctx.editMessageText(
            `✏️ <b>Salomlashuv matni</b>\n\nHozirgi matn:\n\n<i>${esc(
              (ctx.settings.welcome as string) || DEFAULT_WELCOME,
            )}</i>\n\nO'zgartirish uchun platforma botidagi «Sozlamalar» bo'limidan foydalaning.`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
          ).catch(() => {});
        },
      },
    ]);

    bot.hears("ℹ️ Ma'lumot", (ctx) =>
      ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME),
    );

    bot.hears("🔕 Obunani bekor qilish", async (ctx) => {
      await db.botUser.update({ where: { id: ctx.appUser.id }, data: { status: "unsubscribed" } });
      await ctx.reply("Obuna bekor qilindi. Qaytish uchun /start bosing.", {
        reply_markup: { remove_keyboard: true },
      });
    });

    bot.on("message", async (ctx, next) => {
      if (ctx.isAdmin) return next();
      await ctx.reply("Xabaringiz uchun rahmat! Yangiliklarni kuting 🙌");
    });
  },
};

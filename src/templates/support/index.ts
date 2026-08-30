import { InlineKeyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc, sendSafe } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "support";
const DEFAULT_WELCOME =
  "👋 Salom! Savolingiz yoki taklifingiz bo'lsa shu yerga yozing — operatorlarimiz javob beradi.";

async function openTicket(ctx: BotCtx) {
  const existing = await db.ticket.findFirst({
    where: { botId: ctx.botId, botUserId: ctx.appUser.id, status: { in: ["open", "answered"] } },
  });
  if (existing) return existing;

  const last = await db.ticket.findFirst({
    where: { botId: ctx.botId },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return db.ticket.create({
    data: { botId: ctx.botId, botUserId: ctx.appUser.id, number: (last?.number ?? 0) + 1 },
  });
}

export const supportTemplate: BotTemplate = {
  key: "support",
  emoji: "💬",
  name: "Aloqa boti",
  tagline: "Mijoz yozadi — siz javob berasiz, hammasi bitta joyda",
  description:
    "Mijoz botga savol yozadi, sizga darhol keladi. Javobingiz mijozga qaytadi — u sizning " +
    "shaxsiy raqamingizni bilmaydi. Har bir murojaat tiket raqami bilan saqlanadi.",
  defaultSettings: { welcome: DEFAULT_WELCOME },

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, {
        reply_markup: ctx.isAdmin ? new InlineKeyboard().text("⚙️ Admin panel", "adm:menu") : undefined,
      });
    });


    registerAdmin(bot, [
      {
        id: "tickets",
        label: "💬 Murojaatlar",
        handler: async (ctx) => {
          const open = await db.ticket.findMany({
            where: { botId: ctx.botId, status: { in: ["open", "answered"] } },
            include: { botUser: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
            orderBy: { lastMsgAt: "desc" },
            take: 10,
          });
          const lines = open.map((t) => {
            const mark = t.status === "open" ? "🔴" : "🟡";
            const last = t.messages[0]?.text?.slice(0, 30) ?? "";
            return `${mark} #${t.number} ${esc(t.botUser.firstName ?? "")} — <i>${esc(last)}</i>`;
          });
          await ctx.editMessageText(
            `💬 <b>Ochiq murojaatlar: ${open.length}</b>\n\n${lines.join("\n") || "Hammasi yopilgan 🎉"}`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
          );
        },
      },
    ]);

    // ---- admin replies by replying to the forwarded message
    bot.on("message", async (ctx, next) => {
      if (!ctx.isAdmin) return next();

      const state = getStep(SCOPE, ctx.from!.id);
      if (state?.step === "replying") {
        const ticketId = state.data.ticketId as string;
        const ticket = await db.ticket.findUnique({ where: { id: ticketId }, include: { botUser: true } });
        if (!ticket) return void clearStep(SCOPE, ctx.from!.id);

        const text = ctx.message.text ?? ctx.message.caption ?? "";
        await db.ticketMessage.create({ data: { ticketId, fromAdmin: true, text } });
        await db.ticket.update({ where: { id: ticketId }, data: { status: "answered", lastMsgAt: new Date() } });
        clearStep(SCOPE, ctx.from!.id);

        const delivered = await sendSafe(
          () =>
            ctx.api.copyMessage(Number(ticket.botUser.tgUserId), ctx.chat!.id, ctx.message.message_id),
          { botId: ctx.botId, botUserId: ticket.botUserId },
        );
        return void ctx.reply(
          delivered === "sent" ? `✅ Javob #${ticket.number} ga yuborildi.` : "❌ Yetkazib bo'lmadi (bloklagan).",
        );
      }
      return next();
    });

    // ---- customer message becomes a ticket
    bot.on("message", async (ctx, next) => {
      if (ctx.isAdmin) return next();

      const ticket = await openTicket(ctx);
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      await db.ticketMessage.create({ data: { ticketId: ticket.id, text } });
      await db.ticket.update({ where: { id: ticket.id }, data: { status: "open", lastMsgAt: new Date() } });

      await ctx.reply(`✅ Qabul qilindi. Murojaat raqami: <b>#${ticket.number}</b>\n\nTez orada javob beramiz.`, {
        parse_mode: "HTML",
      });

      const header =
        `💬 <b>Murojaat #${ticket.number}</b>\n` +
        `👤 ${esc(ctx.appUser.firstName ?? "")}` +
        (ctx.appUser.username ? ` (@${esc(ctx.appUser.username)})` : "");

      const admins = await db.botUser.findMany({ where: { botId: ctx.botId, isAdmin: true } });
      for (const admin of admins) {
        await sendSafe(
          () => ctx.api.sendMessage(Number(admin.tgUserId), header, { parse_mode: "HTML" }),
          { botId: ctx.botId, botUserId: admin.id },
        );
        await sendSafe(
          () =>
            ctx.api.copyMessage(Number(admin.tgUserId), ctx.chat!.id, ctx.message.message_id, {
              reply_markup: new InlineKeyboard()
                .text("✍️ Javob berish", `sup:re:${ticket.id}`)
                .text("✅ Yopish", `sup:cl:${ticket.id}`),
            }),
          { botId: ctx.botId, botUserId: admin.id },
        );
      }
    });

    bot.callbackQuery(/^sup:re:(.+)$/, async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      await ctx.answerCallbackQuery();
      setStep(SCOPE, ctx.from!.id, "replying", { ticketId: ctx.match[1] });
      await ctx.reply("✍️ Javobingizni yozing (matn, rasm, fayl — hammasi bo'ladi).\n\nBekor: /bekor");
    });

    bot.callbackQuery(/^sup:cl:(.+)$/, async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      await db.ticket.update({ where: { id: ctx.match[1]! }, data: { status: "closed" } });
      await ctx.answerCallbackQuery("Yopildi");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    });

    bot.command("bekor", async (ctx) => {
      if (ctx.isAdmin) clearStep(SCOPE, ctx.from!.id);
    });

  },
};

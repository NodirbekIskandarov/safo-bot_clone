import { InlineKeyboard, Keyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc, sendSafe } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";

const SCOPE = "booking";
const DEFAULT_WELCOME = "📅 Salom! Navbatga yozilish uchun «Navbat olish» tugmasini bosing.";
const DEFAULT_SERVICES = ["Soch olish", "Soqol olish", "Maslahat"];

function services(ctx: BotCtx): string[] {
  const raw = ctx.settings.services;
  return Array.isArray(raw) && raw.length > 0 ? (raw as string[]) : DEFAULT_SERVICES;
}

/** Next 7 days, skipping today once the working day is over. */
function upcomingDays(): { label: string; date: Date }[] {
  const names = ["Yakshanba", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
  const out: { label: string; date: Date }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const label = i === 0 ? "Bugun" : i === 1 ? "Ertaga" : `${d.getDate()}-kun, ${names[d.getDay()]}`;
    out.push({ label, date: d });
  }
  return out;
}

const SLOTS = ["09:00", "10:00", "11:00", "12:00", "14:00", "15:00", "16:00", "17:00", "18:00"];

export const bookingTemplate: BotTemplate = {
  key: "booking",
  emoji: "📅",
  name: "Navbat boti",
  tagline: "Mijoz o'zi navbat oladi — telefon jiringlamaydi",
  description:
    "Sartaroshxona, klinika, avtoyuvish, ustaxona uchun. Mijoz xizmat turini, kunni va soatni " +
    "tanlaydi, telefonini qoldiradi. Sizga xabar keladi, bir tugmada tasdiqlaysiz. Band vaqtlar ko'rinmaydi.",
  defaultSettings: { welcome: DEFAULT_WELCOME, services: DEFAULT_SERVICES },
  commands: [
    { command: "start", description: "Boshlash" },
    { command: "navbat", description: "Navbat olish" },
    { command: "mening", description: "Mening navbatlarim" },
  ],

  register({ bot }: TemplateContext) {
    const mainKb = new Keyboard().text("📅 Navbat olish").text("🗓 Mening navbatlarim").resized();

    bot.command("start", async (ctx) => {
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, { reply_markup: mainKb });
      if (ctx.isAdmin) await ctx.reply("Admin panel: /admin");
    });

    bot.hears("📅 Navbat olish", async (ctx) => {
      const kb = new InlineKeyboard();
      services(ctx).forEach((s, i) => kb.text(s, `bk:s:${i}`).row());
      await ctx.reply("Qaysi xizmat kerak?", { reply_markup: kb });
    });

    bot.hears("🗓 Mening navbatlarim", async (ctx) => {
      const list = await db.booking.findMany({
        where: { botId: ctx.botId, botUserId: ctx.appUser.id, status: { in: ["new", "confirmed"] } },
        orderBy: { slotAt: "asc" },
      });
      if (list.length === 0) return ctx.reply("Sizda navbat yo'q.");
      const lines = list.map(
        (b) =>
          `#${b.number} — ${esc(b.service)}\n   📅 ${b.slotAt.toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" })} — ${b.status === "confirmed" ? "✅ tasdiqlangan" : "⏳ kutilmoqda"}`,
      );
      await ctx.reply(`🗓 <b>Navbatlaringiz</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
    });

    bot.callbackQuery(/^bk:s:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const service = services(ctx)[Number(ctx.match[1])];
      if (!service) return;
      setStep(SCOPE, ctx.from!.id, "day", { service });

      const kb = new InlineKeyboard();
      upcomingDays().forEach((d, i) => {
        kb.text(d.label, `bk:d:${i}`);
        if (i % 2 === 1) kb.row();
      });
      await ctx.editMessageText(`<b>${esc(service)}</b>\n\nQaysi kun?`, { parse_mode: "HTML", reply_markup: kb });
    });

    bot.callbackQuery(/^bk:d:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const day = upcomingDays()[Number(ctx.match[1])];
      const state = getStep(SCOPE, ctx.from!.id);
      if (!day || !state) return;
      setStep(SCOPE, ctx.from!.id, "slot", { dayIso: day.date.toISOString() });

      const dayEnd = new Date(day.date);
      dayEnd.setHours(23, 59, 59);
      const taken = await db.booking.findMany({
        where: { botId: ctx.botId, slotAt: { gte: day.date, lte: dayEnd }, status: { not: "canceled" } },
        select: { slotAt: true },
      });
      const takenTimes = new Set(
        taken.map((t) => `${String(t.slotAt.getHours()).padStart(2, "0")}:${String(t.slotAt.getMinutes()).padStart(2, "0")}`),
      );

      const now = new Date();
      const free = SLOTS.filter((s) => {
        if (takenTimes.has(s)) return false;
        const [h, m] = s.split(":").map(Number);
        const slot = new Date(day.date);
        slot.setHours(h!, m!, 0, 0);
        return slot > now;
      });

      if (free.length === 0) {
        return void ctx.editMessageText("Bu kunda bo'sh vaqt qolmadi. Boshqa kunni tanlang.", {
          reply_markup: new InlineKeyboard().text("◀️ Orqaga", "bk:back"),
        });
      }

      const kb = new InlineKeyboard();
      free.forEach((s, i) => {
        kb.text(s, `bk:t:${s}`);
        if (i % 3 === 2) kb.row();
      });
      await ctx.editMessageText(`<b>${esc(day.label)}</b>\n\nSoatni tanlang (band vaqtlar ko'rsatilmagan):`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    });

    bot.callbackQuery("bk:back", async (ctx) => {
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard();
      upcomingDays().forEach((d, i) => {
        kb.text(d.label, `bk:d:${i}`);
        if (i % 2 === 1) kb.row();
      });
      await ctx.editMessageText("Qaysi kun?", { reply_markup: kb });
    });

    bot.callbackQuery(/^bk:t:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const state = getStep(SCOPE, ctx.from!.id);
      if (!state?.data.dayIso) return;
      setStep(SCOPE, ctx.from!.id, "phone", { time: ctx.match[1] });
      await ctx.editMessageText("Oxirgi qadam: telefon raqamingiz kerak.");
      await ctx.reply("📞 Raqamingizni yuboring:", {
        reply_markup: new Keyboard().requestContact("📞 Raqamni yuborish").resized().oneTime(),
      });
    });

    async function createBooking(ctx: BotCtx, phone: string) {
      const state = getStep(SCOPE, ctx.from!.id);
      if (!state) return;

      const day = new Date(state.data.dayIso as string);
      const [h, m] = (state.data.time as string).split(":").map(Number);
      day.setHours(h!, m!, 0, 0);

      const last = await db.booking.findFirst({
        where: { botId: ctx.botId },
        orderBy: { number: "desc" },
        select: { number: true },
      });

      const booking = await db.booking.create({
        data: {
          botId: ctx.botId, botUserId: ctx.appUser.id, number: (last?.number ?? 0) + 1,
          service: state.data.service as string, slotAt: day, phone,
        },
      });
      clearStep(SCOPE, ctx.from!.id);

      const when = day.toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" });
      await ctx.reply(
        `✅ <b>Navbat olindi!</b>\n\n#${booking.number}\n💈 ${esc(booking.service)}\n📅 ${when}\n\n` +
          `Tasdiqlangach xabar beramiz.`,
        { parse_mode: "HTML", reply_markup: mainKb },
      );

      const admins = await db.botUser.findMany({ where: { botId: ctx.botId, isAdmin: true } });
      const body =
        `📅 <b>Yangi navbat #${booking.number}</b>\n\n` +
        `💈 ${esc(booking.service)}\n📅 ${when}\n📞 ${esc(phone)}\n` +
        `👤 ${esc(ctx.appUser.firstName ?? "")}${ctx.appUser.username ? ` (@${esc(ctx.appUser.username)})` : ""}`;
      const kb = new InlineKeyboard()
        .text("✅ Tasdiqlash", `bk:st:confirmed:${booking.id}`)
        .text("❌ Bekor", `bk:st:canceled:${booking.id}`);

      for (const admin of admins) {
        await sendSafe(
          () => ctx.api.sendMessage(Number(admin.tgUserId), body, { parse_mode: "HTML", reply_markup: kb }),
          { botId: ctx.botId, botUserId: admin.id },
        );
      }
    }

    bot.on("message:contact", async (ctx, next) => {
      const state = getStep(SCOPE, ctx.from!.id);
      if (state?.step !== "phone") return next();
      await createBooking(ctx, ctx.message.contact.phone_number);
    });

    bot.on("message:text", async (ctx, next) => {
      const state = getStep(SCOPE, ctx.from!.id);
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();

      if (state?.step === "phone") return createBooking(ctx, text);

      if (ctx.isAdmin) {
        const admin = getStep(`${SCOPE}_admin`, ctx.from!.id);
        if (admin?.step === "await_services") {
          const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
          if (list.length === 0) return ctx.reply("Kamida bitta xizmat yozing.");
          const record = await db.bot.findUniqueOrThrow({ where: { id: ctx.botId } });
          const settings = JSON.parse(record.settings || "{}") as Record<string, unknown>;
          settings.services = list;
          await db.bot.update({ where: { id: ctx.botId }, data: { settings: JSON.stringify(settings) } });
          clearStep(`${SCOPE}_admin`, ctx.from!.id);
          return ctx.reply(
            `✅ ${list.length} ta xizmat saqlandi.\n\n<i>Yangi ro'yxat bot qayta yuklangach kuchga kiradi — platforma botidan botni o'chirib-yoqing.</i>`,
            { parse_mode: "HTML" },
          );
        }
      }
      return next();
    });

    bot.callbackQuery(/^bk:st:(\w+):(.+)$/, async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      const [, status, id] = ctx.match;
      const booking = await db.booking.update({
        where: { id: id! },
        data: { status: status! },
        include: { botUser: true },
      });
      await ctx.answerCallbackQuery("Yangilandi");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

      const when = booking.slotAt.toLocaleString("uz-UZ", { dateStyle: "short", timeStyle: "short" });
      const text =
        status === "confirmed"
          ? `✅ Navbatingiz tasdiqlandi!\n\n#${booking.number} — ${booking.service}\n📅 ${when}`
          : `❌ Navbatingiz bekor qilindi.\n\n#${booking.number} — ${when}`;
      await sendSafe(() => ctx.api.sendMessage(Number(booking.botUser.tgUserId), text), {
        botId: ctx.botId, botUserId: booking.botUserId,
      });
    });

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "bk_today",
        label: "📅 Bugungi navbatlar",
        handler: async (ctx) => {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          const end = new Date(start);
          end.setDate(end.getDate() + 1);

          const list = await db.booking.findMany({
            where: { botId: ctx.botId, slotAt: { gte: start, lt: end }, status: { not: "canceled" } },
            orderBy: { slotAt: "asc" },
          });
          const lines = list.map(
            (b) =>
              `${String(b.slotAt.getHours()).padStart(2, "0")}:${String(b.slotAt.getMinutes()).padStart(2, "0")} — ` +
              `${esc(b.service)} · ${esc(b.phone)}${b.status === "confirmed" ? " ✅" : " ⏳"}`,
          );
          await ctx.editMessageText(
            `📅 <b>Bugun: ${list.length} ta navbat</b>\n\n${lines.join("\n") || "Bo'sh kun."}`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu") },
          );
        },
      },
      {
        id: "bk_services",
        label: "💈 Xizmatlar",
        handler: async (ctx) => {
          setStep(`${SCOPE}_admin`, ctx.from!.id, "await_services");
          await ctx.editMessageText(
            `💈 <b>Xizmatlar ro'yxati</b>\n\nHozirgi:\n${services(ctx).map((s) => `• ${esc(s)}`).join("\n")}\n\n` +
              `O'zgartirish uchun har birini <b>yangi qatordan</b> yozib yuboring.\n\nBekor: /bekor`,
            { parse_mode: "HTML" },
          );
        },
      },
    ]);

    bot.command("bekor", async (ctx) => {
      clearStep(SCOPE, ctx.from!.id);
      clearStep(`${SCOPE}_admin`, ctx.from!.id);
    });
  },
};

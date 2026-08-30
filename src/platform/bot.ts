import { Api, Bot, InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import { config } from "../config.js";
import { db } from "../db.js";
import { fingerprint, seal } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { reloadBot, startBot, stopBot } from "../runtime/registry.js";
import { templateList, templates } from "../templates/index.js";
import { accessFor, openSubscription } from "../billing/subscription.js";
import { registerPlatformAdmin } from "./adminpanel.js";
import { registerPaymentReview, showInvoice, showPlansFor, submitReceipt } from "./payments.js";
import { isAdmin } from "./access.js";

const SCOPE = "platform";

const mainKeyboard = new Keyboard()
  .text("➕ Bot yaratish")
  .row()
  .text("🤖 Mening botlarim")
  .text("💳 Tariflar")
  .row()
  .text("❓ Yordam")
  .resized();

function templatePicker(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const t of templateList) kb.text(`${t.emoji} ${t.name}`, `p:tpl:${t.key}`).row();
  return kb;
}

async function ownerOf(ctx: Context) {
  const from = ctx.from!;
  return db.owner.upsert({
    where: { tgUserId: BigInt(from.id) },
    create: {
      tgUserId: BigInt(from.id),
      username: from.username ?? null,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
      isPlatformAdmin: config.platformAdminIds.includes(BigInt(from.id)),
    },
    update: {
      username: from.username ?? null,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
    },
  });
}

const WELCOME =
  `👋 <b>Salom!</b>\n\n` +
  `Men orqali <b>dasturchisiz</b> Telegram bot yaratasiz.\n\n` +
  `Tayyor shablon tanlaysiz, @BotFather'dan olingan tokenni yuborasiz — bot 2 daqiqada ishlay boshlaydi.\n\n` +
  `Boshlash uchun «➕ Bot yaratish» tugmasini bosing.`;

const HELP =
  `❓ <b>Yordam</b>\n\n` +
  `<b>1. Token qanday olinadi?</b>\n` +
  `• Telegram'da @BotFather ni oching\n` +
  `• <code>/newbot</code> yuboring\n` +
  `• Bot nomini yozing (masalan: Mening Kinom)\n` +
  `• Username o'ylab toping — <b>bot</b> bilan tugashi shart (masalan: mening_kino_bot)\n` +
  `• BotFather sizga tokenni beradi — shuni menga yuboring\n\n` +
  `<b>2. Botimni qanday boshqaraman?</b>\n` +
  `O'z botingizni oching va <code>/admin</code> yuboring. Kino qo'shish, mahsulot qo'shish, ` +
  `xabar yuborish, statistika — hammasi o'sha yerda.\n\n` +
  `<b>3. Token xavfsizmi?</b>\n` +
  `Token shifrlangan holda saqlanadi va hech qayerda ko'rsatilmaydi. Siz yuborgan xabar ` +
  `darhol o'chiriladi.\n\n` +
  `<b>4. Necha pul turadi?</b>\n` +
  `Birinchi bot <b>7 kun bepul</b> ishlaydi — karta talab qilinmaydi. Keyin tarif tanlaysiz, ` +
  `narxlar «💳 Tariflar» bo'limida. To'lov karta orqali, chekni botga tashlaysiz.\n\n` +
  `<b>5. Botni o'chirsam nima bo'ladi?</b>\n` +
  `Bot va uning barcha ma'lumotlari (foydalanuvchilar, kinolar, buyurtmalar) o'chadi. Bu qaytarilmaydi.`;

export function createPlatformBot(): Bot {
  const bot = new Bot(config.PLATFORM_BOT_TOKEN);

  // Registered first: their middleware must see a message before the generic
  // text handler below claims it.
  registerPlatformAdmin(bot);
  registerPaymentReview(bot);

  bot.command("start", async (ctx) => {
    await ownerOf(ctx);
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply(WELCOME, { parse_mode: "HTML", reply_markup: mainKeyboard });
  });

  bot.command("bekor", async (ctx) => {
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply("Bekor qilindi.", { reply_markup: mainKeyboard });
  });

  bot.hears("❓ Yordam", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));
  bot.command("yordam", (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

  // ------------------------------------------------------------- create bot

  bot.hears("➕ Bot yaratish", async (ctx) => {
    const owner = await ownerOf(ctx);
    const count = await db.bot.count({ where: { ownerId: owner.id } });
    if (count >= config.MAX_BOTS_PER_OWNER) {
      return ctx.reply(`Sizda allaqachon ${count} ta bot bor. Limit: ${config.MAX_BOTS_PER_OWNER}.`);
    }
    await ctx.reply("🧩 <b>1-qadam: shablon tanlang</b>\n\nBot nima ish qilishini tanlang:", {
      parse_mode: "HTML",
      reply_markup: templatePicker(),
    });
  });

  bot.callbackQuery(/^p:tpl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const template = templates[ctx.match[1]!];
    if (!template) return;

    setStep(SCOPE, ctx.from!.id, "await_token", { templateKey: template.key });
    await ctx.editMessageText(
      `${template.emoji} <b>${esc(template.name)}</b>\n\n${esc(template.description)}\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `🔑 <b>2-qadam: token yuboring</b>\n\n` +
        `1. @BotFather ni oching\n` +
        `2. <code>/newbot</code> yuboring\n` +
        `3. Bot nomi va usernameni kiriting\n` +
        `4. Olingan tokenni shu yerga tashlang\n\n` +
        `<i>Token shunday ko'rinadi:</i>\n<code>1234567890:AAF...xyz</code>\n\n` +
        `Bekor qilish: /bekor`,
      { parse_mode: "HTML" },
    );
  });

  // -------------------------------------------------------------- my bots

  bot.hears("💳 Tariflar", (ctx) => showTariffs(ctx));
  bot.callbackQuery("p:tariffs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTariffs(ctx, true);
  });

  async function showTariffs(ctx: Context, edit = false) {
    const plans = await db.plan.findMany({
      where: { isActive: true, isArchived: false },
      orderBy: { sortOrder: "asc" },
    });

    const line = (p: (typeof plans)[number]) => {
      const f = JSON.parse(p.features) as { orders: boolean; broadcastDailyLimit: number };
      const price = p.priceUzs === 0 ? "<b>bepul</b>" : `<b>${money(p.priceUzs)}</b>`;
      const days = p.priceUzs === 0 ? `${p.intervalDays} kun` : "oyiga";
      return (
        `${esc(p.name)} — ${price} / ${days}\n` +
        `   👥 ${p.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ")} obunachi · ` +
        `📢 ${f.broadcastDailyLimit} xabar/kun${f.orders ? " · 🛒 do'kon" : ""}`
      );
    };

    const group = (g: string) => plans.filter((p) => p.group === g).map(line).join("\n\n");

    const text =
      `💳 <b>Tariflar</b>\n\n` +
      `🎁 <b>Sinov</b>\n${group("trial")}\n` +
      `<i>Har bir akkauntga bir marta beriladi.</i>\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `📣 <b>Kontent botlari</b> <i>(kino, reklama, anketa)</i>\n\n${group("standard")}\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `🛒 <b>Biznes botlari</b> <i>(do'kon — buyurtma qabul qilish)</i>\n\n${group("business")}\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `To'lov karta orqali. Chekni yuborasiz, admin tasdiqlaydi — bot darhol ishlaydi.`;

    const kb = new InlineKeyboard().text("💳 To'lov qilish", "p:paypick");
    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  bot.callbackQuery("p:paypick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerOf(ctx);
    const bots = await db.bot.findMany({ where: { ownerId: owner.id }, orderBy: { createdAt: "asc" } });

    if (bots.length === 0) {
      return void ctx
        .editMessageText("Avval bot yarating — «➕ Bot yaratish».", {
          reply_markup: new InlineKeyboard().text("◀️ Tariflar", "p:tariffs"),
        })
        .catch(() => {});
    }
    if (bots.length === 1) return showPlansFor(ctx, bots[0]!.id);

    const kb = new InlineKeyboard();
    for (const b of bots) kb.text(`@${b.tgUsername}`, `p:pay:${b.id}`).row();
    kb.text("◀️ Orqaga", "p:tariffs");
    await ctx.editMessageText("Qaysi bot uchun to'lov qilasiz?", { reply_markup: kb });
  });

  bot.hears("🤖 Mening botlarim", (ctx) => listBots(ctx));

  async function listBots(ctx: Context, edit = false) {
    const owner = await ownerOf(ctx);
    const bots = await db.bot.findMany({ where: { ownerId: owner.id }, orderBy: { createdAt: "asc" } });

    if (bots.length === 0) {
      const text = "Sizda hali bot yo'q.\n\n«➕ Bot yaratish» tugmasini bosing.";
      return edit ? ctx.editMessageText(text).catch(() => {}) : ctx.reply(text);
    }

    const kb = new InlineKeyboard();
    for (const b of bots) {
      const mark = b.status === "active" ? "🟢" : b.status === "error" ? "🔴" : "⚪️";
      kb.text(`${mark} @${b.tgUsername}`, `p:bot:${b.id}`).row();
    }

    const text = `🤖 <b>Sizning botlaringiz: ${bots.length}</b>\n\nBoshqarish uchun tanlang:`;
    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  bot.callbackQuery("p:bots", async (ctx) => {
    await ctx.answerCallbackQuery();
    await listBots(ctx, true);
  });

  bot.callbackQuery(/^p:bot:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBot(ctx, ctx.match[1]!);
  });

  async function showBot(ctx: Context, botId: string) {
    const owner = await ownerOf(ctx);
    const record = await db.bot.findFirst({ where: { id: botId, ownerId: owner.id } });
    if (!record) return void ctx.editMessageText("Bot topilmadi.").catch(() => {});

    const template = templates[record.templateKey];
    const [users, today] = await Promise.all([
      db.botUser.count({ where: { botId } }),
      db.botUser.count({
        where: { botId, joinedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
    ]);

    const statusText =
      record.status === "active" ? "🟢 Ishlayapti" : record.status === "error" ? `🔴 Xato` : "⚪️ To'xtatilgan";

    const access = await accessFor(botId);
    let subLine = "";
    if (access) {
      const label: Record<string, string> = {
        trial: "🎁 Sinov muddati",
        active: "✅ To'langan",
        grace: "⚠️ Muddat tugadi",
        expired: "⛔️ To'lov kerak",
        unpaid: "⛔️ To'lov kerak",
      };
      subLine =
        `\n💳 Tarif: <b>${esc(access.planName)}</b> — ${label[access.status] ?? access.status}` +
        (access.daysLeft !== null && access.live ? ` (${access.daysLeft} kun qoldi)` : "") +
        `\n👤 Limit: ${users}/${access.maxBotUsers} obunachi`;
    }

    const kb = new InlineKeyboard();
    if (access && access.status !== "staff") {
      const label =
        access.status === "active" ? "💳 Muddatni uzaytirish" : "💳 To'lov qilish";
      kb.text(label, `p:pay:${botId}`).row();
    }
    kb.text("✏️ Salomlashuv matni", `p:text:${botId}`)
      .row()
      .text(record.status === "active" ? "⏸ To'xtatish" : "▶️ Ishga tushirish", `p:toggle:${botId}`)
      .text("🗑 O'chirish", `p:del:${botId}`)
      .row()
      .text("◀️ Orqaga", "p:bots");

    await ctx.editMessageText(
      `${template?.emoji ?? "🤖"} <b>@${esc(record.tgUsername)}</b>\n\n` +
        `Shablon: ${esc(template?.name ?? record.templateKey)}\n` +
        `Holat: ${statusText}` + subLine + `\n` +
        (record.lastError ? `<i>${esc(record.lastError.slice(0, 120))}</i>\n` : "") +
        `\n👥 Foydalanuvchilar: <b>${users}</b>\n🆕 Bugun: <b>${today}</b>\n\n` +
        `Kontent qo'shish uchun botingizni oching va <code>/admin</code> yuboring.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  }

  bot.callbackQuery(/^p:toggle:(.+)$/, async (ctx) => {
    const owner = await ownerOf(ctx);
    const botId = ctx.match[1]!;
    const record = await db.bot.findFirst({ where: { id: botId, ownerId: owner.id } });
    if (!record) return ctx.answerCallbackQuery("Topilmadi");

    if (record.status === "active") {
      await stopBot(botId);
      await db.bot.update({ where: { id: botId }, data: { status: "stopped" } });
      await ctx.answerCallbackQuery("To'xtatildi");
    } else {
      const access = await accessFor(botId);
      if (access && !access.live) {
        await ctx.answerCallbackQuery({
          text: "Obuna muddati tugagan. Avval to'lov qiling.",
          show_alert: true,
        });
        return;
      }
      const updated = await db.bot.update({
        where: { id: botId },
        data: { status: "active", lastError: null },
      });
      try {
        await startBot(updated);
        await ctx.answerCallbackQuery("Ishga tushdi");
      } catch (err) {
        await db.bot.update({
          where: { id: botId },
          data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
        });
        await ctx.answerCallbackQuery("Ishga tushmadi");
      }
    }
    await showBot(ctx, botId);
  });

  bot.callbackQuery(/^p:del:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      "🗑 <b>Botni o'chirish</b>\n\nBot va uning <b>barcha</b> ma'lumotlari o'chadi: foydalanuvchilar, " +
        "kinolar, mahsulotlar, buyurtmalar, javoblar.\n\n<b>Bu qaytarilmaydi.</b>",
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🗑 Ha, o'chirilsin", `p:delyes:${ctx.match[1]}`)
          .text("◀️ Yo'q", `p:bot:${ctx.match[1]}`),
      },
    );
  });

  bot.callbackQuery(/^p:delyes:(.+)$/, async (ctx) => {
    const owner = await ownerOf(ctx);
    const botId = ctx.match[1]!;
    const record = await db.bot.findFirst({ where: { id: botId, ownerId: owner.id } });
    if (!record) return ctx.answerCallbackQuery("Topilmadi");

    await stopBot(botId);
    await db.bot.delete({ where: { id: botId } });
    await ctx.answerCallbackQuery("O'chirildi");
    await ctx.editMessageText("🗑 Bot o'chirildi.");
    log.info("bot deleted", { botId, ownerId: owner.id });
  });

  bot.callbackQuery(/^p:pay:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPlansFor(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^pay:plan:([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showInvoice(ctx, ctx.match[1]!, ctx.match[2]!);
  });

  bot.callbackQuery(/^p:text:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    setStep(SCOPE, ctx.from!.id, "await_welcome", { botId: ctx.match[1] });
    await ctx.editMessageText(
      "✏️ <b>Salomlashuv matni</b>\n\nFoydalanuvchi /start bosganda ko'rinadigan matnni yuboring.\n\nBekor: /bekor",
      { parse_mode: "HTML" },
    );
  });

  // ------------------------------------------------------------ text input

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await submitReceipt(ctx, bot.api, { fileId: photo.file_id, text: ctx.message.caption });
  });

  bot.on("message:text", async (ctx) => {
    const state = getStep(SCOPE, ctx.from!.id);
    const text = ctx.message.text.trim();
    if (!state || text.startsWith("/")) return;

    if (state.step === "await_receipt") {
      await submitReceipt(ctx, bot.api, { text });
      return;
    }

    if (state.step === "await_welcome") {
      const owner = await ownerOf(ctx);
      const botId = state.data.botId as string;
      const record = await db.bot.findFirst({ where: { id: botId, ownerId: owner.id } });
      if (!record) return;

      const settings = JSON.parse(record.settings || "{}") as Record<string, unknown>;
      settings.welcome = text;
      await db.bot.update({ where: { id: botId }, data: { settings: JSON.stringify(settings) } });
      clearStep(SCOPE, ctx.from!.id);
      await reloadBot(botId);
      return ctx.reply("✅ Matn yangilandi. Botingizda darhol kuchga kirdi.", { reply_markup: mainKeyboard });
    }

    if (state.step === "await_token") {
      await handleToken(ctx, text, state.data.templateKey as string);
    }
  });

  async function handleToken(ctx: Context, token: string, templateKey: string) {
    // The token must not linger in chat history.
    await ctx.deleteMessage().catch(() => {});

    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
      return ctx.reply("❌ Bu token formatiga o'xshamaydi. @BotFather bergan qatorni to'liq nusxalab yuboring.");
    }

    const owner = await ownerOf(ctx);
    const hash = fingerprint(token);

    const duplicate = await db.bot.findUnique({ where: { tokenHash: hash } });
    if (duplicate) {
      return ctx.reply("❌ Bu token allaqachon ishlatilgan. Boshqa bot yarating yoki eskisini o'chiring.");
    }

    const status = await ctx.reply("⏳ Tokenni tekshiryapman…");

    let me: Awaited<ReturnType<Api["getMe"]>>;
    try {
      me = await new Api(token).getMe();
    } catch {
      return ctx.api
        .editMessageText(
          status.chat.id,
          status.message_id,
          "❌ Token ishlamadi. @BotFather'dan yangisini oling yoki tokenni to'g'ri nusxalaganingizni tekshiring.",
        )
        .then(() => undefined);
    }

    const template = templates[templateKey]!;
    const sealed = seal(token);

    const record = await db.bot.create({
      data: {
        ownerId: owner.id,
        templateKey,
        title: me.first_name,
        tgBotId: BigInt(me.id),
        tgUsername: me.username ?? "",
        tokenCipher: Buffer.from(sealed.cipher),
        tokenIv: Buffer.from(sealed.iv),
        tokenTag: Buffer.from(sealed.tag),
        tokenHash: hash,
        adminIds: JSON.stringify([String(ctx.from!.id)]),
        settings: JSON.stringify(template.defaultSettings),
        status: "active",
      },
    });

    clearStep(SCOPE, ctx.from!.id);

    const { trialGranted } = await openSubscription(record.id, owner.id);

    if (!trialGranted) {
      // Trial is once per account — a second bot must be paid for up front.
      await db.bot.update({ where: { id: record.id }, data: { status: "stopped" } });
      return ctx.api
        .editMessageText(
          status.chat.id,
          status.message_id,
          `✅ <b>@${esc(me.username ?? "")}</b> yaratildi.\n\n` +
            `⚠️ Sinov muddatidan bir marta foydalanilgan, shuning uchun bu bot uchun <b>tarif tanlash</b> kerak.`,
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("💳 Tarif tanlash", `p:pay:${record.id}`),
          },
        )
        .then(() => undefined);
    }

    try {
      await startBot(record);
    } catch (err) {
      await db.bot.update({
        where: { id: record.id },
        data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
      });
      return ctx.api
        .editMessageText(status.chat.id, status.message_id, "❌ Bot ishga tushmadi. Keyinroq urinib ko'ring.")
        .then(() => undefined);
    }

    log.info("bot created", { botId: record.id, template: templateKey });

    await ctx.api.editMessageText(
      status.chat.id,
      status.message_id,
      `🎉 <b>Tayyor!</b>\n\n` +
        `${template.emoji} <b>@${esc(me.username ?? "")}</b> ishlay boshladi.\n\n` +
        `👉 https://t.me/${me.username}\n\n` +
        `🎁 <b>7 kun bepul sinov</b> boshlandi.\n\n` +
        `<b>Keyingi qadam:</b> botingizni oching, <code>/start</code> bosing, keyin <code>/admin</code> yuboring — ` +
        `kontent qo'shish va statistika o'sha yerda.`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
  }

  // ------------------------------------------------------------ platform admin

  bot.command("stat", async (ctx) => {
    if (!(await isAdmin(BigInt(ctx.from!.id)))) return;
    await ctx.reply("Boshqaruv paneli: /panel");
  });

  bot.catch((err) => log.error("platform bot error", { err: err.error }));

  return bot;
}

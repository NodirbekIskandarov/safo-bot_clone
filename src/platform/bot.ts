import { Api, Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { Prisma } from "@prisma/client";
import { config } from "../config.js";
import { db } from "../db.js";
import { fingerprint, seal } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { clearAll, clearStep, getStep, resetStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { startBot, stopBot } from "../runtime/registry.js";
import { templateList, templates } from "../templates/index.js";
import { accessFor, openSubscription } from "../billing/subscription.js";
import { templatePlanGroup } from "../billing/plans.js";
import { registerPlatformAdmin } from "./adminpanel.js";
import { registerPaymentReview, showCardInvoice, showInvoice, showPlansFor, showTerms, submitReceipt } from "./payments.js";
import { BTN, LEGACY, isMenuButton, mainKeyboard, TERMS, termPrice } from "./menu.js";
import { PLAN_COPY, perUser, recommend } from "./plancopy.js";
import { TEMPLATE_COPY } from "./templatecopy.js";
import { MAX_TOPUP, MIN_TOPUP, buyFromBalance, registerWallet, showTopupInvoice, showTopupMenu, showWallet, submitTopup } from "./wallet.ui.js";
import { askSupport, registerCabinet, showCabinet, showIncome, showReferral, takeSupportMessage } from "./cabinet.js";
import { handleBotCardPhoto, handleBotCardText, registerBotCard, showBotCard } from "./botcard.js";
import { withEffect } from "../lib/effects.js";
import { balanceOf, charge, InsufficientFunds } from "../billing/wallet.js";
import { enabledTemplateKeys, ownedKeys, ownerMayUse, priceOf } from "../billing/templates.js";
import { isAdmin } from "./access.js";

const SCOPE = "platform";

/** Mini App entry. Omitted entirely when no HTTPS url is configured. */
function webAppButton(label: string, param?: string): InlineKeyboard | undefined {
  if (!config.WEB_APP_URL) return undefined;
  const url = param ? `${config.WEB_APP_URL}?bot=${param}` : config.WEB_APP_URL;
  return new InlineKeyboard().webApp(label, url);
}

async function keyboardFor(ctx: Context) {
  return mainKeyboard(await isAdmin(BigInt(ctx.from!.id)));
}

async function templateLines(): Promise<string> {
  const enabled = await enabledTemplateKeys();
  return templateList
    .filter((t) => enabled.has(t.key))
    .map((t) => `${t.emoji} <b>${esc(t.name)}</b> — ${esc(t.tagline)}`)
    .join("\n\n");
}

async function templatePicker(ownerId?: string): Promise<InlineKeyboard> {
  const [enabled, owned, prices] = await Promise.all([
    enabledTemplateKeys(),
    ownerId ? ownedKeys(ownerId) : Promise.resolve(new Set<string>()),
    db.templatePrice.findMany(),
  ]);
  const priceBy = new Map(prices.map((p) => [p.key, p]));

  const kb = new InlineKeyboard();
  for (const t of templateList) {
    if (!enabled.has(t.key)) continue;
    const price = priceBy.get(t.key);
    const locked = price?.isForSale && price.priceUzs > 0 && !owned.has(t.key);
    kb.text(`${locked ? "🔒 " : ""}${t.emoji} ${t.name}`, `p:tpl:${t.key}`).row();
  }
  kb.text("🎯 Qaysi bot menga kerak?", "p:tguide");
  return kb;
}

async function ownerOf(ctx: Context) {
  const from = ctx.from!;
  const isRoot = config.platformAdminIds.includes(BigInt(from.id));
  return db.owner.upsert({
    where: { tgUserId: BigInt(from.id) },
    create: {
      tgUserId: BigInt(from.id),
      username: from.username ?? null,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
      isPlatformAdmin: isRoot,
    },
    update: {
      username: from.username ?? null,
      fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
      // An owner who was put into .env after signing up must stop being billed.
      ...(isRoot ? { isPlatformAdmin: true } : {}),
    },
  });
}

const WELCOME =
  `👋 <b>Salom!</b>\n\n` +
  `Men orqali <b>dasturchisiz</b> Telegram bot yaratasiz.\n\n` +
  `Tayyor shablon tanlaysiz, @BotFather'dan olingan tokenni yuborasiz — bot 2 daqiqada ishlay boshlaydi.\n\n` +
  `Boshlash uchun «${BTN.create}» tugmasini bosing.`;

const HELP_MENU = new InlineKeyboard()
  .text("🚀 Bot qanday yaratiladi", "h:new")
  .row()
  .text("⚙️ Botni boshqarish", "h:manage")
  .text("💳 To'lov", "h:pay")
  .row()
  .text("💰 Balans va referal", "h:money")
  .text("🌐 Sayt", "h:app")
  .row()
  .text("🔒 Xavfsizlik", "h:sec")
  .text("🛠 Muammo bo'lsa", "h:trouble");

function helpSections(platformUsername: string): Record<string, string> {
  return {
    new:
      `🚀 <b>Bot qanday yaratiladi</b>\n\n` +
      `<b>1. Token oling</b>\n` +
      `Telegram'da @BotFather ni oching → <code>/newbot</code> → bot nomini yozing → ` +
      `username o'ylab toping (<b>bot</b> bilan tugashi shart, masalan <code>mening_kino_bot</code>).\n` +
      `BotFather sizga uzun token beradi. Bu bepul va 1 daqiqa vaqt oladi.\n\n` +
      `<b>2. Shablon tanlang</b>\n` +
      `«${BTN.create}» → shablonni bosing → to'liq tavsifini o'qing → «Shu botni yaratish».\n\n` +
      `<b>3. Tokenni tashlang</b>\n` +
      `Tokenni shu chatga yuboring. Bot bir necha soniyada ishlay boshlaydi.\n\n` +
      `<b>4. Kontent qo'shing</b>\n` +
      `O'z botingizni oching → <code>/start</code> → <code>/admin</code>.\n\n` +
      `🎁 Birinchi bot <b>7 kun bepul</b>. Karta so'ralmaydi.`,
    manage:
      `⚙️ <b>Botni boshqarish</b>\n\n` +
      `<b>Ikki xil panel bor — chalkashtirmang:</b>\n\n` +
      `📱 <b>Shu bot (@${esc(platformUsername)}) → «${BTN.bots}» → botingiz</b>\n` +
      `   • ⚙️ Sozlash: salomlashuv matni, adminlar, obuna kartasi, ish vaqtlari\n` +
      `   • 👤 Profil: botning nomi, tavsifi, bio va rasmi\n` +
      `   • 📊 Tarif va 💵 To'lov\n` +
      `   • 🔁 Avto uzaytirish, ⏸ to'xtatish, 🗑 o'chirish\n\n` +
      `🤖 <b>Sizning botingiz → /admin</b>\n` +
      `   • kontent: kino, mahsulot, savol, xizmat\n` +
      `   • 📢 barcha obunachilarga xabar yuborish\n` +
      `   • 📊 statistika va 👥 foydalanuvchilar\n\n` +
      `<i>Ya'ni kontent har doim o'z botingiz ichida qo'shiladi.</i>`,
    pay:
      `💳 <b>To'lov va tariflar</b>\n\n` +
      `<b>Bepul davr:</b> birinchi bot 7 kun. Akkauntga bir marta beriladi — ikkinchi bot uchun ` +
      `darhol tarif tanlanadi.\n\n` +
      `<b>To'lov qanday:</b>\n` +
      `1. «${BTN.bots}» → botingiz → «💵 To'lov»\n` +
      `2. Muddatni tanlang, chiqqan kartaga summani o'tkazing\n` +
      `3. Chek skrinshotini shu yerga tashlang\n` +
      `4. Admin tasdiqlaydi — bot darhol ishlaydi\n\n` +
      `<b>Muddat:</b> 1 oy · 3 oy (−10%) · 12 oy (−20%)\n\n` +
      `<b>🔁 Avto uzaytirish:</b> balansda pul bo'lsa, muddat tugashiga 1 soat qolganda 1 kunlik ` +
      `to'lov avtomatik yechiladi — bot to'xtamaydi. Bot kartochkasida o'chirib qo'yish mumkin.\n\n` +
      `<b>Muddat tugasa:</b> 3 kun muhlat beriladi, bot ishlayveradi. Keyin to'xtaydi, ` +
      `lekin <b>ma'lumotlar saqlanadi</b> — to'lasangiz o'sha zahoti qayta ishlaydi.`,
    money:
      `💰 <b>Balans va referal</b>\n\n` +
      `<b>Balans nima uchun kerak?</b>\n` +
      `Hisobingizni oldindan to'ldirib qo'yasiz. Keyin tarif yoki shablonni <b>bir bosishda</b> olasiz, ` +
      `avto uzaytirish ham shu balansdan ishlaydi.\n\n` +
      `<b>Qanday to'ldiriladi?</b>\n` +
      `«${BTN.topup}» → summani tanlang → kartaga o'tkazing → chek skrinshotini tashlang. ` +
      `Admin tasdiqlagach balansga tushadi.\n\n` +
      `<b>Pul yonadimi?</b> Yo'q. Balansdagi mablag' muddatsiz turadi.\n\n` +
      `<b>Referal dasturi</b>\n` +
      `«${BTN.referral}» bo'limidan shaxsiy havolangizni olasiz. Do'stingiz shu havola orqali kelib ` +
      `hisobini to'ldirsa — uning <b>birinchi to'lovidan 10%</b> sizning balansingizga tushadi.\n\n` +
      `<b>💎 Premium</b>\n` +
      `Premium a'zolar barcha tariflarni <b>10% arzon</b> oladi va to'lovlari birinchi ko'riladi.`,
    app:
      `🌐 <b>Sayt</b>\n\n` +
      `Telegram ichida ochiladigan to'liq boshqaruv paneli. Alohida dastur o'rnatish shart emas.\n\n` +
      `• Barcha botlaringiz bitta ro'yxatda — holati, tarifi, obunachilari\n` +
      `• 14 kunlik o'sish grafigi\n` +
      `• Har bir bot bo'yicha batafsil ko'rsatkichlar\n` +
      `• Balans va amallar tarixi\n\n` +
      `Pastdagi «${BTN.site}» tugmasi yoki bot kartochkasidagi «📈 Statistika (Web)» orqali ochiladi.`,
    sec:
      `🔒 <b>Xavfsizlik</b>\n\n` +
      `<b>Token:</b> AES-256-GCM bilan shifrlanadi. Faqat Telegram'ga murojaat paytida ochiladi. ` +
      `Hech qayerda — panelda ham, log'da ham — ko'rinmaydi. Siz yuborgan xabar darhol o'chiriladi.\n\n` +
      `<b>Ma'lumotlar:</b> har bir botning foydalanuvchilari faqat o'ziga tegishli. ` +
      `Boshqa mijozlar ularni ko'ra olmaydi va uchinchi tomonga berilmaydi.\n\n` +
      `<b>Bot o'chirilsa:</b> uning barcha ma'lumotlari ham o'chadi. Bu qaytarilmaydi.`,
    trouble:
      `🛠 <b>Muammo bo'lsa</b>\n\n` +
      `<b>«Token ishlamadi»</b>\n` +
      `Tokenni to'liq nusxalang — boshida yoki oxirida bo'sh joy qolmasin. Yoki @BotFather'da ` +
      `<code>/revoke</code> qilib yangisini oling.\n\n` +
      `<b>Botim javob bermayapti</b>\n` +
      `«${BTN.bots}» → holatini tekshiring. ⚪️ bo'lsa «▶️ Ishga tushirish» bosing. ` +
      `To'lov muddati tugagan bo'lishi ham mumkin.\n\n` +
      `<b>Kino/rasm yuborilmayapti</b>\n` +
      `Fayl boshqa bot orqali yuklangan bo'lsa ishlamaydi — Telegram fayllarni botga bog'laydi. ` +
      `Qayta yuklang.\n\n` +
      `<b>Yangi odam botga qo'shilmayapti</b>\n` +
      `Tarif limitiga yetgansiz. Botingiz → «📊 Tarif» → kattarog'ini tanlang.\n\n` +
      `Javob topmasangiz: «${BTN.support}».`,
  };
}

export function createPlatformBot(botUsername: string): Bot {
  const bot = new Bot(config.PLATFORM_BOT_TOKEN);
  const HELP_SECTIONS = helpSections(botUsername);

  // Must be the very first middleware: tapping a menu button while inside any
  // wizard means "leave the wizard", so no later input handler may see it.
  bot.use(async (ctx, next) => {
    const text = ctx.message?.text;
    if (text && ctx.from && isMenuButton(text)) clearAll(ctx.from.id);
    await next();
  });

  registerPlatformAdmin(bot);
  registerPaymentReview(bot);
  registerWallet(bot);
  registerCabinet(bot, botUsername);
  registerBotCard(bot);

  bot.command("start", async (ctx) => {
    const owner = await ownerOf(ctx);
    clearAll(ctx.from!.id);

    // ?start=ref_<tgId> — credited only for brand-new accounts, never self-referral
    const payload = ctx.match?.trim();
    if (payload?.startsWith("ref_") && !owner.referredBy) {
      const inviterTgId = payload.slice(4).replace(/\D/g, "");
      if (inviterTgId && inviterTgId !== String(ctx.from!.id)) {
        const inviter = await db.owner.findUnique({ where: { tgUserId: BigInt(inviterTgId) } });
        const isNew = Date.now() - owner.createdAt.getTime() < 60_000;
        if (inviter && isNew) {
          await db.owner.update({ where: { id: owner.id }, data: { referredBy: inviter.id } });
          await ctx.api
            .sendMessage(
              Number(inviter.tgUserId),
              `👥 Havolangiz orqali yangi foydalanuvchi qo'shildi: <b>${esc(owner.fullName)}</b>\n\n` +
                `U hisobini to'ldirsa, birinchi to'lovidan <b>10%</b> sizga tushadi.`,
              { parse_mode: "HTML" },
            )
            .catch(() => {});
        }
      }
    }
    await ctx.reply(WELCOME, { parse_mode: "HTML", reply_markup: mainKeyboard(owner.isPlatformAdmin || (await isAdmin(owner.tgUserId))) });
  });

  bot.command("bekor", async (ctx) => {
    clearAll(ctx.from!.id);
    await ctx.reply("Bekor qilindi.", { reply_markup: await keyboardFor(ctx) });
  });

  const helpHome = (ctx: Context, edit = false) => {
    const text =
      `📚 <b>Qo'llanma</b>\n\nQaysi bo'lim kerak?\n\n` +
      `<i>Savolingizga javob topmasangiz «${BTN.support}» orqali yozing — administratorga yetkazamiz.</i>`;
    return edit
      ? ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: HELP_MENU }).catch(() => {})
      : ctx.reply(text, { parse_mode: "HTML", reply_markup: HELP_MENU });
  };

  bot.hears([BTN.help, ...LEGACY.help], (ctx) => helpHome(ctx));
  bot.command("yordam", (ctx) => helpHome(ctx));

  bot.callbackQuery("h:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await helpHome(ctx, true);
  });

  bot.callbackQuery(/^h:(\w+)$/, async (ctx) => {
    const section = HELP_SECTIONS[ctx.match[1]!];
    await ctx.answerCallbackQuery();
    if (!section) return;
    await ctx.editMessageText(section, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("◀️ Qo'llanma bo'limlari", "h:home")
        .row()
        .text("📱 Kabinet", "cb:home")
        .text("💳 Tariflar", "p:tariffs"),
    });
  });

  // ------------------------------------------------------------- create bot

  bot.hears(BTN.create, async (ctx) => {
    const owner = await ownerOf(ctx);
    const count = await db.bot.count({ where: { ownerId: owner.id } });
    if (count >= config.MAX_BOTS_PER_OWNER) {
      return ctx.reply(`Sizda allaqachon ${count} ta bot bor. Limit: ${config.MAX_BOTS_PER_OWNER}.`);
    }
    await ctx.reply(
      `🧩 <b>1-qadam: shablon tanlang</b>\n\n${await templateLines()}\n\n` +
        `<i>Har birini bosib to'liq ma'lumot olishingiz mumkin — nima qilishi, mijoz nimani ko'rishi, ` +
        `siz nimani boshqarishingiz.</i>`,
      { parse_mode: "HTML", reply_markup: await templatePicker(owner.id) },
    );
  });

  bot.callbackQuery(/^p:tpl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const template = templates[ctx.match[1]!];
    if (!template) return;
    const copy = TEMPLATE_COPY[template.key];

    const flow = (copy?.userFlow ?? []).map((step, i) => `   ${i + 1}. ${esc(step)}`).join("\n");
    const tools = (copy?.adminTools ?? []).map((t) => `   • ${esc(t)}`).join("\n");

    // Which tariffs run it is the admin's call (/panel), not a constant.
    const group = await templatePlanGroup(template.key);
    let tariffLine = `💳 <b>Tarif:</b> har qanday tarifda ishlaydi.\n\n`;
    if (group === "business") {
      const cheapest = await db.plan.findFirst({
        where: { group: "business", isActive: true, isArchived: false, priceUzs: { gt: 0 } },
        orderBy: { priceUzs: "asc" },
      });
      tariffLine =
        `💳 <b>Tarif:</b> biznes tarifi kerak${cheapest ? ` (${money(cheapest.priceUzs)}dan)` : ""}. ` +
        `Sinov muddatida bepul ishlaydi.\n\n`;
    }

    await ctx.editMessageText(
      `${template.emoji} <b>${esc(template.name)}</b>\n\n` +
        `${esc(template.description)}\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `🏪 <b>Kimlar uchun</b>\n   ${esc(copy?.useCases ?? "")}\n\n` +
        `👤 <b>Mijoz nimani ko'radi</b>\n${flow}\n\n` +
        `⚙️ <b>Siz nimani boshqarasiz</b>\n${tools}\n\n` +
        tariffLine +
        (copy?.note ? `ℹ️ <i>${esc(copy.note)}</i>` : ""),
      { parse_mode: "HTML", reply_markup: await templateActions(ctx, template.key) },
    );
  });

  async function templateActions(ctx: Context, key: string): Promise<InlineKeyboard> {
    const owner = await ownerOf(ctx);
    const price = await priceOf(key);
    const may = await ownerMayUse(owner.id, key);
    const kb = new InlineKeyboard();
    if (may) kb.text("✅ Shu botni yaratish", `p:tplgo:${key}`).row();
    else if (price?.isEnabled) kb.text(`🔓 Ochish — ${money(price.priceUzs)}`, `p:tbuy:${key}`).row();
    return kb.text("◀️ Boshqa shablonlar", "p:tpls");
  }

  // buying a template outright, from balance
  bot.callbackQuery(/^p:tbuy:(.+)$/, async (ctx) => {
    const key = ctx.match[1]!;
    const [owner, price] = await Promise.all([ownerOf(ctx), priceOf(key)]);
    const template = templates[key];
    if (!price || !template) return ctx.answerCallbackQuery("Topilmadi");
    await ctx.answerCallbackQuery();

    const balance = await balanceOf(owner.id);
    const kb = new InlineKeyboard();
    if (balance >= price.priceUzs) kb.text("✅ Balansdan to'lash", `p:tbuygo:${key}`).row();
    kb.text("➕ Balansni to'ldirish", "w:top").row().text("◀️ Orqaga", `p:tpl:${key}`);

    await ctx.editMessageText(
      `🔓 <b>${template.emoji} ${esc(template.name)}</b>\n\n` +
        `Bu shablon alohida sotiladi: <b>${money(price.priceUzs)}</b> — bir marta to'laysiz, ` +
        `keyin cheksiz foydalanasiz.\n\n` +
        `Balansingiz: <b>${money(balance)}</b>` +
        (balance < price.priceUzs ? `\n\n⚠️ Yetishmayapti: ${money(price.priceUzs - balance)}` : ""),
      { parse_mode: "HTML", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^p:tbuygo:(.+)$/, async (ctx) => {
    const key = ctx.match[1]!;
    const [owner, price] = await Promise.all([ownerOf(ctx), priceOf(key)]);
    const template = templates[key];
    if (!price || !template || !price.isEnabled) return ctx.answerCallbackQuery("Topilmadi");

    const done = new InlineKeyboard().text("✅ Shu botni yaratish", `p:tplgo:${key}`);
    try {
      // Ownership row first, inside the same transaction as the charge: a second
      // tap hits the unique constraint before any money moves.
      const left = await db.$transaction(async (tx) => {
        await tx.ownerTemplate.create({ data: { ownerId: owner.id, templateKey: key, pricePaid: price.priceUzs } });
        return charge(owner.id, price.priceUzs, "template", { note: template.name, refId: key }, tx);
      });
      await ctx.answerCallbackQuery("Ochildi ✅");
      await ctx.editMessageText(
        `🔓 <b>Ochildi!</b>\n\n${template.emoji} ${esc(template.name)} endi sizniki.\n` +
          `Qolgan balans: <b>${money(left)}</b>`,
        { parse_mode: "HTML", reply_markup: done },
      );
    } catch (err) {
      if (err instanceof InsufficientFunds) {
        return ctx.answerCallbackQuery({ text: "Balans yetarli emas", show_alert: true });
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        await ctx.answerCallbackQuery("Bu shablon allaqachon sizniki");
        return void ctx.editMessageReplyMarkup({ reply_markup: done }).catch(() => {});
      }
      throw err;
    }
  });

  bot.callbackQuery("p:tpls", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerOf(ctx);
    await ctx.editMessageText(`🧩 <b>Shablon tanlang</b>\n\n${await templateLines()}`, {
      parse_mode: "HTML",
      reply_markup: await templatePicker(owner.id),
    });
  });

  bot.callbackQuery("p:tguide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🎯 <b>Qaysi bot kerak?</b>\n\nMaqsadingizga qarab tanlang:\n\n` +
        `💰 <b>Pul ishlashim kerak</b>\n` +
        `   🛒 Mahsulot sotaman → <b>Do'kon</b>\n` +
        `   📅 Xizmat ko'rsataman (sartaroshxona, klinika) → <b>Navbat</b>\n\n` +
        `📣 <b>Auditoriya yig'ishim kerak</b>\n` +
        `   🎬 Kino/kontent tarqataman → <b>Kino</b>\n` +
        `   📢 Obunachilarga xabar yuboraman → <b>Reklama</b>\n` +
        `   🎁 Kanalimni tez o'stirmoqchiman → <b>Konkurs</b>\n\n` +
        `⏱ <b>Vaqtimni tejashim kerak</b>\n` +
        `   💬 Mijozlar savoliga javob beraman → <b>Aloqa</b>\n` +
        `   🤖 Bir xil savol takrorlanaveradi → <b>Savol-javob</b>\n` +
        `   📋 Ariza/fikr yig'aman → <b>Anketa</b>\n\n` +
        `<i>Keyinroq boshqa shablonda yana bot yaratishingiz mumkin.</i>`,
      { parse_mode: "HTML", reply_markup: await templatePicker((await ownerOf(ctx)).id) },
    );
  });

  bot.callbackQuery(/^p:tplgo:(.+)$/, async (ctx) => {
    const template = templates[ctx.match[1]!];
    if (!template) return ctx.answerCallbackQuery();

    const owner = await ownerOf(ctx);
    if (!(await ownerMayUse(owner.id, template.key))) {
      return ctx.answerCallbackQuery({ text: "Bu shablon hali ochilmagan", show_alert: true });
    }
    const count = await db.bot.count({ where: { ownerId: owner.id } });
    if (count >= config.MAX_BOTS_PER_OWNER) {
      return ctx.answerCallbackQuery({ text: `Botlar limiti: ${config.MAX_BOTS_PER_OWNER}`, show_alert: true });
    }
    await ctx.answerCallbackQuery();

    resetStep(SCOPE, ctx.from!.id, "await_token", { templateKey: template.key });
    await ctx.editMessageText(
      `${template.emoji} <b>${esc(template.name)}</b>\n\n` +
        `🔑 <b>2-qadam: token yuboring</b>\n\n` +
        `1. @BotFather ni oching\n` +
        `2. <code>/newbot</code> yuboring\n` +
        `3. Bot nomini yozing (masalan: Mening Do'konim)\n` +
        `4. Username o'ylab toping — <b>bot</b> bilan tugashi shart\n` +
        `5. BotFather bergan tokenni shu yerga tashlang\n\n` +
        `<i>Token shunday ko'rinadi:</i>\n<code>1234567890:AAF...xyz</code>\n\n` +
        `🔒 Token shifrlanadi va yuborgan xabaringiz darhol o'chiriladi.\n\n` +
        `Bekor qilish: /bekor`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("◀️ Orqaga", `p:tpl:${template.key}`) },
    );
  });

  // ---------------------------------------------------------------- tariffs

  bot.hears([...LEGACY.tariffs], (ctx) => showTariffs(ctx));
  bot.callbackQuery("p:tariffs", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTariffs(ctx, true);
  });

  async function showTariffs(ctx: Context, edit = false) {
    const plans = await db.plan.findMany({ where: { isActive: true, isArchived: false }, orderBy: { sortOrder: "asc" } });

    const row = (p: (typeof plans)[number]) => {
      const price = p.priceUzs === 0 ? "bepul" : `${money(p.priceUzs)}/oy`;
      const users = p.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ");
      return `<b>${esc(p.name)}</b> · ${price}\n   👥 ${users} obunachi — <i>${esc(PLAN_COPY[p.code]?.audience ?? "")}</i>`;
    };
    const trial = plans.find((p) => p.code === "trial");

    const text =
      `💳 <b>Tariflar</b>\n\n` +
      `Tariflar <b>ikki narsa</b> bilan farqlanadi:\n\n` +
      `1️⃣ <b>Nechta obunachi</b> — botingizga qancha odam qo'shila oladi. Limitga yetganda ` +
      `yangi odam qo'shilmaydi (eskilari ishlayveradi).\n` +
      `2️⃣ <b>Buyurtma qabul qilish</b> — do'kon boti uchun <b>biznes</b> tarifi kerak.\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      (trial ? `🎁 ${row(trial)}\n   <i>Bir marta, karta so'ralmaydi</i>\n\n` : "") +
      `📣 <b>KONTENT BOTLARI</b>\n\n` +
      plans.filter((p) => p.group === "standard").map(row).join("\n\n") +
      `\n\n🛒 <b>DO'KON BOTLARI</b> <i>(buyurtma qabul qiladi)</i>\n\n` +
      plans.filter((p) => p.group === "business").map(row).join("\n\n") +
      `\n\n━━━━━━━━━━━━━━\n\nBatafsil ko'rish uchun tarif tugmasini bosing.`;

    const kb = new InlineKeyboard().text("🎯 Menga qaysi tarif mos?", "p:guide").row();
    plans
      .filter((p) => p.priceUzs > 0)
      .forEach((p, i) => {
        kb.text(p.name, `pd:${p.code}`);
        if (i % 2 === 1) kb.row();
      });
    kb.row().text("💳 To'lov qilish", "p:paypick").text("📱 Kabinet", "cb:home");

    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  bot.callbackQuery(/^pd:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const plan = await db.plan.findUnique({ where: { code: ctx.match[1]! } });
    if (!plan) return;

    const f = JSON.parse(plan.features) as { orders: boolean; broadcastDailyLimit: number };
    const copy = PLAN_COPY[plan.code];
    const all = await db.plan.findMany({ where: { isActive: true, isArchived: false }, orderBy: { sortOrder: "asc" } });
    const sameGroup = all.filter((p) => p.group === plan.group && p.priceUzs > 0);
    const idx = sameGroup.findIndex((p) => p.code === plan.code);
    const prev = idx > 0 ? sameGroup[idx - 1] : undefined;
    const next = idx >= 0 ? sameGroup[idx + 1] : undefined;
    const fmt = (n: number) => n.toLocaleString("ru-RU").replace(/,/g, " ");

    const terms = TERMS.map((t) => {
      const total = termPrice(plan.priceUzs, t.months);
      const save = t.discount > 0 ? ` <i>(−${Math.round(t.discount * 100)}%)</i>` : "";
      return `   ${t.label} — <b>${money(total)}</b>${save}`;
    }).join("\n");

    await ctx.editMessageText(
      `<b>${esc(plan.name)}</b> — ${money(plan.priceUzs)}/oy\n\n` +
        `<i>${esc(copy?.audience ?? "")}</i>\n` +
        `${esc(copy?.example ?? "")}\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `👥 <b>${fmt(plan.maxBotUsers)}</b> obunachigacha\n` +
        `📢 Kuniga <b>${f.broadcastDailyLimit}</b> ta ommaviy xabar\n` +
        `🛒 Buyurtma qabul qilish: <b>${f.orders ? "bor" : "yo'q"}</b>\n` +
        `📥 Eksport, 🔒 majburiy obuna, 📊 statistika: <b>bor</b>\n\n` +
        `💡 Bir obunachi uchun: <b>${perUser(plan.priceUzs, plan.maxBotUsers)}/oy</b>\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `<b>Muddat:</b>\n${terms}\n\n` +
        (prev ? `⬇️ <b>${esc(prev.name)}</b> (${money(prev.priceUzs)}) — ${fmt(prev.maxBotUsers)} obunachi, arzonroq\n` : "") +
        (next ? `⬆️ <b>${esc(next.name)}</b> (${money(next.priceUzs)}) — ${fmt(next.maxBotUsers)} obunachi, kengroq\n` : ""),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("💳 Shu tarifni tanlash", "p:paypick").row().text("◀️ Barcha tariflar", "p:tariffs"),
      },
    );
  });

  bot.callbackQuery("p:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🎯 <b>Qaysi tarif mos?</b>\n\n1-savol: botingiz nima qiladi?`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("🛒 Buyurtma qabul qiladi", "pg:o:1")
        .row()
        .text("📣 Kontent, xabar, navbat, anketa", "pg:o:0")
        .row()
        .text("◀️ Orqaga", "p:tariffs"),
    });
  });

  bot.callbackQuery(/^pg:o:([01])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const o = ctx.match[1];
    await ctx.editMessageText(
      `🎯 <b>2-savol:</b> yaqin oylarda nechta obunachi kutyapsiz?\n\n` +
        `<i>Aniq bilmasangiz kamrog'ini tanlang — keyin istalgan vaqt oshirasiz, qolgan kunlar yo'qolmaydi.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("500 gacha", `pg:u:${o}:500`)
          .text("2 000", `pg:u:${o}:2000`)
          .row()
          .text("5 000", `pg:u:${o}:5000`)
          .text("15 000+", `pg:u:${o}:15000`)
          .row()
          .text("◀️ Orqaga", "p:guide"),
      },
    );
  });

  bot.callbackQuery(/^pg:u:([01]):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orders = ctx.match[1] === "1";
    const expected = Number(ctx.match[2]);
    const plans = await db.plan.findMany({
      where: { isActive: true, isArchived: false, priceUzs: { gt: 0 } },
      orderBy: { sortOrder: "asc" },
    });
    const pick = recommend(plans, expected, orders);

    if (!pick) {
      return void ctx.editMessageText(`Bu hajm uchun alohida shart kerak — «${BTN.support}» orqali yozing.`, {
        reply_markup: new InlineKeyboard().text("◀️ Tariflar", "p:tariffs"),
      });
    }

    const copy = PLAN_COPY[pick.code];
    await ctx.editMessageText(
      `🎯 <b>Sizga mos: ${esc(pick.name)}</b>\n\n` +
        `${money(pick.priceUzs)}/oy · ${pick.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ")} obunachi\n\n` +
        `<i>${esc(copy?.example ?? "")}</i>\n\n` +
        `Nega shu: ${orders ? "buyurtma qabul qilish kerak, " : ""}` +
        `kutilgan ${expected.toLocaleString("ru-RU").replace(/,/g, " ")} obunachini qoplaydigan ` +
        `<b>eng arzon</b> tarif shu.\n\n` +
        `<i>Sinov muddati esa baribir bepul — avval sinab ko'ring.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💳 Shu tarifni olish", "p:paypick")
          .row()
          .text("📋 Batafsil", `pd:${pick.code}`)
          .row()
          .text("◀️ Orqaga", "p:guide")
          .text("💳 Tariflar", "p:tariffs"),
      },
    );
  });

  bot.callbackQuery("p:paypick", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerOf(ctx);
    const bots = await db.bot.findMany({ where: { ownerId: owner.id }, orderBy: { createdAt: "asc" } });

    if (bots.length === 0) {
      return void ctx
        .editMessageText(`Avval bot yarating — «${BTN.create}».`, {
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

  // ------------------------------------------------------------- main menu

  bot.hears(BTN.bots, (ctx) => listBots(ctx));
  bot.hears(BTN.income, async (ctx) => {
    await ownerOf(ctx);
    await showIncome(ctx);
  });
  bot.hears([BTN.cabinet, ...LEGACY.cabinet], async (ctx) => {
    await ownerOf(ctx);
    await showCabinet(ctx);
  });
  bot.hears(BTN.topup, async (ctx) => {
    await ownerOf(ctx);
    await showTopupMenu(ctx);
  });
  bot.hears([...LEGACY.topup], async (ctx) => {
    await ownerOf(ctx);
    await showWallet(ctx);
  });
  bot.hears(BTN.referral, async (ctx) => {
    await ownerOf(ctx);
    await showReferral(ctx, botUsername);
  });
  bot.hears(BTN.support, async (ctx) => {
    await ownerOf(ctx);
    await askSupport(ctx);
  });
  bot.hears([BTN.site, ...LEGACY.site], async (ctx) => {
    const app = webAppButton("🌐 Saytni ochish");
    await ctx.reply(
      app
        ? "🌐 <b>Boshqaruv sayti</b>\n\nBarcha botlaringiz, statistika, grafiklar va balans — bitta ekranda."
        : "🌐 Sayt hozircha tayyorlanmoqda.",
      { parse_mode: "HTML", reply_markup: app },
    );
  });

  async function listBots(ctx: Context, edit = false) {
    const owner = await ownerOf(ctx);
    const bots = await db.bot.findMany({ where: { ownerId: owner.id }, orderBy: { createdAt: "asc" } });

    if (bots.length === 0) {
      const text = `Sizda hali bot yo'q.\n\n«${BTN.create}» tugmasini bosing.`;
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
    clearStep(SCOPE, ctx.from!.id);
    await listBots(ctx, true);
  });

  // Buttons on cards sent by earlier releases. Never act on them directly
  // (one was a delete): open the current card instead.
  bot.callbackQuery(/^p:(?:toggle|del|delyes|text):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBotCard(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^p:pay:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showPlansFor(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^py:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showTerms(ctx, ctx.match[1]!, ctx.match[2]!);
  });

  bot.callbackQuery(/^pyd:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showInvoice(ctx, ctx.match[1]!, ctx.match[2]!, Number(ctx.match[3]));
  });

  bot.callbackQuery(/^wb:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
    await buyFromBalance(ctx, ctx.match[1]!, ctx.match[2]!, Number(ctx.match[3]));
  });

  // explicit "pay by card even though balance covers it"
  bot.callbackQuery(/^pyc:([^:]+):([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showCardInvoice(ctx, ctx.match[1]!, ctx.match[2]!, Number(ctx.match[3]));
  });

  // ------------------------------------------------------------ text input

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    if (await handleBotCardPhoto(ctx, photo.file_id)) return;
    const state = getStep(SCOPE, ctx.from!.id);
    if (state?.step !== "await_receipt") return;
    if (state.data.topupAmount) await submitTopup(ctx, bot.api, photo.file_id, ctx.message.caption);
    else await submitReceipt(ctx, bot.api, { fileId: photo.file_id, text: ctx.message.caption });
  });

  bot.on("message:text", async (ctx) => {
    const state = getStep(SCOPE, ctx.from!.id);
    const text = ctx.message.text.trim();
    if (!state || text.startsWith("/")) return;

    if (state.step === "await_support") {
      await takeSupportMessage(ctx, text);
      return;
    }

    if (state.step === "await_topup_amount") {
      const amount = /^[\d\s]+$/.test(text) ? Number(text.replace(/\s/g, "")) : NaN;
      if (!Number.isSafeInteger(amount) || amount < MIN_TOPUP || amount > MAX_TOPUP) {
        return void ctx.reply(
          `Summa noto'g'ri. ${money(MIN_TOPUP)} dan ${money(MAX_TOPUP)} gacha, faqat raqam yuboring.`,
        );
      }
      await showTopupInvoice(ctx, amount);
      return;
    }

    if (state.step === "await_receipt") {
      if (state.data.topupAmount) await submitTopup(ctx, bot.api, undefined, text);
      else await submitReceipt(ctx, bot.api, { text });
      return;
    }

    if (state.step === "await_token") {
      await handleToken(ctx, text, state.data.templateKey as string);
      return;
    }

    await handleBotCardText(ctx, text);
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
    const edit = (text: string, extra: Parameters<Api["editMessageText"]>[3] = {}) =>
      ctx.api.editMessageText(status.chat.id, status.message_id, text, extra).then(() => undefined);

    let me: Awaited<ReturnType<Api["getMe"]>>;
    try {
      me = await new Api(token).getMe();
    } catch {
      return edit("❌ Token ishlamadi. @BotFather'dan yangisini oling yoki tokenni to'g'ri nusxalaganingizni tekshiring.");
    }

    // One record per Telegram bot. A revoked-and-regenerated token used to create
    // a second row, and both rows polled the same bot — Telegram then hands
    // updates to one poller at random and the bot looks broken.
    const twin = await db.bot.findFirst({ where: { tgBotId: BigInt(me.id) } });
    if (twin) {
      if (twin.ownerId !== owner.id) {
        return edit("❌ Bu bot boshqa foydalanuvchida ro'yxatdan o'tgan. @BotFather'dan yangi bot oching.");
      }

      // Same owner re-adding their own bot: refresh the token in place — but
      // only restart it if it has paid time. Re-sending a token used to revive
      // an expired or unpaid bot for free.
      const access = await accessFor(twin.id);
      const live = !access || access.live;
      const refreshed = seal(token);
      await stopBot(twin.id);
      const updated = await db.bot.update({
        where: { id: twin.id },
        data: {
          tokenCipher: Buffer.from(refreshed.cipher),
          tokenIv: Buffer.from(refreshed.iv),
          tokenTag: Buffer.from(refreshed.tag),
          tokenHash: hash,
          tgUsername: me.username ?? "",
          status: live ? "active" : "stopped",
          lastError: null,
        },
      });
      clearStep(SCOPE, ctx.from!.id);
      if (live) await startBot(updated).catch(() => {});

      const kept = twin.templateKey !== templateKey
        ? `\n\n<i>Bot avvalgi shablonda qoldi: ${esc(templates[twin.templateKey]?.name ?? twin.templateKey)}. ` +
          `Boshqa shablon kerak bo'lsa, @BotFather'da yangi bot oching.</i>`
        : "";
      return edit(
        `♻️ <b>@${esc(me.username ?? "")}</b> allaqachon ro'yxatda edi — tokeni yangilandi.` +
          (live ? ` Bot qayta ishga tushdi.` : `\n\n⚠️ Obuna muddati tugagan, bot to'lovdan keyin ishlaydi.`) +
          kept,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(live ? "🤖 Botni ochish" : "💵 To'lov", live ? `p:bot:${twin.id}` : `bc:pay:${twin.id}`),
        },
      );
    }

    const count = await db.bot.count({ where: { ownerId: owner.id } });
    if (count >= config.MAX_BOTS_PER_OWNER) {
      clearStep(SCOPE, ctx.from!.id);
      return edit(`❌ Botlar limiti: ${config.MAX_BOTS_PER_OWNER}. Yangisini qo'shish uchun bittasini o'chiring.`);
    }

    const template = templates[templateKey];
    if (!template || !(await ownerMayUse(owner.id, templateKey))) {
      clearStep(SCOPE, ctx.from!.id);
      return edit("❌ Bu shablon hozir mavjud emas. Boshqasini tanlang.");
    }
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
      return edit(
        `✅ <b>@${esc(me.username ?? "")}</b> yaratildi.\n\n` +
          `⚠️ Sinov muddatidan bir marta foydalanilgan, shuning uchun bu bot uchun <b>tarif tanlash</b> kerak.`,
        { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("💳 Tarif tanlash", `p:pay:${record.id}`) },
      );
    }

    try {
      await startBot(record);
    } catch (err) {
      await db.bot.update({
        where: { id: record.id },
        data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
      });
      return edit("❌ Bot ishga tushmadi. Keyinroq urinib ko'ring.");
    }

    log.info("bot created", { botId: record.id, template: templateKey });

    await edit(
      `🎉 <b>Tayyor!</b>\n\n` +
        `${template.emoji} <b>@${esc(me.username ?? "")}</b> ishlay boshladi.\n\n` +
        `👉 https://t.me/${me.username}\n\n` +
        `🎁 <b>7 kun bepul sinov</b> boshlandi.\n\n` +
        `<b>Keyingi qadam:</b> botingizni oching, <code>/start</code> bosing, keyin <code>/admin</code> yuboring — ` +
        `kontent qo'shish va statistika o'sha yerda.`,
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: new InlineKeyboard().text("⚙️ Botni sozlash", `p:bot:${record.id}`),
      },
    );

    // A lone animated effect is the only animation a bot can play without a
    // Fragment username; it marks the moment the product actually starts.
    await ctx.reply("🎉", withEffect("party")).catch(() => {});
  }

  bot.catch((err) => log.error("platform bot error", { err: err.error }));

  return bot;
}

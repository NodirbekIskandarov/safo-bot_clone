import { Api, Bot, InlineKeyboard, Keyboard } from "grammy";
import type { Context } from "grammy";
import { config } from "../config.js";
import { db } from "../db.js";
import { fingerprint, seal } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { clearAll, clearStep, getStep, setStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import { reloadBot, startBot, stopBot } from "../runtime/registry.js";
import { templateList, templates } from "../templates/index.js";
import { accessFor, openSubscription } from "../billing/subscription.js";
import { registerPlatformAdmin } from "./adminpanel.js";
import { registerPaymentReview, showCardInvoice, showInvoice, showPlansFor, showTerms, submitReceipt } from "./payments.js";
import { isMenuButton, TERMS, termPrice } from "./menu.js";
import { PLAN_COPY, perUser, recommend } from "./plancopy.js";
import { TEMPLATE_COPY } from "./templatecopy.js";
import { buyFromBalance, registerWallet, showTopupInvoice, showWallet, submitTopup } from "./wallet.ui.js";
import { registerCabinet, showCabinet, takeSupportMessage } from "./cabinet.js";
import { withEffect } from "../lib/effects.js";
import { balanceOf, charge, InsufficientFunds } from "../billing/wallet.js";
import { enabledTemplateKeys, ownedKeys, ownerMayUse, priceOf } from "../billing/templates.js";
import { isAdmin } from "./access.js";

const SCOPE = "platform";

const mainKeyboard = new Keyboard()
  .text("➕ Bot yaratish")
  .text("🤖 Botlarim")
  .row()
  .text("🗣 Referal")
  .text("🪪 Shaxsiy kabinet")
  .row()
  .text("📱 Ilova")
  .text("💵 Hisob to'ldirish")
  .row()
  .text("✉️ Murojaat")
  .text("📘 Qo'llanma")
  .resized();

/** Mini App entry. Omitted entirely when no HTTPS url is configured. */
function webAppButton(label: string, param?: string): InlineKeyboard | undefined {
  if (!config.WEB_APP_URL) return undefined;
  const url = param ? `${config.WEB_APP_URL}?bot=${param}` : config.WEB_APP_URL;
  return new InlineKeyboard().webApp(label, url);
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

const HELP_MENU = new InlineKeyboard()
  .text("🚀 Bot qanday yaratiladi", "h:new")
  .row()
  .text("⚙️ Botni boshqarish", "h:manage")
  .text("💳 To'lov", "h:pay")
  .row()
  .text("💰 Balans va referal", "h:money")
  .text("📱 Ilova", "h:app")
  .row()
  .text("🔒 Xavfsizlik", "h:sec")
  .text("🛠 Muammo bo'lsa", "h:trouble");

const HELP_SECTIONS: Record<string, string> = {
  new:
    `🚀 <b>Bot qanday yaratiladi</b>\n\n` +
    `<b>1. Token oling</b>\n` +
    `Telegram'da @BotFather ni oching → <code>/newbot</code> → bot nomini yozing → ` +
    `username o'ylab toping (<b>bot</b> bilan tugashi shart, masalan <code>mening_kino_bot</code>).\n` +
    `BotFather sizga uzun token beradi. Bu bepul va 1 daqiqa vaqt oladi.\n\n` +
    `<b>2. Shablon tanlang</b>\n` +
    `«➕ Bot yaratish» → shablonni bosing → to'liq tavsifini o'qing → «Shu botni yaratish».\n\n` +
    `<b>3. Tokenni tashlang</b>\n` +
    `Tokenni shu chatga yuboring. Bot bir necha soniyada ishlay boshlaydi.\n\n` +
    `<b>4. Kontent qo'shing</b>\n` +
    `O'z botingizni oching → <code>/start</code> → <code>/admin</code>.\n\n` +
    `🎁 Birinchi bot <b>7 kun bepul</b>. Karta so'ralmaydi.`,
  manage:
    `⚙️ <b>Botni boshqarish</b>\n\n` +
    `<b>Ikki xil panel bor — chalkashtirmang:</b>\n\n` +
    `📱 <b>Shu bot (@Botxona_bot)</b>\n` +
    `   • bot yaratish va o'chirish\n` +
    `   • ishga tushirish / to'xtatish\n` +
    `   • salomlashuv matnini o'zgartirish\n` +
    `   • tarif va to'lov\n\n` +
    `🤖 <b>Sizning botingiz → /admin</b>\n` +
    `   • kontent: kino, mahsulot, savol, xizmat\n` +
    `   • 📢 barcha obunachilarga xabar yuborish\n` +
    `   • 📊 statistika: obunachilar, bugungi qo'shilganlar\n` +
    `   • 👥 foydalanuvchilar ro'yxati\n\n` +
    `<i>Ya'ni kontent har doim o'z botingiz ichida qo'shiladi.</i>`,
  pay:
    `💳 <b>To'lov va tariflar</b>\n\n` +
    `<b>Bepul davr:</b> birinchi bot 7 kun. Akkauntga bir marta beriladi — ikkinchi bot uchun ` +
    `darhol tarif tanlanadi.\n\n` +
    `<b>To'lov qanday:</b>\n` +
    `1. «💳 Tariflar» → tarif va muddatni tanlang\n` +
    `2. Chiqqan kartaga summani o'tkazing\n` +
    `3. Chek skrinshotini shu yerga tashlang\n` +
    `4. Admin tasdiqlaydi — bot darhol ishlaydi\n\n` +
    `<b>Muddat:</b> 1 oy · 3 oy (−10%) · 12 oy (−20%)\n\n` +
    `<b>Muddat tugasa:</b> 3 kun muhlat beriladi, bot ishlayveradi. Keyin to'xtaydi, ` +
    `lekin <b>ma'lumotlar saqlanadi</b> — to'lasangiz o'sha zahoti qayta ishlaydi.\n\n` +
    `<b>Erta to'lasangiz</b> qolgan kunlar yo'qolmaydi, ustiga qo'shiladi.`,
  money:
    `💰 <b>Balans va referal</b>\n\n` +
    `<b>Balans nima uchun kerak?</b>\n` +
    `Hisobingizni oldindan to'ldirib qo'yasiz. Keyin tarif yoki shablon sotib olishda ` +
    `chek yuborib, admin tasdig'ini kutib o'tirmaysiz — <b>bir bosishda</b> to'laysiz.\n\n` +
    `<b>Qanday to'ldiriladi?</b>\n` +
    `«💵 Hisob to'ldirish» → summani tanlang → kartaga o'tkazing → chek skrinshotini tashlang. ` +
    `Admin tasdiqlagach balansga tushadi.\n\n` +
    `<b>Pul yonadimi?</b>\n` +
    `Yo'q. Balansdagi mablag' muddatsiz turadi.\n\n` +
    `<b>Referal dasturi</b>\n` +
    `«🗣 Referal» bo'limidan shaxsiy havolangizni olasiz. Do'stingiz shu havola orqali kelib ` +
    `hisobini to'ldirsa — uning <b>birinchi to'lovidan 10%</b> sizning balansingizga tushadi.\n\n` +
    `<b>💎 Premium</b>\n` +
    `Premium a'zolar barcha tariflarni <b>10% arzon</b> oladi va to'lovlari navbatsiz ko'riladi.`,
  app:
    `📱 <b>Ilova</b>\n\n` +
    `Botxona ilovasi — Telegram ichida ochiladigan to'liq boshqaruv paneli. Alohida sayt ` +
    `yoki dastur o'rnatish shart emas.\n\n` +
    `<b>Ilovada nima bor:</b>\n` +
    `• Barcha botlaringiz bitta ro'yxatda — holati, tarifi, obunachilari\n` +
    `• 14 kunlik o'sish grafigi\n` +
    `• Har bir bot bo'yicha batafsil ko'rsatkichlar\n` +
    `• Do'kon botlari uchun oxirgi buyurtmalar\n` +
    `• Balans va amallar tarixi\n\n` +
    `<b>Qanday ochiladi:</b>\n` +
    `Pastdagi «📱 Ilova» tugmasi yoki chat tepasidagi menyu tugmasi orqali. ` +
    `Bot kartochkasidagi «📱 Ilovada ochish» esa o'sha botning sahifasini ochadi.`,
  sec:
    `🔒 <b>Xavfsizlik</b>\n\n` +
    `<b>Token:</b> AES-256-GCM bilan shifrlanadi. Faqat Telegram'ga murojaat paytida ochiladi. ` +
    `Hech qayerda — panelda ham, log'da ham — ko'rinmaydi. Siz yuborgan xabar darhol o'chiriladi.\n\n` +
    `<b>Ma'lumotlar:</b> har bir botning foydalanuvchilari faqat o'ziga tegishli. ` +
    `Boshqa mijozlar ularni ko'ra olmaydi va uchinchi tomonga berilmaydi.\n\n` +
    `<b>Bot o'chirilsa:</b> uning barcha ma'lumotlari ham o'chadi. Bu qaytarilmaydi.\n\n` +
    `<b>Biz hech qachon</b> sizning tokeningiz bilan o'z nomimizdan xabar yubormaymiz.`,
  trouble:
    `🛠 <b>Muammo bo'lsa</b>\n\n` +
    `<b>«Token ishlamadi»</b>\n` +
    `Tokenni to'liq nusxalang — boshida yoki oxirida bo'sh joy qolmasin. Yoki @BotFather'da ` +
    `<code>/revoke</code> qilib yangisini oling.\n\n` +
    `<b>«Bu token allaqachon ishlatilgan»</b>\n` +
    `Shu token bilan bot allaqachon yaratilgan. @BotFather'dan yangi bot oching.\n\n` +
    `<b>Botim javob bermayapti</b>\n` +
    `«🤖 Mening botlarim» → holatini tekshiring. ⚪️ bo'lsa «Ishga tushirish» bosing. ` +
    `To'lov muddati tugagan bo'lishi ham mumkin.\n\n` +
    `<b>Kino/rasm yuborilmayapti</b>\n` +
    `Fayl boshqa bot orqali yuklangan bo'lsa ishlamaydi — Telegram fayllarni botga bog'laydi. ` +
    `Qayta yuklang.\n\n` +
    `<b>Yangi odam botga qo'shilmayapti</b>\n` +
    `Tarif limitiga yetgansiz. «💳 Tariflar» → kattarog'ini tanlang.`,
};

export function createPlatformBot(botUsername: string): Bot {
  const bot = new Bot(config.PLATFORM_BOT_TOKEN);

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
    await ctx.reply(WELCOME, { parse_mode: "HTML", reply_markup: mainKeyboard });
    const app = webAppButton("📱 Ilovani ochish");
    if (app) {
      await ctx.reply(
        "📱 <b>Ilova</b> — botlaringiz, statistika va balans bitta ekranda.",
        { parse_mode: "HTML", reply_markup: app },
      );
    }
  });

  bot.command("bekor", async (ctx) => {
    clearAll(ctx.from!.id);
    await ctx.reply("Bekor qilindi.", { reply_markup: mainKeyboard });
  });

  const helpHome = (ctx: Context, edit = false) => {
    const text =
      `📘 <b>Qo'llanma</b>\n\nQaysi bo'lim kerak?\n\n` +
      `<i>Savolingizga javob topmasangiz shu yerga yozing — administratorga yetkazamiz.</i>`;
    return edit
      ? ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: HELP_MENU }).catch(() => {})
      : ctx.reply(text, { parse_mode: "HTML", reply_markup: HELP_MENU });
  };

  bot.hears("❓ Yordam", (ctx) => helpHome(ctx));
  bot.command("yordam", (ctx) => helpHome(ctx));

  bot.callbackQuery("h:home", async (ctx) => {
    await ctx.answerCallbackQuery();
    await helpHome(ctx, true);
  });

  bot.callbackQuery(/^h:(\w+)$/, async (ctx) => {
    const section = HELP_SECTIONS[ctx.match[1]!];
    if (!section) return ctx.answerCallbackQuery();
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(section, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("◀️ Qo'llanma bo'limlari", "h:home")
        .row()
        .text("🪪 Kabinet", "cb:home")
        .text("💳 Tariflar", "p:tariffs"),
    });
  });

  // ------------------------------------------------------------- create bot

  bot.hears("➕ Bot yaratish", async (ctx) => {
    const owner = await ownerOf(ctx);
    const count = await db.bot.count({ where: { ownerId: owner.id } });
    if (count >= config.MAX_BOTS_PER_OWNER) {
      return ctx.reply(`Sizda allaqachon ${count} ta bot bor. Limit: ${config.MAX_BOTS_PER_OWNER}.`);
    }
    const lines = templateList.map((t) => `${t.emoji} <b>${esc(t.name)}</b> — ${esc(t.tagline)}`);
    await ctx.reply(
      `🧩 <b>1-qadam: shablon tanlang</b>\n\n${lines.join("\n\n")}\n\n` +
        `<i>Har birini bosib to'liq ma'lumot olishingiz mumkin — nima qilishi, mijoz nimani ko'rishi, ` +
        `siz nimani boshqarishingiz.</i>`,
      { parse_mode: "HTML", reply_markup: await templatePicker((await ownerOf(ctx)).id) },
    );
  });

  bot.callbackQuery(/^p:tpl:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const template = templates[ctx.match[1]!];
    if (!template) return;
    const copy = TEMPLATE_COPY[template.key];

    const flow = (copy?.userFlow ?? []).map((step, i) => `   ${i + 1}. ${esc(step)}`).join("\n");
    const tools = (copy?.adminTools ?? []).map((t) => `   • ${esc(t)}`).join("\n");

    await ctx.editMessageText(
      `${template.emoji} <b>${esc(template.name)}</b>\n\n` +
        `${esc(template.description)}\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `🏪 <b>Kimlar uchun</b>\n   ${esc(copy?.useCases ?? "")}\n\n` +
        `👤 <b>Mijoz nimani ko'radi</b>\n${flow}\n\n` +
        `⚙️ <b>Siz nimani boshqarasiz</b>\n${tools}\n\n` +
        (copy?.needsBusinessPlan
          ? `💳 <b>Tarif:</b> biznes tarifi kerak (99 000 so'mdan). Sinov muddatida bepul ishlaydi.\n\n`
          : `💳 <b>Tarif:</b> har qanday tarifda ishlaydi.\n\n`) +
        (copy?.note ? `ℹ️ <i>${esc(copy.note)}</i>` : ""),
      {
        parse_mode: "HTML",
        reply_markup: await templateActions(ctx, template.key),
      },
    );
  });

  async function templateActions(ctx: Context, key: string): Promise<InlineKeyboard> {
    const owner = await ownerOf(ctx);
    const price = await priceOf(key);
    const may = await ownerMayUse(owner.id, key);
    const kb = new InlineKeyboard();
    if (may) {
      kb.text("✅ Shu botni yaratish", `p:tplgo:${key}`).row();
    } else if (price) {
      kb.text(`🔓 Ochish — ${money(price.priceUzs)}`, `p:tbuy:${key}`).row();
    }
    return kb.text("◀️ Boshqa shablonlar", "p:tpls");
  }

  // buying a template outright, from balance
  bot.callbackQuery(/^p:tbuy:(.+)$/, async (ctx) => {
    const key = ctx.match[1]!;
    const [owner, price, template] = await Promise.all([
      ownerOf(ctx),
      priceOf(key),
      Promise.resolve(templates[key]),
    ]);
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
    const [owner, price, template] = await Promise.all([ownerOf(ctx), priceOf(key), Promise.resolve(templates[key])]);
    if (!price || !template) return ctx.answerCallbackQuery("Topilmadi");

    try {
      const left = await charge(owner.id, price.priceUzs, "template", { note: template.name, refId: key });
      await db.ownerTemplate.create({
        data: { ownerId: owner.id, templateKey: key, pricePaid: price.priceUzs },
      });
      await ctx.answerCallbackQuery("Ochildi ✅");
      await ctx.editMessageText(
        `🔓 <b>Ochildi!</b>\n\n${template.emoji} ${esc(template.name)} endi sizniki.\n` +
          `Qolgan balans: <b>${money(left)}</b>`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text("✅ Shu botni yaratish", `p:tplgo:${key}`),
        },
      );
    } catch (err) {
      if (err instanceof InsufficientFunds) {
        return ctx.answerCallbackQuery({ text: "Balans yetarli emas", show_alert: true });
      }
      throw err;
    }
  });

  bot.callbackQuery("p:tpls", async (ctx) => {
    await ctx.answerCallbackQuery();
    const owner = await ownerOf(ctx);
    const lines = templateList.map((t) => `${t.emoji} <b>${esc(t.name)}</b> — ${esc(t.tagline)}`);
    await ctx.editMessageText(`🧩 <b>Shablon tanlang</b>\n\n${lines.join("\n\n")}`, {
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
        `   💬 Mijozlar savolига javob beraman → <b>Aloqa</b>\n` +
        `   🤖 Bir xil savol takrorlanaveradi → <b>Savol-javob</b>\n` +
        `   📋 Ariza/fikr yig'aman → <b>Anketa</b>\n\n` +
        `<i>Keyinroq boshqa shablonda yana bot yaratishingiz mumkin.</i>`,
      { parse_mode: "HTML", reply_markup: await templatePicker((await ownerOf(ctx)).id) },
    );
  });

  bot.callbackQuery(/^p:tplgo:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const template = templates[ctx.match[1]!];
    if (!template) return;

    const owner = await ownerOf(ctx);
    if (!(await ownerMayUse(owner.id, template.key))) {
      return void ctx.answerCallbackQuery({ text: "Bu shablon hali ochilmagan", show_alert: true });
    }

    setStep(SCOPE, ctx.from!.id, "await_token", { templateKey: template.key });
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
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard().text("◀️ Orqaga", `p:tpl:${template.key}`),
      },
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

    const row = (p: (typeof plans)[number]) => {
      const price = p.priceUzs === 0 ? "bepul" : `${money(p.priceUzs)}/oy`;
      const users = p.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ");
      return `<b>${esc(p.name)}</b> · ${price}\n   👥 ${users} obunachi — <i>${esc(PLAN_COPY[p.code]?.audience ?? "")}</i>`;
    };

    const text =
      `💳 <b>Tariflar</b>\n\n` +
      `Tariflar <b>ikki narsa</b> bilan farqlanadi:\n\n` +
      `1️⃣ <b>Nechta obunachi</b> — botingizga qancha odam qo'shila oladi. Limitga yetganda ` +
      `yangi odam qo'shilmaydi (eskilari ishlayveradi).\n` +
      `2️⃣ <b>Buyurtma qabul qilish</b> — do'kon boti uchun <b>biznes</b> tarifi kerak. ` +
      `Kino, reklama, navbat, aloqa, konkurs, savol-javob, anketa — <b>har qanday</b> tarifda ishlaydi.\n\n` +
      `Qolgan hamma narsa (broadcast, majburiy obuna, eksport, statistika) barcha tarifda bor.\n\n` +
      `━━━━━━━━━━━━━━\n\n` +
      `🎁 ${row(plans.find((p) => p.code === "trial")!)}\n   <i>Bir marta, karta so'ralmaydi</i>\n\n` +
      `📣 <b>KONTENT BOTLARI</b>\n\n` +
      plans.filter((p) => p.group === "standard").map(row).join("\n\n") +
      `\n\n🛒 <b>DO'KON BOTLARI</b> <i>(buyurtma qabul qiladi)</i>\n\n` +
      plans.filter((p) => p.group === "business").map(row).join("\n\n") +
      `\n\n━━━━━━━━━━━━━━\n\n` +
      `Batafsil ko'rish uchun tarif tugmasini bosing.`;

    const kb = new InlineKeyboard().text("🎯 Menga qaysi tarif mos?", "p:guide").row();
    plans
      .filter((p) => p.priceUzs > 0)
      .forEach((p, i) => {
        kb.text(p.name, `pd:${p.code}`);
        if (i % 2 === 1) kb.row();
      });
    kb.row().text("💳 To'lov qilish", "p:paypick").text("🪪 Kabinet", "cb:home");

    if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
    else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }

  // ---- single plan, in full
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
    const next = sameGroup[idx + 1];

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
        `👥 <b>${plan.maxBotUsers.toLocaleString("ru-RU").replace(/,/g, " ")}</b> obunachigacha\n` +
        `📢 Kuniga <b>${f.broadcastDailyLimit}</b> ta ommaviy xabar\n` +
        `🛒 Buyurtma qabul qilish: <b>${f.orders ? "bor" : "yo'q"}</b>\n` +
        `📥 Eksport, 🔒 majburiy obuna, 📊 statistika: <b>bor</b>\n\n` +
        `💡 Bir obunachi uchun: <b>${perUser(plan.priceUzs, plan.maxBotUsers)}/oy</b>\n\n` +
        `━━━━━━━━━━━━━━\n\n` +
        `<b>Muddat:</b>\n${terms}\n\n` +
        (prev
          ? `⬇️ <b>${esc(prev.name)}</b> (${money(prev.priceUzs)}) — ${prev.maxBotUsers} obunachi, arzonroq\n`
          : "") +
        (next
          ? `⬆️ <b>${esc(next.name)}</b> (${money(next.priceUzs)}) — ${next.maxBotUsers} obunachi, kengroq\n`
          : ""),
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("💳 Shu tarifni tanlash", "p:paypick")
          .row()
          .text("◀️ Barcha tariflar", "p:tariffs"),
      },
    );
  });

  // ---- two questions, then a concrete recommendation
  bot.callbackQuery("p:guide", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🎯 <b>Qaysi tarif mos?</b>\n\n1-savol: botingiz nima qiladi?`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("🛒 Buyurtma qabul qiladi", "pg:o:1")
          .row()
          .text("📣 Kontent, xabar, navbat, anketa", "pg:o:0")
          .row()
          .text("◀️ Orqaga", "p:tariffs"),
      },
    );
  });

  bot.callbackQuery(/^pg:o:([01])$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orders = ctx.match[1] === "1";
    await ctx.editMessageText(
      `🎯 <b>2-savol:</b> yaqin oylarda nechta obunachi kutyapsiz?\n\n` +
        `<i>Aniq bilmasangiz kamrog'ini tanlang — keyin istalgan vaqt oshirasiz, ` +
        `qolgan kunlar yo'qolmaydi.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: new InlineKeyboard()
          .text("500 gacha", `pg:u:${orders ? 1 : 0}:500`)
          .text("2 000", `pg:u:${orders ? 1 : 0}:2000`)
          .row()
          .text("5 000", `pg:u:${orders ? 1 : 0}:5000`)
          .text("15 000+", `pg:u:${orders ? 1 : 0}:15000`)
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
      return void ctx.editMessageText(
        `Bu hajm uchun alohida shart kerak — admin bilan bog'laning.`,
        { reply_markup: new InlineKeyboard().text("◀️ Tariflar", "p:tariffs") },
      );
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

  bot.hears("🤖 Botlarim", (ctx) => listBots(ctx));
  bot.hears("💵 Hisob to'ldirish", (ctx) => showWallet(ctx));
  bot.hears("📘 Qo'llanma", (ctx) => helpHome(ctx));
  bot.hears("📱 Ilova", async (ctx) => {
    const app = webAppButton("📱 Ilovani ochish");
    await ctx.reply(
      app
        ? "📱 <b>Botxona ilovasi</b>\n\nBarcha botlaringiz, statistika, grafiklar va balans — bitta ekranda."
        : "📱 Ilova hozircha tayyorlanmoqda.",
      { parse_mode: "HTML", reply_markup: app },
    );
  });

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
    if (config.WEB_APP_URL) {
      kb.webApp("📱 Ilovada ochish", `${config.WEB_APP_URL}?bot=${botId}`).row();
    }
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
    setStep(SCOPE, ctx.from!.id, "await_receipt", {
      botId: ctx.match[1], planCode: ctx.match[2], months: Number(ctx.match[3]),
    });
    await showCardInvoice(ctx, ctx.match[1]!, ctx.match[2]!, Number(ctx.match[3]));
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
    const state = getStep(SCOPE, ctx.from!.id);
    if (state?.data.topupAmount) {
      await submitTopup(ctx, bot.api, photo.file_id, ctx.message.caption);
      return;
    }
    await submitReceipt(ctx, bot.api, { fileId: photo.file_id, text: ctx.message.caption });
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
      const amount = Number(text.replace(/\D/g, ""));
      if (!amount || amount < 5000) {
        return void ctx.reply("Summa noto'g'ri. Kamida 5 000 so'm, faqat raqam yuboring.");
      }
      await showTopupInvoice(ctx, amount);
      return;
    }

    if (state.step === "await_receipt") {
      if (state.data.topupAmount) await submitTopup(ctx, bot.api, undefined, text);
      else await submitReceipt(ctx, bot.api, { text });
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

    // One record per Telegram bot. A revoked-and-regenerated token used to create
    // a second row, and both rows polled the same bot — Telegram then hands
    // updates to one poller at random and the bot looks broken.
    const twin = await db.bot.findFirst({ where: { tgBotId: BigInt(me.id) } });
    if (twin) {
      if (twin.ownerId !== owner.id) {
        return ctx.api
          .editMessageText(
            status.chat.id,
            status.message_id,
            "❌ Bu bot boshqa foydalanuvchida ro'yxatdan o'tgan. @BotFather'dan yangi bot oching.",
          )
          .then(() => undefined);
      }

      // Same owner re-adding their own bot: refresh the token in place.
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
          status: "active",
          lastError: null,
        },
      });
      clearStep(SCOPE, ctx.from!.id);
      await startBot(updated).catch(() => {});
      return ctx.api
        .editMessageText(
          status.chat.id,
          status.message_id,
          `♻️ <b>@${esc(me.username ?? "")}</b> allaqachon ro'yxatda edi — tokeni yangilandi va ` +
            `bot qayta ishga tushdi. Ma'lumotlaringiz saqlanib qoldi.`,
          { parse_mode: "HTML" },
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

    // A lone animated effect is the only animation a bot can play without a
    // Fragment username; it marks the moment the product actually starts.
    await ctx.reply("🎉", withEffect("party")).catch(() => {});
  }

  // ------------------------------------------------------------ platform admin

  bot.command("stat", async (ctx) => {
    if (!(await isAdmin(BigInt(ctx.from!.id)))) return;
    await ctx.reply("Boshqaruv paneli: /panel");
  });

  bot.catch((err) => log.error("platform bot error", { err: err.error }));

  return bot;
}

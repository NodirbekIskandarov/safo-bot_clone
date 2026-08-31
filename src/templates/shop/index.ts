import { InlineKeyboard, Keyboard } from "grammy";
import { db } from "../../db.js";
import { clearStep, getStep, setStep } from "../../lib/state.js";
import { esc, money, sendSafe } from "../../lib/telegram.js";
import { registerAdmin } from "../../runtime/admin.js";
import { registerBotSubscriptions } from "../../runtime/subscriptions.js";
import type { BotCtx, BotTemplate, TemplateContext } from "../../runtime/context.js";
import { REGIONS, regionById } from "./regions.js";

const SCOPE = "shop";
const CART = "shop_cart";
const DEFAULT_WELCOME = "🛒 Xush kelibsiz! Katalogdan mahsulot tanlang.";

interface CartLine {
  productId: string;
  title: string;
  priceUzs: number;
  qty: number;
}

function cartOf(ctx: BotCtx): CartLine[] {
  const state = getStep(CART, ctx.from!.id);
  return (state?.data.lines as CartLine[] | undefined) ?? [];
}

function saveCart(ctx: BotCtx, lines: CartLine[]) {
  setStep(CART, ctx.from!.id, "active", { lines });
}

function cartTotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.priceUzs * l.qty, 0);
}

function mainKeyboard(): Keyboard {
  return new Keyboard().text("🛍 Katalog").text("🧺 Savat").resized();
}

async function showCatalog(ctx: BotCtx) {
  const categories = await db.category.findMany({
    where: { botId: ctx.botId, isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  if (categories.length === 0) {
    const products = await db.product.findMany({ where: { botId: ctx.botId, isActive: true } });
    if (products.length === 0) return ctx.reply("Hozircha mahsulot yo'q. Tez orada qo'shiladi 🙌");
    return showProducts(ctx, null);
  }

  const kb = new InlineKeyboard();
  categories.forEach((c, i) => {
    kb.text(c.title, `sh:cat:${c.id}`);
    if (i % 2 === 1) kb.row();
  });
  await ctx.reply("🛍 <b>Katalog</b>\n\nBo'limni tanlang:", { parse_mode: "HTML", reply_markup: kb });
}

async function showProducts(ctx: BotCtx, categoryId: string | null) {
  const products = await db.product.findMany({
    where: { botId: ctx.botId, isActive: true, ...(categoryId ? { categoryId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 30,
  });

  if (products.length === 0) {
    await ctx.reply("Bu bo'limda mahsulot yo'q.");
    return;
  }

  for (const p of products) {
    const caption =
      `<b>${esc(p.title)}</b>\n` +
      (p.description ? `${esc(p.description)}\n` : "") +
      `\n💰 ${money(p.priceUzs)}`;
    const kb = new InlineKeyboard().text("🧺 Savatga qo'shish", `sh:add:${p.id}`);

    if (p.photoFileId) {
      await ctx.replyWithPhoto(p.photoFileId, { caption, parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.reply(caption, { parse_mode: "HTML", reply_markup: kb });
    }
  }
}

async function showCart(ctx: BotCtx, edit = false) {
  const lines = cartOf(ctx);
  if (lines.length === 0) {
    const text = "🧺 Savat bo'sh.";
    return edit ? ctx.editMessageText(text).catch(() => {}) : ctx.reply(text);
  }

  const body = lines
    .map((l, i) => `${i + 1}. ${esc(l.title)} — ${l.qty} × ${money(l.priceUzs)} = <b>${money(l.priceUzs * l.qty)}</b>`)
    .join("\n");

  const kb = new InlineKeyboard();
  lines.forEach((l, i) => {
    kb.text(`➖ ${i + 1}`, `sh:dec:${l.productId}`).text(`➕ ${i + 1}`, `sh:inc:${l.productId}`).row();
  });
  kb.text("✅ Buyurtma berish", "sh:checkout").row().text("🗑 Tozalash", "sh:clear");

  const text = `🧺 <b>Savat</b>\n\n${body}\n\n<b>Jami: ${money(cartTotal(lines))}</b>`;
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => {});
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

async function notifyAdmins(ctx: BotCtx, orderId: string) {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { botUser: true } });
  if (!order) return;

  const items = JSON.parse(order.items) as CartLine[];
  const body =
    `🆕 <b>Buyurtma #${order.number}</b>\n\n` +
    items.map((l) => `• ${esc(l.title)} × ${l.qty} = ${money(l.priceUzs * l.qty)}`).join("\n") +
    `\n\n<b>Jami: ${money(order.totalUzs)}</b>\n\n` +
    `👤 ${esc(order.botUser.firstName ?? "")}` +
    (order.botUser.username ? ` (@${esc(order.botUser.username)})` : "") +
    `\n📞 ${esc(order.phone)}\n` +
    `🚚 ${order.deliveryType === "delivery" ? "Yetkazib berish" : "Olib ketish"}` +
    (order.region ? `\n📍 ${esc(order.region)}, ${esc(order.district ?? "")}` : "") +
    (order.mahalla ? `\n🏘 ${esc(order.mahalla)}` : "") +
    (order.address ? `\n🏠 ${esc(order.address)}` : "") +
    (order.lat && order.lon ? `\n🗺 <a href="https://maps.google.com/?q=${order.lat},${order.lon}">Xaritada ochish</a>` : "");

  const kb = new InlineKeyboard()
    .text("✅ Tasdiqlash", `sh:ord:confirmed:${order.id}`)
    .text("❌ Bekor", `sh:ord:canceled:${order.id}`)
    .row()
    .text("📦 Yetkazildi", `sh:ord:done:${order.id}`);

  const admins = await db.botUser.findMany({ where: { botId: ctx.botId, isAdmin: true } });
  for (const admin of admins) {
    await sendSafe(
      () =>
        ctx.api.sendMessage(Number(admin.tgUserId), body, {
          parse_mode: "HTML",
          reply_markup: kb,
          link_preview_options: { is_disabled: true },
        }),
      { botId: ctx.botId, botUserId: admin.id },
    );
    // A pin the courier can open in their map app beats a copied address.
    if (order.lat && order.lon) {
      await sendSafe(() => ctx.api.sendLocation(Number(admin.tgUserId), order.lat!, order.lon!), {
        botId: ctx.botId, botUserId: admin.id,
      });
    }
  }
}

export const shopTemplate: BotTemplate = {
  key: "shop",
  emoji: "🛒",
  name: "Do'kon boti",
  tagline: "Katalog, savat, buyurtma — hammasi Telegram ichida",
  description:
    "Mahsulotlarni bot orqali qo'shasiz (rasm, narx, tavsif). Mijoz katalogdan tanlab savatga soladi, " +
    "telefon raqamini qoldiradi va buyurtma beradi. Sizga darhol xabar keladi — bir tugmada tasdiqlaysiz.",
  defaultSettings: { welcome: DEFAULT_WELCOME },
  commands: [
    { command: "start", description: "Boshlash" },
    { command: "katalog", description: "Katalog" },
    { command: "savat", description: "Savat" },
    { command: "buyurtmalarim", description: "Buyurtmalarim" },
  ],

  register({ bot }: TemplateContext) {
    bot.command("start", async (ctx) => {
      await ctx.reply((ctx.settings.welcome as string) || DEFAULT_WELCOME, { reply_markup: mainKeyboard() });
      if (ctx.isAdmin) {
        await ctx.reply("Admin panel: /admin");
      }
      await db.botEvent.create({ data: { botId: ctx.botId, botUserId: ctx.appUser.id, type: "start" } });
    });

    bot.hears("🛍 Katalog", (ctx) => showCatalog(ctx));
    bot.hears("🧺 Savat", (ctx) => showCart(ctx));

    bot.callbackQuery(/^sh:rg:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const region = regionById(ctx.match[1]!);
      if (!region) return;
      setStep(SCOPE, ctx.from!.id, "await_district", { region: region.name });

      const kb = new InlineKeyboard();
      region.districts.forEach((d, i) => {
        // index, not the name: district names blow past the 64-byte callback cap
        kb.text(d, `sh:dt:${region.id}:${i}`);
        if (i % 2 === 1) kb.row();
      });
      kb.row().text("◀️ Viloyatlar", "sh:rgback");

      await ctx.editMessageText(`🗺 <b>${esc(region.name)}</b>\n\nTuman yoki shaharni tanlang:`, {
        parse_mode: "HTML",
        reply_markup: kb,
      });
    });

    bot.callbackQuery("sh:rgback", async (ctx) => {
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard();
      REGIONS.forEach((r, i) => {
        kb.text(r.name, `sh:rg:${r.id}`);
        if (i % 2 === 1) kb.row();
      });
      await ctx.editMessageText("🗺 <b>Viloyatni tanlang:</b>", { parse_mode: "HTML", reply_markup: kb });
    });

    bot.callbackQuery(/^sh:dt:([^:]+):(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const region = regionById(ctx.match[1]!);
      const district = region?.districts[Number(ctx.match[2])];
      if (!region || !district) return;

      setStep(SCOPE, ctx.from!.id, "await_mahalla", { region: region.name, district });
      await ctx.editMessageText(`📍 ${esc(region.name)}, ${esc(district)}`, { parse_mode: "HTML" });
      await ctx.reply("🏘 <b>Mahalla yoki qishloq nomini yozing:</b>", { parse_mode: "HTML" });
    });

    bot.on("message:location", async (ctx, next) => {
      const state = getStep(SCOPE, ctx.from!.id);
      if (state?.step !== "await_location") return next();
      setStep(SCOPE, ctx.from!.id, "confirm", {
        lat: ctx.message.location.latitude,
        lon: ctx.message.location.longitude,
      });
      await finishOrder(ctx);
    });

    bot.callbackQuery(/^sh:cat:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await showProducts(ctx, ctx.match[1]!);
    });

    bot.callbackQuery(/^sh:add:(.+)$/, async (ctx) => {
      const product = await db.product.findFirst({ where: { id: ctx.match[1]!, botId: ctx.botId } });
      if (!product) return ctx.answerCallbackQuery("Mahsulot topilmadi");

      const lines = cartOf(ctx);
      const existing = lines.find((l) => l.productId === product.id);
      if (existing) existing.qty += 1;
      else lines.push({ productId: product.id, title: product.title, priceUzs: product.priceUzs, qty: 1 });
      saveCart(ctx, lines);

      await ctx.answerCallbackQuery(`🧺 Savatga qo'shildi (${cartOf(ctx).length} ta)`);
    });

    bot.callbackQuery(/^sh:(inc|dec):(.+)$/, async (ctx) => {
      const [, op, productId] = ctx.match;
      let lines = cartOf(ctx);
      const line = lines.find((l) => l.productId === productId);
      if (line) {
        line.qty += op === "inc" ? 1 : -1;
        if (line.qty <= 0) lines = lines.filter((l) => l.productId !== productId);
        saveCart(ctx, lines);
      }
      await ctx.answerCallbackQuery();
      await showCart(ctx, true);
    });

    bot.callbackQuery("sh:clear", async (ctx) => {
      clearStep(CART, ctx.from!.id);
      await ctx.answerCallbackQuery("Savat tozalandi");
      await ctx.editMessageText("🧺 Savat bo'sh.").catch(() => {});
    });

    // ------------------------------------------------------------ checkout

    bot.callbackQuery("sh:checkout", async (ctx) => {
      await ctx.answerCallbackQuery();
      if (cartOf(ctx).length === 0) return ctx.reply("Savat bo'sh.");
      setStep(SCOPE, ctx.from!.id, "await_phone");
      await ctx.reply("📞 Telefon raqamingizni yuboring:", {
        reply_markup: new Keyboard().requestContact("📞 Raqamni yuborish").resized().oneTime(),
      });
    });

    bot.on("message:contact", async (ctx, next) => {
      const state = getStep(SCOPE, ctx.from!.id);
      if (state?.step !== "await_phone") return next();
      setStep(SCOPE, ctx.from!.id, "await_delivery", { phone: ctx.message.contact.phone_number });
      await ctx.reply("🚚 Yetkazib berish kerakmi?", {
        reply_markup: new Keyboard().text("🚚 Yetkazib berish").text("🏪 Olib ketaman").resized().oneTime(),
      });
    });

    bot.on("message:text", async (ctx, next) => {
      const text = ctx.message.text.trim();
      if (text.startsWith("/")) return next();
      const state = getStep(SCOPE, ctx.from!.id);

      // ---- customer checkout steps
      if (state?.step === "await_phone") {
        setStep(SCOPE, ctx.from!.id, "await_delivery", { phone: text });
        return ctx.reply("🚚 Yetkazib berish kerakmi?", {
          reply_markup: new Keyboard().text("🚚 Yetkazib berish").text("🏪 Olib ketaman").resized().oneTime(),
        });
      }

      if (state?.step === "await_delivery") {
        const delivery = text.includes("Yetkaz") ? "delivery" : "pickup";
        if (delivery === "delivery") {
          setStep(SCOPE, ctx.from!.id, "await_region", { deliveryType: delivery });
          const kb = new InlineKeyboard();
          REGIONS.forEach((r, i) => {
            kb.text(r.name, `sh:rg:${r.id}`);
            if (i % 2 === 1) kb.row();
          });
          return ctx.reply("🗺 <b>Viloyatni tanlang:</b>", {
            parse_mode: "HTML",
            reply_markup: kb,
          });
        }
        setStep(SCOPE, ctx.from!.id, "confirm", { deliveryType: delivery });
        return finishOrder(ctx);
      }

      if (state?.step === "await_mahalla") {
        setStep(SCOPE, ctx.from!.id, "await_street", { mahalla: text });
        return ctx.reply(
          "🏠 Ko'cha va uy raqamini yozing:\n\n<i>Masalan: Amir Temur ko'chasi, 12-uy, 5-xonadon</i>",
          { parse_mode: "HTML" },
        );
      }

      if (state?.step === "await_street") {
        setStep(SCOPE, ctx.from!.id, "await_location", { address: text });
        return ctx.reply(
          "📍 <b>Oxirgi qadam</b>\n\nAniq joyni xaritada belgilang — kuryer adashmaydi.\n\n" +
            "<i>Xohlamasangiz «O'tkazib yuborish» bosing.</i>",
          {
            parse_mode: "HTML",
            reply_markup: new Keyboard()
              .requestLocation("📍 Lokatsiyani yuborish")
              .row()
              .text("⏭ O'tkazib yuborish")
              .resized()
              .oneTime(),
          },
        );
      }

      if (state?.step === "await_location" && text.includes("O'tkazib")) {
        return finishOrder(ctx);
      }

      // ---- admin wizards
      if (ctx.isAdmin) {
        const admin = getStep(`${SCOPE}_admin`, ctx.from!.id);

        if (admin?.step === "await_cat_title") {
          await db.category.create({ data: { botId: ctx.botId, title: text } });
          clearStep(`${SCOPE}_admin`, ctx.from!.id);
          return ctx.reply(`✅ "${esc(text)}" bo'limi qo'shildi.`, { parse_mode: "HTML" });
        }

        if (admin?.step === "await_prod_title") {
          setStep(`${SCOPE}_admin`, ctx.from!.id, "await_prod_price", { title: text });
          return ctx.reply("2-qadam: narxini yuboring (faqat raqam, so'mda). Masalan: 45000");
        }

        if (admin?.step === "await_prod_price") {
          const price = Number(text.replace(/\D/g, ""));
          if (!price) return ctx.reply("Narx noto'g'ri. Faqat raqam yuboring, masalan 45000");
          setStep(`${SCOPE}_admin`, ctx.from!.id, "await_prod_photo", { priceUzs: price });
          return ctx.reply("3-qadam: mahsulot rasmini yuboring.\n\nRasmsiz qo'shish uchun: /otkaz");
        }
      }

      return next();
    });

    bot.command("otkaz", async (ctx) => {
      if (!ctx.isAdmin) return;
      const admin = getStep(`${SCOPE}_admin`, ctx.from!.id);
      if (admin?.step !== "await_prod_photo") return;
      await saveProduct(ctx, null);
    });

    bot.on("message:photo", async (ctx, next) => {
      if (!ctx.isAdmin) return next();
      const admin = getStep(`${SCOPE}_admin`, ctx.from!.id);
      if (admin?.step !== "await_prod_photo") return next();
      const photo = ctx.message.photo.at(-1);
      await saveProduct(ctx, photo?.file_id ?? null);
    });

    async function saveProduct(ctx: BotCtx, photoFileId: string | null) {
      const admin = getStep(`${SCOPE}_admin`, ctx.from!.id);
      if (!admin) return;
      const category = await db.category.findFirst({ where: { botId: ctx.botId }, orderBy: { sortOrder: "asc" } });
      await db.product.create({
        data: {
          botId: ctx.botId,
          categoryId: category?.id ?? null,
          title: admin.data.title as string,
          priceUzs: admin.data.priceUzs as number,
          photoFileId,
        },
      });
      clearStep(`${SCOPE}_admin`, ctx.from!.id);
      await ctx.reply(`✅ "${esc(admin.data.title as string)}" qo'shildi.`, { parse_mode: "HTML" });
    }

    async function finishOrder(ctx: BotCtx) {
      const state = getStep(SCOPE, ctx.from!.id);
      const lines = cartOf(ctx);
      if (!state || lines.length === 0) return;

      const last = await db.order.findFirst({
        where: { botId: ctx.botId },
        orderBy: { number: "desc" },
        select: { number: true },
      });

      const order = await db.order.create({
        data: {
          botId: ctx.botId,
          botUserId: ctx.appUser.id,
          number: (last?.number ?? 0) + 1,
          items: JSON.stringify(lines),
          totalUzs: cartTotal(lines),
          deliveryType: (state.data.deliveryType as string) ?? "pickup",
          region: (state.data.region as string) ?? null,
          district: (state.data.district as string) ?? null,
          mahalla: (state.data.mahalla as string) ?? null,
          address: (state.data.address as string) ?? null,
          lat: (state.data.lat as number) ?? null,
          lon: (state.data.lon as number) ?? null,
          phone: (state.data.phone as string) ?? "—",
        },
      });

      clearStep(SCOPE, ctx.from!.id);
      clearStep(CART, ctx.from!.id);

      const where =
        order.deliveryType === "delivery"
          ? `\n📍 ${[order.region, order.district, order.mahalla, order.address].filter(Boolean).join(", ")}`
          : "\n🏪 Olib ketasiz";

      await ctx.reply(
        `✅ <b>Buyurtma qabul qilindi!</b>\n\n` +
          `Raqami: <b>#${order.number}</b>\nJami: <b>${money(order.totalUzs)}</b>${where}\n\n` +
          `Tez orada siz bilan bog'lanamiz.`,
        { parse_mode: "HTML", reply_markup: mainKeyboard() },
      );

      await notifyAdmins(ctx, order.id);
    }

    // --------------------------------------------------------- order status

    bot.callbackQuery(/^sh:ord:(\w+):(.+)$/, async (ctx) => {
      if (!ctx.isAdmin) return ctx.answerCallbackQuery("Ruxsat yo'q");
      const [, status, orderId] = ctx.match;
      const order = await db.order.update({
        where: { id: orderId! },
        data: { status: status! },
        include: { botUser: true },
      });
      await ctx.answerCallbackQuery("Holat yangilandi");

      const label: Record<string, string> = {
        confirmed: "✅ Buyurtmangiz tasdiqlandi!",
        canceled: "❌ Buyurtmangiz bekor qilindi.",
        done: "📦 Buyurtmangiz yetkazildi. Rahmat!",
      };
      await sendSafe(
        () =>
          ctx.api.sendMessage(
            Number(order.botUser.tgUserId),
            `${label[status!] ?? "Holat o'zgardi"}\n\nBuyurtma #${order.number}`,
          ),
        { botId: ctx.botId, botUserId: order.botUserId },
      );
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    });

    // ---------------------------------------------------------------- admin

    registerAdmin(bot, [
      ...registerBotSubscriptions(bot),
      {
        id: "prod_add",
        label: "➕ Mahsulot",
        handler: async (ctx) => {
          setStep(`${SCOPE}_admin`, ctx.from!.id, "await_prod_title");
          await ctx.editMessageText("➕ <b>Mahsulot qo'shish</b>\n\n1-qadam: nomini yuboring.", {
            parse_mode: "HTML",
          });
        },
      },
      {
        id: "cat_add",
        label: "📂 Bo'lim",
        handler: async (ctx) => {
          setStep(`${SCOPE}_admin`, ctx.from!.id, "await_cat_title");
          await ctx.editMessageText("📂 <b>Bo'lim qo'shish</b>\n\nBo'lim nomini yuboring.", { parse_mode: "HTML" });
        },
      },
      {
        id: "orders",
        label: "📦 Buyurtmalar",
        handler: async (ctx) => {
          const orders = await db.order.findMany({
            where: { botId: ctx.botId },
            orderBy: { createdAt: "desc" },
            take: 10,
          });
          const lines = orders.map(
            (o) => `#${o.number} — ${money(o.totalUzs)} — <i>${esc(o.status)}</i>`,
          );
          await ctx.editMessageText(`📦 <b>Oxirgi buyurtmalar</b>\n\n${lines.join("\n") || "Hali yo'q."}`, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().text("◀️ Orqaga", "adm:menu"),
          });
        },
      },
    ]);
  },
};

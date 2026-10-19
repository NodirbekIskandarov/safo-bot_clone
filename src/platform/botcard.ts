import { Api, InlineKeyboard, InputFile } from "grammy";
import type { Bot, Context } from "grammy";
import type { Bot as BotRecord } from "@prisma/client";
import { config } from "../config.js";
import { db } from "../db.js";
import { open } from "../lib/crypto.js";
import { log } from "../lib/log.js";
import { clearStep, getStep, resetStep } from "../lib/state.js";
import { esc, money } from "../lib/telegram.js";
import {
  instance, parseAdminIds, patchAdmins, patchSettings, startBot, stopBot,
} from "../runtime/registry.js";
import { templates } from "../templates/index.js";
import { accessFor, timeLeft } from "../billing/subscription.js";
import { dailyPrice, payablePlans } from "../billing/plans.js";
import { showPlansFor, showTerms } from "./payments.js";
import { DEFAULT_SLOTS, parseSlots } from "../templates/booking/index.js";

/**
 * The bot card: everything an owner does with one bot, on one screen —
 * settings, the bot's public profile, tariff, payment, auto-renew, stats.
 */

const SCOPE = "platform";

/** The bot, but only if the person tapping owns it. Callback data can be forged. */
async function ownedBot(ctx: Context, botId: string): Promise<BotRecord | null> {
  return db.bot.findFirst({ where: { id: botId, owner: { tgUserId: BigInt(ctx.from!.id) } } });
}

/** A Bot API client for the tenant bot, whether or not it is running right now. */
function tenantApi(record: BotRecord): Api {
  return (
    instance(record.id)?.api ??
    new Api(open({ cipher: record.tokenCipher, iv: record.tokenIv, tag: record.tokenTag }))
  );
}

async function show(ctx: Context, text: string, kb: InlineKeyboard) {
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } })
      .catch(async () => {
        // The card may sit on a photo message (receipt, profile picture): send fresh.
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
      });
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
  }
}

/** What one more day will cost when auto-renew fires. Trial bots renew on the cheapest fitting plan. */
async function renewalPlan(record: BotRecord, currentPriceUzs: number, users: number) {
  if (currentPriceUzs > 0) return { daily: dailyPrice(currentPriceUzs), monthly: currentPriceUzs };
  const options = await payablePlans(record.templateKey);
  const pick = options.filter((p) => p.maxBotUsers >= users).sort((a, b) => a.priceUzs - b.priceUzs)[0];
  return pick ? { daily: dailyPrice(pick.priceUzs), monthly: pick.priceUzs } : null;
}

// ------------------------------------------------------------------ the card

export async function showBotCard(ctx: Context, botId: string) {
  const record = await ownedBot(ctx, botId);
  if (!record) return void (ctx.callbackQuery ? ctx.editMessageText("Bot topilmadi.").catch(() => {}) : ctx.reply("Bot topilmadi."));

  const template = templates[record.templateKey];
  const [users, today, access] = await Promise.all([
    db.botUser.count({ where: { botId } }),
    db.botUser.count({ where: { botId, joinedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } }),
    accessFor(botId),
  ]);

  const statusText =
    record.status === "active" ? "🟢 Ishlayapti" : record.status === "error" ? "🔴 Xato" : "⚪️ To'xtatilgan";
  const subLabel: Record<string, string> = {
    trial: "🎁 Sinov muddati", active: "✅ To'langan", grace: "⚠️ Muddat tugadi (muhlat)",
    expired: "⛔️ To'lov kerak", unpaid: "⛔️ To'lov kerak", staff: "👑 Platforma",
  };

  let billing = "";
  let renewNote = "";
  if (access && access.status !== "staff") {
    const left = access.live ? timeLeft(access.endsAt) : null;
    const price = access.priceUzs > 0 ? `${money(access.priceUzs)}/oy` : "bepul (sinov)";
    billing =
      `📊 Tarif: <b>${esc(access.planName)}</b> — ${subLabel[access.status] ?? access.status}\n` +
      `💰 Narxi: <b>${price}</b>\n` +
      (left ? `⏳ Qoldi: <b>${left}</b>\n` : "");

    const renewal = await renewalPlan(record, access.priceUzs, users);
    if (renewal) {
      renewNote = access.autoRenew
        ? `\n🔁 <b>Avto uzaytirish yoqilgan.</b>\nMuddat tugashiga 1 soat qolganda balansdan 1 kunlik to'lov ` +
          `(<b>${money(renewal.daily)}</b>) yechiladi. Balansda pul bo'lsa, bot to'xtamaydi.`
        : `\n🔁 Avto uzaytirish o'chirilgan. Muddat tugasa bot 3 kunlik muhlatdan keyin to'xtaydi.`;
    }
  } else if (access?.status === "staff") {
    billing = `📊 Tarif: <b>${subLabel.staff}</b> — to'lov talab qilinmaydi\n`;
  }

  const limit = access && access.maxBotUsers < Number.MAX_SAFE_INTEGER ? ` / ${access.maxBotUsers}` : "";
  const text =
    `${template?.emoji ?? "🤖"} <b>@${esc(record.tgUsername)}</b>\n` +
    `━━━━━━━━━━━━━━\n` +
    `🧩 Shablon: ${esc(template?.name ?? record.templateKey)}\n` +
    `${statusText}\n` +
    billing +
    `👥 Obunachilar: <b>${users}${limit}</b>` + (today > 0 ? ` · bugun +${today}` : "") + `\n` +
    (record.lastError && record.status === "error" ? `<i>⚠️ ${esc(record.lastError.slice(0, 120))}</i>\n` : "") +
    renewNote +
    `\n\n<i>Kontent qo'shish: botingizni oching → /admin</i>`;

  const kb = new InlineKeyboard()
    .text("⚙️ Sozlash", `bc:set:${botId}`).row()
    .text("👤 Profil (nom, rasm)", `bc:prof:${botId}`).row()
    .text("📊 Tarif", `bc:plan:${botId}`).row()
    .text("💵 To'lov", `bc:pay:${botId}`).row();
  if (access && access.status !== "staff") {
    kb.text(`🔁 Avto uzaytirish: ${access.autoRenew ? "✅ Yoqilgan" : "❌ O'chirilgan"}`, `bc:ar:${botId}`).row();
  }
  if (config.WEB_APP_URL) kb.webApp("📈 Statistika (Web)", `${config.WEB_APP_URL}?bot=${botId}`).row();
  kb.text(record.status === "active" ? "⏸ To'xtatish" : "▶️ Ishga tushirish", `bc:tog:${botId}`).row()
    .text("⏪ Orqaga", "p:bots").text("🗑 O'chirish", `bc:del:${botId}`);

  await show(ctx, text, kb);
}

// ---------------------------------------------------------------- settings

async function showSettings(ctx: Context, record: BotRecord) {
  const settings = JSON.parse(record.settings || "{}") as Record<string, unknown>;
  const admins = parseAdminIds(record.adminIds);
  const welcome = (settings.welcome as string | undefined)?.slice(0, 120) ?? "—";
  const card = settings.payCard as string | undefined;

  let extra = "";
  const kb = new InlineKeyboard()
    .text("✏️ Salomlashuv matni", `bc:wel:${record.id}`).row()
    .text(`👥 Adminlar (${admins.length})`, `bc:adm:${record.id}`).row()
    .text("💳 Obuna uchun karta", `bc:card:${record.id}`).row();

  if (record.templateKey === "booking") {
    const services = Array.isArray(settings.services) ? (settings.services as string[]) : [];
    const slots = Array.isArray(settings.slots) ? (settings.slots as string[]) : DEFAULT_SLOTS;
    extra =
      `💈 Xizmatlar: ${esc(services.join(", ") || "standart")}\n` +
      `⏰ Ish vaqtlari: ${esc(slots.join(", "))}\n`;
    kb.text("💈 Xizmatlar", `bc:svc:${record.id}`).text("⏰ Ish vaqtlari", `bc:slots:${record.id}`).row();
  }
  kb.text("◀️ Orqaga", `p:bot:${record.id}`);

  await show(
    ctx,
    `⚙️ <b>Sozlash</b> — @${esc(record.tgUsername)}\n\n` +
      `✏️ Salomlashuv: <i>${esc(welcome)}</i>\n` +
      `👥 Adminlar: ${admins.map((a) => `<code>${a}</code>`).join(", ")}\n` +
      `💳 Karta: ${card ? `<code>${esc(card)}</code>` : "<i>sozlanmagan</i>"}\n` +
      extra +
      `\n<i>O'zgarishlar botda darhol kuchga kiradi — qayta ishga tushirish shart emas.</i>`,
    kb,
  );
}

async function showAdmins(ctx: Context, record: BotRecord) {
  const ids = parseAdminIds(record.adminIds);
  const owner = await db.owner.findUniqueOrThrow({ where: { id: record.ownerId } });
  const users = await db.botUser.findMany({ where: { botId: record.id, tgUserId: { in: ids } } });
  const byId = new Map(users.map((u) => [u.tgUserId.toString(), u]));

  const kb = new InlineKeyboard();
  for (const id of ids) {
    if (id === owner.tgUserId) continue;
    const u = byId.get(id.toString());
    kb.text(`➖ ${u?.firstName ?? id}`, `bc:admdel:${record.id}:${id}`).row();
  }
  kb.text("➕ Admin qo'shish", `bc:admadd:${record.id}`).row().text("◀️ Orqaga", `bc:set:${record.id}`);

  const lines = ids.map((id) => {
    const u = byId.get(id.toString());
    const who = u ? `${esc(u.firstName ?? "")}${u.username ? ` @${esc(u.username)}` : ""}` : "<i>botga hali kirmagan</i>";
    return `• <code>${id}</code> — ${who}${id === owner.tgUserId ? " 👑" : ""}`;
  });

  await show(
    ctx,
    `👥 <b>Bot adminlari</b>\n\n${lines.join("\n")}\n\n` +
      `Adminlar botda /admin panelini ko'radi: kontent qo'shadi, buyurtma va to'lovlarni tasdiqlaydi.\n` +
      `👑 — siz, olib tashlanmaysiz.`,
    kb,
  );
}

async function saveAdmins(record: BotRecord, ids: bigint[]) {
  await db.bot.update({ where: { id: record.id }, data: { adminIds: JSON.stringify(ids.map(String)) } });
  await db.botUser.updateMany({ where: { botId: record.id }, data: { isAdmin: false } });
  await db.botUser.updateMany({ where: { botId: record.id, tgUserId: { in: ids } }, data: { isAdmin: true } });
  patchAdmins(record.id, ids);
}

// ----------------------------------------------------------------- profile

async function showProfile(ctx: Context, record: BotRecord) {
  const api = tenantApi(record);
  const [name, description, short] = await Promise.all([
    api.getMyName().then((r) => r.name).catch(() => record.title),
    api.getMyDescription().then((r) => r.description).catch(() => ""),
    api.getMyShortDescription().then((r) => r.short_description).catch(() => ""),
  ]);

  await show(
    ctx,
    `👤 <b>Profil</b> — @${esc(record.tgUsername)}\n\n` +
      `🏷 Nom: <b>${esc(name)}</b>\n` +
      `📝 Tavsif: ${description ? `<i>${esc(description.slice(0, 200))}</i>` : "<i>yo'q</i>"}\n` +
      `💬 Bio: ${short ? `<i>${esc(short)}</i>` : "<i>yo'q</i>"}\n\n` +
      `<i>Tavsif — botni birinchi ochganda «Start» tugmasidan oldin ko'rinadigan matn.\n` +
      `Bio — bot profilida ko'rinadigan qisqa matn.</i>`,
    new InlineKeyboard()
      .text("🏷 Nom", `bc:pn:${record.id}`).text("🖼 Rasm", `bc:pp:${record.id}`).row()
      .text("📝 Tavsif", `bc:pd:${record.id}`).text("💬 Bio", `bc:ps:${record.id}`).row()
      .text("◀️ Orqaga", `p:bot:${record.id}`),
  );
}

// -------------------------------------------------------------- the wizard

const PROMPTS: Record<string, string> = {
  await_welcome:
    "✏️ <b>Salomlashuv matni</b>\n\nFoydalanuvchi /start bosganda ko'rinadigan matnni yuboring.",
  await_bot_admin:
    "➕ <b>Admin qo'shish</b>\n\nYangi adminning <b>Telegram ID</b> raqamini yuboring.\n<i>ID ni @userinfobot beradi.</i>",
  await_tenant_card:
    "💳 <b>Obuna uchun karta</b>\n\nBotingizda obuna sotsangiz, obunachilar shu kartaga to'laydi.\n\n" +
    "<code>8600 1234 5678 9012\nISM FAMILIYA</code>\n\n<i>O'chirish uchun: 0</i>",
  await_services: "💈 <b>Xizmatlar</b>\n\nHar bir xizmatni <b>yangi qatordan</b> yozing.",
  await_slots:
    "⏰ <b>Ish vaqtlari</b>\n\nMijoz tanlay oladigan soatlarni yozing:\n\n<code>09:00 10:00 11:00 14:00 15:00</code>",
  await_bot_name: "🏷 <b>Bot nomi</b>\n\nYangi nomni yuboring (64 belgigacha).",
  await_bot_desc: "📝 <b>Tavsif</b>\n\nYangi tavsifni yuboring (512 belgigacha). O'chirish uchun: 0",
  await_bot_short: "💬 <b>Bio</b>\n\nQisqa matn yuboring (120 belgigacha). O'chirish uchun: 0",
  await_bot_photo: "🖼 <b>Rasm</b>\n\nBot profili uchun rasm yuboring (oddiy rasm sifatida, fayl emas).",
};

async function ask(ctx: Context, record: BotRecord, step: string, back: string) {
  resetStep(SCOPE, ctx.from!.id, step, { botId: record.id });
  await show(ctx, `${PROMPTS[step]}\n\nBekor: /bekor`, new InlineKeyboard().text("◀️ Orqaga", back));
}

/** Text typed while inside a bot-card wizard. Returns true when consumed. */
export async function handleBotCardText(ctx: Context, text: string): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (!state || !(state.step in PROMPTS) || state.step === "await_bot_photo") return false;
  const record = await ownedBot(ctx, state.data.botId as string);
  if (!record) {
    clearStep(SCOPE, ctx.from!.id);
    return true;
  }
  const done = async (msg: string, back = `bc:set:${record.id}`) => {
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply(msg, { reply_markup: new InlineKeyboard().text("◀️ Orqaga", back) });
  };
  const clearing = text === "0";

  /** Validation failed: say why and stay on the same step. */
  const retry = async (msg: string) => {
    await ctx.reply(msg);
  };

  try {
    switch (state.step) {
      case "await_welcome":
        await patchSettings(record.id, { welcome: text.slice(0, 3000) });
        await done("✅ Salomlashuv matni yangilandi.");
        break;

      case "await_bot_admin": {
        const id = text.replace(/\D/g, "");
        if (!id) {
          await retry("ID faqat raqamlardan iborat bo'lishi kerak.");
          break;
        }
        const ids = parseAdminIds(record.adminIds);
        if (ids.length >= 10) {
          await done("Ko'pi bilan 10 ta admin bo'lishi mumkin.", `bc:adm:${record.id}`);
          break;
        }
        if (!ids.includes(BigInt(id))) ids.push(BigInt(id));
        await saveAdmins(record, ids);
        const template = templates[record.templateKey];
        await tenantApi(record)
          .setMyCommands(
            [...(template?.commands ?? []), { command: "admin", description: "⚙️ Admin panel" }],
            { scope: { type: "chat", chat_id: Number(id) } },
          )
          .catch(() => {});
        await done(`✅ ${id} admin qilindi. U @${record.tgUsername} botida /admin yuborsin.`, `bc:adm:${record.id}`);
        break;
      }

      case "await_tenant_card": {
        if (clearing) {
          await patchSettings(record.id, { payCard: null, payCardHolder: null });
          await done("✅ Karta o'chirildi.");
          break;
        }
        const [card, ...rest] = text.split("\n");
        const digits = (card ?? "").replace(/\D/g, "");
        if (digits.length < 12) {
          await retry("Karta raqami noto'g'ri. Kamida 12 ta raqam bo'lishi kerak.");
          break;
        }
        await patchSettings(record.id, {
          payCard: digits.replace(/(\d{4})(?=\d)/g, "$1 "),
          ...(rest.length > 0 ? { payCardHolder: rest.join(" ").trim() } : {}),
        });
        await done("✅ Karta saqlandi.");
        break;
      }

      case "await_services": {
        const list = text.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 20);
        if (list.length === 0) {
          await retry("Kamida bitta xizmat yozing.");
          break;
        }
        await patchSettings(record.id, { services: list });
        await done(`✅ ${list.length} ta xizmat saqlandi.`);
        break;
      }

      case "await_slots": {
        const slots = parseSlots(text);
        if (!slots) {
          await retry("Format: 09:00 10:00 14:30 — soatlarni bo'sh joy bilan yozing.");
          break;
        }
        await patchSettings(record.id, { slots });
        await done(`✅ Ish vaqtlari: ${slots.join(", ")}`);
        break;
      }

      case "await_bot_name": {
        const name = text.slice(0, 64);
        await tenantApi(record).setMyName(name);
        await db.bot.update({ where: { id: record.id }, data: { title: name } });
        await done("✅ Nom o'zgardi.", `bc:prof:${record.id}`);
        break;
      }

      case "await_bot_desc":
        await tenantApi(record).setMyDescription(clearing ? "" : text.slice(0, 512));
        await done("✅ Tavsif yangilandi.", `bc:prof:${record.id}`);
        break;

      case "await_bot_short":
        await tenantApi(record).setMyShortDescription(clearing ? "" : text.slice(0, 120));
        await done("✅ Bio yangilandi.", `bc:prof:${record.id}`);
        break;
    }
  } catch (err) {
    // Telegram rate-limits profile edits hard (a few per day); say so plainly.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("bot card edit failed", { botId: record.id, step: state.step, msg });
    clearStep(SCOPE, ctx.from!.id);
    await ctx.reply(
      /Too Many Requests|retry after/i.test(msg)
        ? "⏳ Telegram bu o'zgarishni hozircha cheklab qo'ydi. Birozdan keyin qayta urinib ko'ring."
        : "❌ Saqlab bo'lmadi. Bot ishlayotganini tekshirib, qayta urinib ko'ring.",
    );
  }
  return true;
}

/** Profile photo sent while the photo wizard is open. Returns true when consumed. */
export async function handleBotCardPhoto(ctx: Context, fileId: string): Promise<boolean> {
  const state = getStep(SCOPE, ctx.from!.id);
  if (state?.step !== "await_bot_photo") return false;
  const record = await ownedBot(ctx, state.data.botId as string);
  clearStep(SCOPE, ctx.from!.id);
  if (!record) return true;

  try {
    // file_id belongs to the platform bot; the tenant bot needs the bytes.
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${config.PLATFORM_BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await tenantApi(record).setMyProfilePhoto({ type: "static", photo: new InputFile(bytes, "photo.jpg") });
    await ctx.reply("✅ Rasm o'rnatildi. Telegram uni bir necha daqiqada yangilaydi.", {
      reply_markup: new InlineKeyboard().text("◀️ Profil", `bc:prof:${record.id}`),
    });
  } catch (err) {
    log.warn("profile photo failed", { botId: record.id, err });
    await ctx.reply("❌ Rasmni o'rnatib bo'lmadi. Boshqa rasm bilan urinib ko'ring.");
  }
  return true;
}

// --------------------------------------------------------------- handlers

export function registerBotCard(bot: Bot) {
  const withBot = (
    pattern: RegExp,
    fn: (ctx: Context, record: BotRecord, match: RegExpMatchArray) => Promise<unknown>,
  ) =>
    bot.callbackQuery(pattern, async (ctx) => {
      const match = ctx.match as RegExpMatchArray;
      const record = await ownedBot(ctx, match[1]!);
      if (!record) return void ctx.answerCallbackQuery("Bot topilmadi");
      await fn(ctx, record, match);
    });

  bot.callbackQuery(/^p:bot:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showBotCard(ctx, ctx.match[1]!);
  });

  withBot(/^bc:set:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showSettings(ctx, r);
  });
  withBot(/^bc:wel:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_welcome", `bc:set:${r.id}`);
  });
  withBot(/^bc:card:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_tenant_card", `bc:set:${r.id}`);
  });
  withBot(/^bc:svc:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_services", `bc:set:${r.id}`);
  });
  withBot(/^bc:slots:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_slots", `bc:set:${r.id}`);
  });

  withBot(/^bc:adm:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showAdmins(ctx, r);
  });
  withBot(/^bc:admadd:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_bot_admin", `bc:adm:${r.id}`);
  });
  withBot(/^bc:admdel:([^:]+):(\d+)$/, async (ctx, r, m) => {
    const owner = await db.owner.findUniqueOrThrow({ where: { id: r.ownerId } });
    const target = BigInt(m[2]!);
    if (target === owner.tgUserId) return void ctx.answerCallbackQuery("Egasini olib bo'lmaydi");
    await saveAdmins(r, parseAdminIds(r.adminIds).filter((id) => id !== target));
    await tenantApi(r).deleteMyCommands({ scope: { type: "chat", chat_id: Number(target) } }).catch(() => {});
    await ctx.answerCallbackQuery("Olib tashlandi");
    await showAdmins(ctx, (await db.bot.findUniqueOrThrow({ where: { id: r.id } })));
  });

  withBot(/^bc:prof:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    clearStep(SCOPE, ctx.from!.id);
    await showProfile(ctx, r);
  });
  withBot(/^bc:pn:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_bot_name", `bc:prof:${r.id}`);
  });
  withBot(/^bc:pd:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_bot_desc", `bc:prof:${r.id}`);
  });
  withBot(/^bc:ps:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_bot_short", `bc:prof:${r.id}`);
  });
  withBot(/^bc:pp:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await ask(ctx, r, "await_bot_photo", `bc:prof:${r.id}`);
  });

  withBot(/^bc:plan:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    const access = await accessFor(r.id);
    const users = await db.botUser.count({ where: { botId: r.id } });
    const plan = access ? await db.plan.findUnique({ where: { code: access.planCode } }) : null;
    const features = plan ? (JSON.parse(plan.features) as { broadcastDailyLimit: number; orders: boolean }) : null;
    await show(
      ctx,
      `📊 <b>Tarif</b> — @${esc(r.tgUsername)}\n\n` +
        (access && plan && features
          ? `📦 <b>${esc(access.planName)}</b>\n` +
            `💰 ${plan.priceUzs > 0 ? `${money(plan.priceUzs)}/oy` : "bepul"}\n` +
            `👥 Obunachi limiti: <b>${users} / ${access.maxBotUsers < Number.MAX_SAFE_INTEGER ? access.maxBotUsers : "∞"}</b>\n` +
            `📢 Kuniga ommaviy xabar: <b>${features.broadcastDailyLimit}</b> ta\n` +
            `🛒 Buyurtma qabul qilish: <b>${features.orders ? "bor" : "yo'q"}</b>\n`
          : "Tarif topilmadi.\n") +
        `\n<i>Tarifni o'zgartirsangiz qolgan kunlar yo'qolmaydi.</i>`,
      new InlineKeyboard()
        .text("🔄 Tarifni o'zgartirish", `p:pay:${r.id}`).row()
        .text("◀️ Orqaga", `p:bot:${r.id}`),
    );
  });

  withBot(/^bc:pay:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    const access = await accessFor(r.id);
    // Renewing the plan you already have is the common case: skip the list.
    if (access && access.priceUzs > 0) {
      const fits = (await payablePlans(r.templateKey)).some((p) => p.code === access.planCode);
      if (fits) return showTerms(ctx, r.id, access.planCode);
    }
    await showPlansFor(ctx, r.id);
  });

  withBot(/^bc:ar:(.+)$/, async (ctx, r) => {
    const sub = await db.subscription.findUnique({ where: { botId: r.id } });
    if (!sub) return void ctx.answerCallbackQuery("Obuna topilmadi");
    await db.subscription.update({ where: { id: sub.id }, data: { autoRenew: !sub.autoRenew } });
    await ctx.answerCallbackQuery(sub.autoRenew ? "Avto uzaytirish o'chirildi" : "Avto uzaytirish yoqildi");
    await showBotCard(ctx, r.id);
  });

  withBot(/^bc:tog:(.+)$/, async (ctx, r) => {
    if (r.status === "active") {
      await stopBot(r.id);
      await db.bot.update({ where: { id: r.id }, data: { status: "stopped" } });
      await ctx.answerCallbackQuery("To'xtatildi");
    } else {
      const access = await accessFor(r.id);
      if (access && !access.live) {
        return void ctx.answerCallbackQuery({ text: "Obuna muddati tugagan. Avval to'lov qiling.", show_alert: true });
      }
      const updated = await db.bot.update({ where: { id: r.id }, data: { status: "active", lastError: null } });
      try {
        await startBot(updated);
        await ctx.answerCallbackQuery("Ishga tushdi");
      } catch (err) {
        await db.bot.update({
          where: { id: r.id },
          data: { status: "error", lastError: err instanceof Error ? err.message : String(err) },
        });
        await ctx.answerCallbackQuery("Ishga tushmadi");
      }
    }
    await showBotCard(ctx, r.id);
  });

  withBot(/^bc:del:(.+)$/, async (ctx, r) => {
    await ctx.answerCallbackQuery();
    await show(
      ctx,
      `🗑 <b>@${esc(r.tgUsername)} o'chirilsinmi?</b>\n\nBot va uning <b>barcha</b> ma'lumotlari o'chadi: ` +
        `foydalanuvchilar, kinolar, mahsulotlar, buyurtmalar, javoblar.\n\n<b>Bu qaytarilmaydi.</b>`,
      new InlineKeyboard().text("🗑 Ha, o'chirilsin", `bc:delyes:${r.id}`).text("◀️ Yo'q", `p:bot:${r.id}`),
    );
  });

  withBot(/^bc:delyes:(.+)$/, async (ctx, r) => {
    await stopBot(r.id);
    await db.bot.delete({ where: { id: r.id } });
    await ctx.answerCallbackQuery("O'chirildi");
    await ctx.editMessageText("🗑 Bot o'chirildi.", {
      reply_markup: new InlineKeyboard().text("🤖 Botlarim", "p:bots"),
    }).catch(() => {});
    log.info("bot deleted", { botId: r.id, ownerId: r.ownerId });
  });
}

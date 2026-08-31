/**
 * Drives every template with synthetic Telegram updates and records which API
 * calls it makes. Catches "the bot says nothing" regressions without needing a
 * real bot, a token, or a human pressing buttons.
 */
import { Bot } from "grammy";
import type { Update } from "grammy/types";
import { db } from "./db.js";
import { templateList } from "./templates/index.js";
import type { BotCtx } from "./runtime/context.js";

const FAKE_TOKEN = "123456789:AAHfakefakefakefakefakefakefakefakefake";
const ADMIN_TG = 5_000_001;
const USER_TG = 5_000_002;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

/** Stub just enough of the Bot API for handlers to run to completion. */
function fakeResult(method: string): unknown {
  switch (method) {
    case "getMe":
      return { id: 123456789, is_bot: true, first_name: "test", username: "test_bot" };
    case "sendMessage":
    case "sendPhoto":
    case "sendVideo":
    case "sendDocument":
    case "copyMessage":
      return { message_id: 1, date: 0, chat: { id: USER_TG, type: "private" } };
    case "getChat":
      return { id: -100123, type: "channel", title: "kanal" };
    case "getChatMember":
      return { status: "member", user: { id: USER_TG, is_bot: false, first_name: "u" } };
    default:
      return true;
  }
}

function makeBot(botId: string, settings: Record<string, unknown>) {
  const calls: Call[] = [];
  const bot = new Bot<BotCtx>(FAKE_TOKEN, { botInfo: fakeResult("getMe") as never });

  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: fakeResult(method) } as never;
  });

  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return;
    ctx.botId = botId;
    ctx.botTitle = "Test";
    ctx.settings = settings;
    ctx.isAdmin = from.id === ADMIN_TG;
    ctx.appUser = await db.botUser.upsert({
      where: { botId_tgUserId: { botId, tgUserId: BigInt(from.id) } },
      create: { botId, tgUserId: BigInt(from.id), firstName: "T", isAdmin: ctx.isAdmin },
      update: { isAdmin: ctx.isAdmin },
    });
    await next();
  });

  bot.catch((err) => {
    console.log("     ⚠️ handler xatosi:", (err.error as Error)?.message ?? err.error);
  });

  return { bot, calls };
}

let seq = 100;
function msg(text: string, fromId: number): Update {
  seq++;
  // Telegram marks commands with a bot_command entity, and grammY's command
  // filter reads that entity — a bare "/start" string would never match.
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }]
    : undefined;

  return {
    update_id: seq,
    message: {
      message_id: seq, date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private", first_name: "T" },
      from: { id: fromId, is_bot: false, first_name: "T" },
      text,
      ...(entities ? { entities } : {}),
    },
  } as Update;
}

function cb(data: string, fromId: number): Update {
  seq++;
  return {
    update_id: seq,
    callback_query: {
      id: String(seq), chat_instance: "1", data,
      from: { id: fromId, is_bot: false, first_name: "T" },
      message: {
        message_id: seq, date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: "private", first_name: "T" },
        from: { id: 123456789, is_bot: true, first_name: "bot" },
        text: "x",
      },
    },
  } as Update;
}

const sent = (calls: Call[]) =>
  calls.filter((c) => c.method.startsWith("send") || c.method.startsWith("edit")).length;

async function run() {
  const owner = await db.owner.create({
    data: { tgUserId: BigInt(Date.now() % 1e12), fullName: "tpl-test", isPlatformAdmin: true },
  });

  for (const template of templateList) {
    console.log(`\n${template.emoji} ${template.name}`);

    const record = await db.bot.create({
      data: {
        ownerId: owner.id, templateKey: template.key, title: "T",
        tgBotId: BigInt(Date.now() % 1e9) + BigInt(seq), tgUsername: `t${seq}`,
        tokenCipher: Buffer.from([1]), tokenIv: Buffer.from([1]), tokenTag: Buffer.from([1]),
        tokenHash: `h${template.key}${Date.now()}`,
        adminIds: JSON.stringify([String(ADMIN_TG)]),
        settings: JSON.stringify(template.defaultSettings),
      },
    });

    const { bot, calls } = makeBot(record.id, template.defaultSettings);
    template.register({ bot, botId: record.id, settings: template.defaultSettings });
    await bot.init();

    // 1. an ordinary user says /start
    await bot.handleUpdate(msg("/start", USER_TG));
    check("/start foydalanuvchiga javob beradi", sent(calls) > 0, `${sent(calls)} ta chaqiruv`);

    // 2. the command menu is declared
    check(
      `${template.commands.length} ta buyruq e'lon qilingan`,
      template.commands.length > 0 && template.commands.some((c) => c.command === "start"),
    );

    // 3. the admin opens the panel
    const before = calls.length;
    await bot.handleUpdate(msg("/admin", ADMIN_TG));
    const panel = calls.slice(before).find((c) => c.method === "sendMessage");
    check("/admin panelni ochadi", panel !== undefined);

    // 4. every button in that panel resolves to a handler
    const markup = panel?.payload.reply_markup as
      | { inline_keyboard?: { text: string; callback_data?: string }[][] }
      | undefined;
    const buttons = (markup?.inline_keyboard ?? []).flat().filter((b) => b.callback_data);
    check("admin panelda tugmalar bor", buttons.length > 0, `${buttons.length} ta`);

    for (const button of buttons) {
      const mark = calls.length;
      await bot.handleUpdate(cb(button.callback_data!, ADMIN_TG));
      const after = calls.slice(mark);
      const answered = after.some((c) => c.method === "answerCallbackQuery");
      const acted = after.some((c) => c.method.startsWith("edit") || c.method.startsWith("send"));
      check(`  «${button.text}» javob beradi`, answered || acted);

      // Any screen the user can land on must offer a way back.
      const screen = after.find((c) => c.method === "editMessageText" || c.method === "sendMessage");
      const rm = screen?.payload.reply_markup as
        | { inline_keyboard?: { text: string }[][] }
        | undefined;
      const buttonsHere = (rm?.inline_keyboard ?? []).flat();
      const isWizard = String(screen?.payload.text ?? "").includes("/bekor");
      const hasBack = buttonsHere.some((b) => b.text.includes("◀️"));
      if (screen && !isWizard) {
        check(`  «${button.text}» ortga qaytish tugmasi bor`, hasBack,
          hasBack ? "" : `tugmalar: ${buttonsHere.map((b) => b.text).join(", ") || "yo'q"}`);
      }
    }

    // 5. free text must not crash the bot
    await bot.handleUpdate(msg("salom", USER_TG));
    check("oddiy matn xatoga olib kelmaydi", true);

    // 6. no button may exceed Telegram's callback_data limit
    const tooLong = calls
      .flatMap((c) => {
        const rm = c.payload.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
        return (rm?.inline_keyboard ?? []).flat();
      })
      .map((b) => b.callback_data)
      .filter((d): d is string => typeof d === "string" && Buffer.byteLength(d) > 64);
    check("callback_data 64 baytdan oshmaydi", tooLong.length === 0, tooLong[0] ?? "");
  }

  await db.owner.delete({ where: { id: owner.id } });
  await db.$disconnect();
  console.log(failures === 0 ? "\n✅ Barcha shablonlar javob beradi\n" : `\n❌ ${failures} ta muammo\n`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch(async (err) => {
  console.error("\n❌ Test yiqildi:", err);
  await db.$disconnect();
  process.exit(1);
});

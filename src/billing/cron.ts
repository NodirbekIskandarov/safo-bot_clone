import type { Api } from "grammy";
import { db } from "../db.js";
import { log } from "../lib/log.js";
import { sendSafe } from "../lib/telegram.js";
import { stopBot } from "../runtime/registry.js";
import { billingTick } from "./subscription.js";

const HOUR_MS = 60 * 60 * 1000;

async function tick(api: Api) {
  try {
    const events = await billingTick();

    for (const e of events) {
      if (e.kind === "stopped") {
        await stopBot(e.botId);
        await db.bot.update({ where: { id: e.botId }, data: { status: "stopped" } });
      }

      const text =
        e.kind === "warn"
          ? `⏳ <b>Eslatma</b>\n\n@${e.botUsername} obunasi <b>${e.daysLeft} kundan</b> keyin tugaydi.\n\n` +
            `«🤖 Mening botlarim» → «💳 To'lov qilish»`
          : e.kind === "grace"
            ? `⚠️ <b>Obuna muddati tugadi</b>\n\n@${e.botUsername} hozircha ishlayapti, lekin <b>${e.daysLeft} kundan</b> ` +
              `keyin to'xtatiladi.\n\nTo'lov qilsangiz hech narsa yo'qolmaydi.`
            : `⛔️ <b>Bot to'xtatildi</b>\n\n@${e.botUsername} obunasi to'lanmadi.\n\n` +
              `Ma'lumotlaringiz saqlanib turibdi — to'lov qilsangiz bot o'sha zahoti qayta ishlaydi.`;

      await sendSafe(() => api.sendMessage(Number(e.ownerTgId), text, { parse_mode: "HTML" }));
    }
  } catch (err) {
    log.error("billing tick failed", { err });
  }
}

/** Runs hourly. Every transition is conditional, so a missed or doubled run is harmless. */
export function startBillingCron(api: Api): NodeJS.Timeout {
  void tick(api);
  const timer = setInterval(() => void tick(api), HOUR_MS);
  timer.unref();
  return timer;
}

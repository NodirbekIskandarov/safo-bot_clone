import { config } from "./config.js";
import { db } from "./db.js";
import { resumeBroadcasts } from "./jobs/broadcast.js";
import { log } from "./lib/log.js";
import { createPlatformBot } from "./platform/bot.js";
import { instance, startAll, stopAll } from "./runtime/registry.js";
import { seedPlans } from "./billing/plans.js";
import { seedTemplatePrices } from "./billing/templates.js";
import { backfillSubscriptions } from "./billing/subscription.js";
import { startBillingCron } from "./billing/cron.js";
import { startWebServer } from "./web/server.js";

async function main() {
  if (!config.PLATFORM_BOT_TOKEN) {
    console.error(`
  ❌ PLATFORM_BOT_TOKEN topilmadi.

     1. Telegram'da @BotFather ni oching
     2. /newbot yuboring, nom va username bering
     3. Olingan tokenni .env fayliga yozing:

        PLATFORM_BOT_TOKEN=1234567890:AAF...

     4. Qayta ishga tushiring: npm start
`);
    process.exit(1);
  }

  // getMe first: the referral link needs the bot's own username.
  const probe = new (await import("grammy")).Api(config.PLATFORM_BOT_TOKEN);
  const me = await probe.getMe();
  const platform = createPlatformBot(me.username ?? "");

  // The blue "Menu" button in Telegram — without this users must guess commands.
  await platform.api
    .setMyCommands([
      { command: "start", description: "🏠 Bosh sahifa" },
      { command: "kabinet", description: "🪪 Shaxsiy kabinet" },
      { command: "referal", description: "🗣 Referal dasturi" },
      { command: "yordam", description: "📘 Qo'llanma" },
      { command: "bekor", description: "❌ Amalni bekor qilish" },
    ])
    .catch(() => {});

  if (config.WEB_APP_URL) {
    await platform.api
      .setChatMenuButton({
        menu_button: { type: "web_app", text: "📱 Ilova", web_app: { url: config.WEB_APP_URL } },
      })
      .catch(() => {});
  }

  for (const adminId of config.platformAdminIds) {
    await platform.api
      .setMyCommands(
        [
          { command: "start", description: "🏠 Bosh sahifa" },
          { command: "panel", description: "🛠 Boshqaruv paneli" },
          { command: "kabinet", description: "🪪 Shaxsiy kabinet" },
          { command: "referal", description: "🗣 Referal dasturi" },
          { command: "yordam", description: "📘 Qo'llanma" },
          { command: "bekor", description: "❌ Amalni bekor qilish" },
        ],
        { scope: { type: "chat", chat_id: Number(adminId) } },
      )
      .catch(() => {});
  }

  await seedPlans();
  await seedTemplatePrices();
  await backfillSubscriptions();
  await startAll();
  await resumeBroadcasts((botId) => instance(botId)?.api);
  startBillingCron(platform.api);
  startWebServer(config.WEB_PORT, config.WEB_HOST);

  void platform.start({
    onStart: () => log.info("platform bot started", { username: me.username }),
    drop_pending_updates: true,
  });

  console.log(`
  ✅ BotPlatform ishga tushdi

     Platforma boti : https://t.me/${me.username}
     Ishlab turgan botlar: ${(await db.bot.count({ where: { status: "active" } }))}

     To'xtatish: Ctrl+C
`);

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    await platform.stop().catch(() => {});
    await stopAll();
    await db.$disconnect();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err });
  console.error(err);
  process.exit(1);
});

// A single unhandled rejection must not take the whole platform down.
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { reason }));

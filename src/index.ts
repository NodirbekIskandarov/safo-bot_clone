import { config } from "./config.js";
import { db } from "./db.js";
import { resumeBroadcasts } from "./jobs/broadcast.js";
import { log } from "./lib/log.js";
import { createPlatformBot } from "./platform/bot.js";
import { instance, startAll, stopAll } from "./runtime/registry.js";

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

  const platform = createPlatformBot();
  const me = await platform.api.getMe();

  // The blue "Menu" button in Telegram — without this users must guess commands.
  await platform.api
    .setMyCommands([
      { command: "start", description: "Boshlash" },
      { command: "yordam", description: "Yordam" },
      { command: "bekor", description: "Amalni bekor qilish" },
    ])
    .catch(() => {});

  await startAll();
  await resumeBroadcasts((botId) => instance(botId)?.api);

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

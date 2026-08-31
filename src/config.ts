import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Validated at boot in index.ts, not here: tooling like `npm run check` must
  // work before a token exists.
  PLATFORM_BOT_TOKEN: z.string().default(""),
  ENCRYPTION_KEY: z.string().min(40, "ENCRYPTION_KEY is missing — run `npm run keygen`"),
  DATABASE_URL: z.string().default("file:../data/app.db"),
  PLATFORM_ADMIN_IDS: z.string().default(""),
  MAX_BOTS_PER_OWNER: z.coerce.number().int().positive().default(5),
  BROADCAST_RATE_PER_SEC: z.coerce.number().int().min(1).max(30).default(20),
  LOG_LEVEL: z.string().default("info"),
  WEB_PORT: z.coerce.number().int().default(3100),
  // Bind address: 127.0.0.1 locally, the docker bridge gateway when Caddy
  // runs in a container and must reach this process on the host.
  WEB_HOST: z.string().default("127.0.0.1"),
  WEB_APP_URL: z.string().default(""),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("\n Konfiguratsiya xatosi (.env faylini tekshiring):\n");
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
  console.error("");
  process.exit(1);
}

export const config = {
  ...parsed.data,
  platformAdminIds: parsed.data.PLATFORM_ADMIN_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s)),
};

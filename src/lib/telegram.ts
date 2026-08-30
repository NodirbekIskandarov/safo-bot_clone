import type { Api } from "grammy";
import { GrammyError, HttpError } from "grammy";
import { db } from "../db.js";
import { log } from "./log.js";

export type SendOutcome = "sent" | "blocked" | "failed";

/** Escape user-controlled text for parse_mode: HTML. */
export function esc(s: string | undefined | null): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function money(uzs: number): string {
  return uzs.toLocaleString("ru-RU").replace(/,/g, " ") + " so'm";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send with Telegram's failure modes handled:
 *  - 429  → honour retry_after, then retry (bounded)
 *  - 403  → the user blocked the bot; mark them and never retry
 *  - 400  → chat gone / user deactivated; mark inactive
 */
export async function sendSafe(
  fn: () => Promise<unknown>,
  opts: { botId?: string; botUserId?: string } = {},
): Promise<SendOutcome> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fn();
      return "sent";
    } catch (err) {
      if (err instanceof GrammyError) {
        const code = err.error_code;
        const retryAfter = err.parameters?.retry_after;

        if (code === 429 && retryAfter) {
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        if (code === 403) {
          if (opts.botUserId) {
            await db.botUser
              .update({ where: { id: opts.botUserId }, data: { status: "blocked_by_user" } })
              .catch(() => {});
          }
          return "blocked";
        }
        if (code === 400 && /chat not found|user is deactivated|bot was kicked/i.test(err.description)) {
          if (opts.botUserId) {
            await db.botUser.update({ where: { id: opts.botUserId }, data: { status: "banned" } }).catch(() => {});
          }
          return "blocked";
        }
        log.warn("send failed", { code, description: err.description, botId: opts.botId });
        return "failed";
      }
      if (err instanceof HttpError) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      log.error("send crashed", { err, botId: opts.botId });
      return "failed";
    }
  }
  return "failed";
}

/** Validate a token against Telegram and return the bot identity. */
export async function verifyToken(api: Api): Promise<{ id: bigint; username: string; firstName: string }> {
  const me = await api.getMe();
  return { id: BigInt(me.id), username: me.username ?? "", firstName: me.first_name };
}

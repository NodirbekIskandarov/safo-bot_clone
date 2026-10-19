import { Keyboard } from "grammy";
import { db } from "../db.js";
import type { BotCtx } from "./context.js";

export const ADMIN_BUTTON = "⚙️ Admin panel";
export const SUB_BUTTON = "💎 Obuna";

/**
 * The persistent keyboard every tenant bot shows. Templates supply their own
 * rows; the subscription row appears only when the owner actually sells one,
 * and the admin row only for admins — an empty button is worse than none.
 */
export async function mainKeyboard(ctx: BotCtx, rows: string[][]): Promise<Keyboard> {
  const kb = new Keyboard();
  for (const row of rows) {
    for (const label of row) kb.text(label);
    kb.row();
  }

  const sellsPlans = await db.botPlan.count({ where: { botId: ctx.botId, isActive: true } });
  if (sellsPlans > 0) kb.text(SUB_BUTTON).row();
  if (ctx.isAdmin) kb.text(ADMIN_BUTTON).row();

  return kb.resized();
}

/** Labels the wizards must never mistake for user input. */
export function isReservedLabel(text: string, rows: string[][]): boolean {
  const flat = [...rows.flat(), ADMIN_BUTTON, SUB_BUTTON];
  return flat.includes(text.trim());
}

/**
 * Menu commands are aliases of keyboard buttons: rewrite "/katalog" into
 * "🛍 Katalog" so the one button handler serves both. They were advertised in
 * the Menu but had no handler, so tapping them did nothing.
 */
export function applyCommandAlias(
  ctx: { message?: { text?: string; entities?: unknown } },
  aliases: Record<string, string> | undefined,
): void {
  const msg = ctx.message;
  if (!aliases || !msg?.text?.startsWith("/")) return;
  const cmd = msg.text.slice(1).split(/[\s@]/)[0] ?? "";
  const label = aliases[cmd];
  if (!label) return;
  msg.text = label;
  delete msg.entities;
}

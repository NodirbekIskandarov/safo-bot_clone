import type { Bot, Context } from "grammy";
import type { BotUser } from "@prisma/client";

export interface AppFlavor {
  botId: string;
  botTitle: string;
  settings: Record<string, unknown>;
  appUser: BotUser;
  isAdmin: boolean;
}

export type BotCtx = Context & AppFlavor;
export type AppBot = Bot<BotCtx>;

export interface TemplateContext {
  bot: AppBot;
  botId: string;
  settings: Record<string, unknown>;
}

export interface BotTemplate {
  key: string;
  emoji: string;
  name: string;
  /** One line shown in the template picker. */
  tagline: string;
  /** Longer explanation shown after the user picks it. */
  description: string;
  defaultSettings: Record<string, unknown>;
  /** Shown in Telegram's blue Menu button inside the created bot. */
  commands: { command: string; description: string }[];
  /** Register all handlers for a tenant bot running this template. */
  register(ctx: TemplateContext): void;
}

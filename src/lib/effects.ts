/**
 * Telegram's animated message effects (Bot API 7.11+, private chats only).
 * These are the only animation a bot can play without owning a Fragment
 * username — custom animated emoji are gated behind that purchase.
 */
export const EFFECT = {
  fire: "5104841245755180586",
  thumbsUp: "5107584321108051014",
  heart: "5159385139981059251",
  party: "5046509860389126442",
} as const;

export type EffectName = keyof typeof EFFECT;

/** Spread into a reply/sendMessage call. Silently ignored on old clients. */
export function withEffect(name: EffectName): { message_effect_id: string } {
  return { message_effect_id: EFFECT[name] };
}

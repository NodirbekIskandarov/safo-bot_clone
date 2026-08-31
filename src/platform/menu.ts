/**
 * Reply-keyboard buttons. A wizard must never swallow one of these: tapping a
 * menu button is the user saying "get me out of here", not answering a prompt.
 */
export const MENU_BUTTONS = [
  "➕ Bot yaratish",
  "🤖 Botlarim",
  "🗣 Referal",
  "🪪 Shaxsiy kabinet",
  "📱 Ilova",
  "💵 Hisob to'ldirish",
  "✉️ Murojaat",
  "📘 Qo'llanma",
  "💳 Tariflar",
] as const;

export function isMenuButton(text: string): boolean {
  return (MENU_BUTTONS as readonly string[]).includes(text.trim());
}

/** Duration options offered at checkout. Longer terms trade margin for cash up front. */
export const TERMS = [
  { months: 1, discount: 0, label: "1 oy" },
  { months: 3, discount: 0.1, label: "3 oy" },
  { months: 12, discount: 0.2, label: "12 oy" },
] as const;

/** Premium members pay less on every plan — this is what the tier actually buys. */
export const PREMIUM_DISCOUNT = 0.1;

export function termPrice(monthlyUzs: number, months: number, isPremium = false): number {
  const term = TERMS.find((t) => t.months === months) ?? TERMS[0];
  const discount = term.discount + (isPremium ? PREMIUM_DISCOUNT : 0);
  const raw = monthlyUzs * months * (1 - discount);
  return Math.round(raw / 1000) * 1000; // keep the figure typeable on a bank app
}

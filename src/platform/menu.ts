import { Keyboard } from "grammy";

/**
 * Reply-keyboard buttons. A wizard must never swallow one of these: tapping a
 * menu button is the user saying "get me out of here", not answering a prompt.
 */
export const BTN = {
  create: "➕ Bot yaratish",
  bots: "🤖 Botlarim",
  income: "💼 Daromad",
  cabinet: "📱 Shaxsiy kabinet",
  topup: "💳 Hisob to'ldirish",
  referral: "🗣 Referal",
  site: "🌐 Saytga kirish",
  help: "📚 Qo'llanma",
  support: "✉️ Murojaat",
  panel: "🛠 Boshqaruv paneli",
} as const;

/**
 * Labels from earlier releases. Telegram keeps a user's old reply keyboard
 * until we send a new one, so these must keep working.
 */
export const LEGACY = {
  cabinet: ["🪪 Shaxsiy kabinet"],
  topup: ["💵 Hisob to'ldirish", "💰 Balans"],
  help: ["📘 Qo'llanma", "❓ Yordam"],
  site: ["📱 Ilova"],
  tariffs: ["💳 Tariflar"],
} as const;

export const MENU_BUTTONS: readonly string[] = [
  ...Object.values(BTN),
  ...Object.values(LEGACY).flat(),
];

export function isMenuButton(text: string): boolean {
  return MENU_BUTTONS.includes(text.trim());
}

/** The persistent keyboard, mirrored on the reference layout; admins get the panel row. */
export function mainKeyboard(isAdmin: boolean): Keyboard {
  const kb = new Keyboard()
    .text(BTN.create).text(BTN.bots).row()
    .text(BTN.income).text(BTN.cabinet).row()
    .text(BTN.topup).text(BTN.referral).row()
    .text(BTN.site).text(BTN.help).row()
    .text(BTN.support);
  if (isAdmin) kb.row().text(BTN.panel);
  return kb.resized().persistent();
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

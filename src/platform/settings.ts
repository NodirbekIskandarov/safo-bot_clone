import { db } from "../db.js";

export const SETTING_KEYS = {
  cardNumber: "card_number",
  cardHolder: "card_holder",
  supportContact: "support_contact",
} as const;

const cache = new Map<string, string>();

export async function getSetting(key: string): Promise<string | null> {
  if (cache.has(key)) return cache.get(key)!;
  const row = await db.platformSetting.findUnique({ where: { key } });
  if (row) cache.set(key, row.value);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.platformSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  cache.set(key, value);
}

export async function paymentDetails(): Promise<{ card: string | null; holder: string | null }> {
  const [card, holder] = await Promise.all([
    getSetting(SETTING_KEYS.cardNumber),
    getSetting(SETTING_KEYS.cardHolder),
  ]);
  return { card, holder };
}

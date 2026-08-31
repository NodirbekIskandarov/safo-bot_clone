import { db } from "../db.js";
import { log } from "../lib/log.js";
import { templateList } from "../templates/index.js";

/** Keep a price row for every registered template; admins edit them in /panel. */
export async function seedTemplatePrices(): Promise<void> {
  for (const [i, t] of templateList.entries()) {
    await db.templatePrice.upsert({
      where: { key: t.key },
      create: { key: t.key, priceUzs: 0, isForSale: false, isEnabled: true, sortOrder: i * 10 },
      // Price and availability are owner decisions — never overwritten by a deploy.
      update: {},
    });
  }
  log.info("template prices seeded", { count: templateList.length });
}

export async function priceOf(key: string) {
  return db.templatePrice.findUnique({ where: { key } });
}

export async function enabledTemplateKeys(): Promise<Set<string>> {
  const rows = await db.templatePrice.findMany({ where: { isEnabled: true }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

/** True when this owner may build with the template right now. */
export async function ownerMayUse(ownerId: string, key: string): Promise<boolean> {
  const price = await priceOf(key);
  if (!price || !price.isEnabled) return false;
  if (!price.isForSale || price.priceUzs === 0) return true;
  const owned = await db.ownerTemplate.findUnique({
    where: { ownerId_templateKey: { ownerId, templateKey: key } },
  });
  return owned !== null;
}

export async function ownedKeys(ownerId: string): Promise<Set<string>> {
  const rows = await db.ownerTemplate.findMany({ where: { ownerId }, select: { templateKey: true } });
  return new Set(rows.map((r) => r.templateKey));
}

import { db } from "../db.js";
import { log } from "../lib/log.js";

export interface PlanFeatures {
  broadcast: boolean;
  broadcastDailyLimit: number;
  broadcastRatePerSec: number;
  orders: boolean;
  export: boolean;
  forcedSubscription: boolean;
}

/**
 * Tariff catalogue. Prices are whole UZS — never tiyin.
 * Changing a price here does NOT change what existing customers pay: seeding
 * updates only name/limits, and `isArchived` retires a plan without deleting it.
 */
export const PLAN_SEED = [
  {
    code: "trial", name: "Sinov", group: "trial", priceUzs: 0, intervalDays: 7,
    maxBotUsers: 100, sortOrder: 0,
    features: { broadcast: true, broadcastDailyLimit: 3, broadcastRatePerSec: 10, orders: true, export: true, forcedSubscription: true },
  },
  {
    code: "std_500", name: "Start", group: "standard", priceUzs: 15_000, intervalDays: 30,
    maxBotUsers: 500, sortOrder: 10,
    features: { broadcast: true, broadcastDailyLimit: 5, broadcastRatePerSec: 20, orders: false, export: true, forcedSubscription: true },
  },
  {
    code: "std_2k", name: "O'sish", group: "standard", priceUzs: 39_000, intervalDays: 30,
    maxBotUsers: 2_000, sortOrder: 20,
    features: { broadcast: true, broadcastDailyLimit: 10, broadcastRatePerSec: 20, orders: false, export: true, forcedSubscription: true },
  },
  {
    code: "std_5k", name: "Pro", group: "standard", priceUzs: 79_000, intervalDays: 30,
    maxBotUsers: 5_000, sortOrder: 30,
    features: { broadcast: true, broadcastDailyLimit: 20, broadcastRatePerSec: 20, orders: false, export: true, forcedSubscription: true },
  },
  {
    code: "std_15k", name: "Pro 15K", group: "standard", priceUzs: 149_000, intervalDays: 30,
    maxBotUsers: 15_000, sortOrder: 40,
    features: { broadcast: true, broadcastDailyLimit: 30, broadcastRatePerSec: 20, orders: false, export: true, forcedSubscription: true },
  },
  {
    code: "std_50k", name: "Pro 50K", group: "standard", priceUzs: 299_000, intervalDays: 30,
    maxBotUsers: 50_000, sortOrder: 50,
    features: { broadcast: true, broadcastDailyLimit: 50, broadcastRatePerSec: 20, orders: false, export: true, forcedSubscription: true },
  },
  {
    code: "biz_mini", name: "Biznes Mini", group: "business", priceUzs: 99_000, intervalDays: 30,
    maxBotUsers: 1_000, sortOrder: 55,
    features: { broadcast: true, broadcastDailyLimit: 5, broadcastRatePerSec: 20, orders: true, export: true, forcedSubscription: true },
  },
  {
    code: "biz_start", name: "Biznes Start", group: "business", priceUzs: 199_000, intervalDays: 30,
    maxBotUsers: 3_000, sortOrder: 60,
    features: { broadcast: true, broadcastDailyLimit: 10, broadcastRatePerSec: 20, orders: true, export: true, forcedSubscription: true },
  },
  {
    code: "biz_pro", name: "Biznes Pro", group: "business", priceUzs: 399_000, intervalDays: 30,
    maxBotUsers: 10_000, sortOrder: 70,
    features: { broadcast: true, broadcastDailyLimit: 30, broadcastRatePerSec: 20, orders: true, export: true, forcedSubscription: true },
  },
] as const;

/** Templates that can only run on a plan selling `orders`. */
const TEMPLATE_REQUIRES_ORDERS = new Set(["shop"]);

export function featuresOf(plan: { features: string }): PlanFeatures {
  return JSON.parse(plan.features) as PlanFeatures;
}

export function planFitsTemplate(plan: { features: string }, templateKey: string): boolean {
  if (!TEMPLATE_REQUIRES_ORDERS.has(templateKey)) return true;
  return featuresOf(plan).orders === true;
}

export async function seedPlans(): Promise<void> {
  for (const p of PLAN_SEED) {
    await db.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code, name: p.name, group: p.group, priceUzs: p.priceUzs,
        intervalDays: p.intervalDays, maxBotUsers: p.maxBotUsers, sortOrder: p.sortOrder,
        features: JSON.stringify(p.features),
      },
      // Price is intentionally not overwritten: raising it must not silently
      // re-price plans people already bought.
      update: {
        name: p.name, group: p.group, intervalDays: p.intervalDays,
        maxBotUsers: p.maxBotUsers, sortOrder: p.sortOrder, features: JSON.stringify(p.features),
      },
    });
  }
  log.info("plans seeded", { count: PLAN_SEED.length });
}

export async function payablePlans(templateKey: string) {
  const plans = await db.plan.findMany({
    where: { isActive: true, isArchived: false, priceUzs: { gt: 0 } },
    orderBy: { sortOrder: "asc" },
  });
  return plans.filter((p) => planFitsTemplate(p, templateKey));
}

import type { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { log } from "../lib/log.js";
import { dailyPrice, featuresOf, payablePlans, type PlanFeatures } from "./plans.js";
import { charge, InsufficientFunds } from "./wallet.js";

export const GRACE_DAYS = 3;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 3600 * 1000);
}

export function isLive(status: string): boolean {
  return status === "trial" || status === "active" || status === "grace";
}

/**
 * Attach a subscription to a freshly created bot.
 * The trial is account-bound (see Owner.trialUsedAt): a second bot does not get
 * another free week, otherwise anyone could rotate bots forever.
 */
export async function openSubscription(botId: string, ownerId: string) {
  const owner = await db.owner.findUniqueOrThrow({ where: { id: ownerId } });
  const trialPlan = await db.plan.findUniqueOrThrow({ where: { code: "trial" } });

  // Platform staff are never billed, so their second bot must not be born
  // "unpaid" and stopped — accessFor already treats them as always live.
  if (owner.isPlatformAdmin) {
    const sub = await db.subscription.create({
      data: {
        botId, ownerId, planId: trialPlan.id, status: "active",
        currentPeriodEnd: new Date(Date.now() + 3650 * 24 * 3600 * 1000),
      },
    });
    return { subscription: sub, trialGranted: true };
  }

  if (owner.trialUsedAt === null) {
    const [sub] = await db.$transaction([
      db.subscription.create({
        data: {
          botId, ownerId, planId: trialPlan.id, status: "trial",
          trialEndsAt: addDays(new Date(), trialPlan.intervalDays),
        },
      }),
      db.owner.update({ where: { id: ownerId }, data: { trialUsedAt: new Date() } }),
    ]);
    return { subscription: sub, trialGranted: true };
  }

  const sub = await db.subscription.create({
    data: { botId, ownerId, planId: trialPlan.id, status: "unpaid" },
  });
  return { subscription: sub, trialGranted: false };
}

/**
 * Give a subscription to any bot that predates billing (or slipped through a
 * failed create). Runs at boot; a no-op once every bot has one.
 */
export async function backfillSubscriptions(): Promise<number> {
  const orphans = await db.bot.findMany({
    where: { subscription: { is: null } },
    select: { id: true, ownerId: true },
  });
  for (const bot of orphans) await openSubscription(bot.id, bot.ownerId);
  if (orphans.length > 0) log.info("subscriptions backfilled", { count: orphans.length });
  return orphans.length;
}

/** Apply an approved payment: move to `active` and push the period forward. */
export async function activate(
  subscriptionId: string,
  planId: string,
  months = 1,
  tx: Prisma.TransactionClient = db,
) {
  // Sequential on purpose: inside an interactive transaction queries must not race.
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: planId } });

  // Extend from whichever entitlement is still running — paid period OR the
  // remaining trial. Paying on day 2 of a trial must not burn the other 5 days,
  // or the cheapest move for the customer is to wait until the last hour.
  const now = new Date();
  const candidates = [sub.currentPeriodEnd, sub.trialEndsAt].filter(
    (d): d is Date => d instanceof Date && d > now,
  );
  const base = candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : now;

  return tx.subscription.update({
    where: { id: subscriptionId },
    data: {
      planId, status: "active",
      currentPeriodEnd: addDays(base, plan.intervalDays * months),
      graceEndsAt: null, warnedAt: null,
    },
  });
}

/** Premium is time-boxed: an expired membership must stop discounting. */
export function premiumActive(owner: { isPremium: boolean; premiumUntil: Date | null }): boolean {
  return owner.isPremium && (owner.premiumUntil === null || owner.premiumUntil > new Date());
}

/** "28 kun 19 soat 27 daqiqa" — what the owner actually wants to know. */
export function timeLeft(until: Date | null): string | null {
  if (!until) return null;
  let ms = until.getTime() - Date.now();
  if (ms <= 0) return "tugagan";
  const d = Math.floor(ms / 86_400_000);
  ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  return [d ? `${d} kun` : "", h ? `${h} soat` : "", `${m} daqiqa`].filter(Boolean).join(" ");
}

export interface Access {
  live: boolean;
  status: string;
  planName: string;
  features: PlanFeatures;
  maxBotUsers: number;
  endsAt: Date | null;
  daysLeft: number | null;
  autoRenew: boolean;
  priceUzs: number;
  planCode: string;
}

export async function accessFor(botId: string): Promise<Access | null> {
  const sub = await db.subscription.findUnique({
    where: { botId },
    include: { plan: true, owner: true },
  });
  if (!sub) return null;

  // Platform staff do not bill themselves: their own bots never lapse.
  if (sub.owner.isPlatformAdmin) {
    return {
      live: true,
      status: "staff",
      planName: "Platforma",
      features: featuresOf(sub.plan),
      maxBotUsers: Number.MAX_SAFE_INTEGER,
      endsAt: null,
      daysLeft: null,
      autoRenew: false,
      priceUzs: 0,
      planCode: sub.plan.code,
    };
  }

  const endsAt = sub.status === "trial" ? sub.trialEndsAt : (sub.graceEndsAt ?? sub.currentPeriodEnd);
  const daysLeft = endsAt ? Math.ceil((endsAt.getTime() - Date.now()) / (24 * 3600 * 1000)) : null;

  return {
    live: isLive(sub.status),
    status: sub.status,
    planName: sub.plan.name,
    features: featuresOf(sub.plan),
    maxBotUsers: sub.plan.maxBotUsers,
    endsAt,
    daysLeft,
    autoRenew: sub.autoRenew,
    priceUzs: sub.plan.priceUzs,
    planCode: sub.plan.code,
  };
}

export interface LifecycleEvent {
  kind: "warn" | "grace" | "stopped" | "renewed";
  botId: string;
  ownerTgId: bigint;
  botUsername: string;
  daysLeft: number;
}

/**
 * Hourly lifecycle tick. Idempotent by construction: every transition is a
 * conditional update keyed on the current status, so running it twice in the
 * same hour changes nothing.
 */
export async function billingTick(): Promise<LifecycleEvent[]> {
  const now = new Date();
  const events: LifecycleEvent[] = [];

  const subs = await db.subscription.findMany({
    where: { status: { in: ["trial", "active", "grace"] }, owner: { isPlatformAdmin: false } },
    include: { bot: true, owner: true, plan: true },
  });

  for (const sub of subs) {
    const endsAt = sub.status === "trial" ? sub.trialEndsAt : sub.currentPeriodEnd;

    // Auto-renew: one hour before the paid time runs out, buy one more day from
    // balance. A bot whose owner keeps money on the wallet never stops.
    if (sub.autoRenew && sub.bot.status !== "stopped") {
      const runsOutAt = sub.status === "grace" ? now : endsAt;
      if (runsOutAt && runsOutAt.getTime() <= now.getTime() + 65 * 60 * 1000) {
        const renewed = await renewOneDay(sub, now);
        if (renewed) {
          events.push({
            kind: "renewed", botId: sub.botId, ownerTgId: sub.owner.tgUserId,
            botUsername: sub.bot.tgUsername, daysLeft: 1,
          });
          continue;
        }
      }
    }

    // active/trial period is over -> grace
    if (sub.status !== "grace" && endsAt && endsAt <= now) {
      await db.subscription.update({
        where: { id: sub.id },
        data: { status: "grace", graceEndsAt: addDays(now, GRACE_DAYS), warnedAt: now },
      });
      events.push({
        kind: "grace", botId: sub.botId, ownerTgId: sub.owner.tgUserId,
        botUsername: sub.bot.tgUsername, daysLeft: GRACE_DAYS,
      });
      continue;
    }

    // grace is over -> stop the bot
    if (sub.status === "grace" && sub.graceEndsAt && sub.graceEndsAt <= now) {
      await db.subscription.update({ where: { id: sub.id }, data: { status: "expired" } });
      events.push({
        kind: "stopped", botId: sub.botId, ownerTgId: sub.owner.tgUserId,
        botUsername: sub.bot.tgUsername, daysLeft: 0,
      });
      continue;
    }

    // three days out -> one warning, once
    if (endsAt) {
      const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / (24 * 3600 * 1000));
      const alreadyWarned = sub.warnedAt && sub.warnedAt.getTime() > now.getTime() - 20 * 3600 * 1000;
      // Auto-renew with money on the wallet: there is nothing to warn about.
      const covered =
        sub.autoRenew && sub.plan.priceUzs > 0 && sub.owner.balanceUzs >= dailyPrice(sub.plan.priceUzs);
      if (daysLeft <= 3 && daysLeft > 0 && !alreadyWarned && !covered) {
        await db.subscription.update({ where: { id: sub.id }, data: { warnedAt: now } });
        events.push({
          kind: "warn", botId: sub.botId, ownerTgId: sub.owner.tgUserId,
          botUsername: sub.bot.tgUsername, daysLeft,
        });
      }
    }
  }

  if (events.length > 0) log.info("billing tick", { events: events.length });
  return events;
}

/**
 * Charge one day of the bot's plan and extend it, atomically. A trial bot has
 * no paid plan yet, so it renews on the cheapest plan that fits its audience.
 * Returns false when the balance does not cover it — the normal grace flow
 * then takes over and tells the owner.
 */
async function renewOneDay(
  sub: { id: string; ownerId: string; planId: string; status: string; currentPeriodEnd: Date | null;
         trialEndsAt: Date | null; botId: string; bot: { templateKey: string; tgUsername: string } },
  now: Date,
): Promise<boolean> {
  const current = await db.plan.findUnique({ where: { id: sub.planId } });
  let plan = current && current.priceUzs > 0 ? current : null;
  if (!plan) {
    const users = await db.botUser.count({ where: { botId: sub.botId } });
    const options = await payablePlans(sub.bot.templateKey);
    plan = options.filter((p) => p.maxBotUsers >= users).sort((a, b) => a.priceUzs - b.priceUzs)[0] ?? null;
  }
  if (!plan) return false;

  const price = dailyPrice(plan.priceUzs);
  const still = [sub.currentPeriodEnd, sub.status === "trial" ? sub.trialEndsAt : null].filter(
    (d): d is Date => d instanceof Date && d > now,
  );
  const base = still.length > 0 ? new Date(Math.max(...still.map((d) => d.getTime()))) : now;

  try {
    await db.$transaction(async (tx) => {
      await charge(sub.ownerId, price, "subscription", {
        note: `Avto uzaytirish · 1 kun · @${sub.bot.tgUsername}`, refId: sub.id,
      }, tx);
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          planId: plan.id, status: "active",
          currentPeriodEnd: addDays(base, 1),
          graceEndsAt: null, warnedAt: null,
        },
      });
    });
    log.info("subscription auto-renewed", { subscriptionId: sub.id, price });
    return true;
  } catch (err) {
    if (err instanceof InsufficientFunds) return false;
    log.error("auto-renew failed", { subscriptionId: sub.id, err });
    return false;
  }
}

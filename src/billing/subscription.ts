import { db } from "../db.js";
import { log } from "../lib/log.js";
import { featuresOf, type PlanFeatures } from "./plans.js";

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
export async function activate(subscriptionId: string, planId: string, months = 1) {
  const [sub, plan] = await Promise.all([
    db.subscription.findUniqueOrThrow({ where: { id: subscriptionId } }),
    db.plan.findUniqueOrThrow({ where: { id: planId } }),
  ]);

  // Extend from whichever entitlement is still running — paid period OR the
  // remaining trial. Paying on day 2 of a trial must not burn the other 5 days,
  // or the cheapest move for the customer is to wait until the last hour.
  const now = new Date();
  const candidates = [sub.currentPeriodEnd, sub.trialEndsAt].filter(
    (d): d is Date => d instanceof Date && d > now,
  );
  const base = candidates.length > 0 ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : now;

  return db.subscription.update({
    where: { id: subscriptionId },
    data: {
      planId, status: "active",
      currentPeriodEnd: addDays(base, plan.intervalDays * months),
      graceEndsAt: null, warnedAt: null,
    },
  });
}

export interface Access {
  live: boolean;
  status: string;
  planName: string;
  features: PlanFeatures;
  maxBotUsers: number;
  endsAt: Date | null;
  daysLeft: number | null;
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
  };
}

export interface LifecycleEvent {
  kind: "warn" | "grace" | "stopped";
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
    include: { bot: true, owner: true },
  });

  for (const sub of subs) {
    const endsAt = sub.status === "trial" ? sub.trialEndsAt : sub.currentPeriodEnd;

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
      if (daysLeft <= 3 && daysLeft > 0 && !alreadyWarned) {
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

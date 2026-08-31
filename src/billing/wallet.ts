import { db } from "../db.js";
import { log } from "../lib/log.js";

export class InsufficientFunds extends Error {
  constructor(readonly needUzs: number, readonly haveUzs: number) {
    super("Balансda mablag' yetarli emas");
  }
}

/**
 * Every balance change goes through here so the ledger and the cached balance
 * can never disagree: both are written in one transaction, and each row keeps
 * the resulting balance for auditing.
 */
export async function move(
  ownerId: string,
  amountUzs: number,
  kind: "topup" | "subscription" | "template" | "refund" | "bonus",
  opts: { note?: string; refId?: string } = {},
): Promise<number> {
  return db.$transaction(async (tx) => {
    const owner = await tx.owner.findUniqueOrThrow({ where: { id: ownerId } });
    const next = owner.balanceUzs + amountUzs;
    if (next < 0) throw new InsufficientFunds(-amountUzs, owner.balanceUzs);

    await tx.owner.update({ where: { id: ownerId }, data: { balanceUzs: next } });
    await tx.balanceTx.create({
      data: {
        ownerId, amountUzs, kind,
        note: opts.note ?? null,
        refId: opts.refId ?? null,
        balanceAfter: next,
      },
    });
    return next;
  });
}

export async function balanceOf(ownerId: string): Promise<number> {
  const owner = await db.owner.findUnique({ where: { id: ownerId }, select: { balanceUzs: true } });
  return owner?.balanceUzs ?? 0;
}

export async function history(ownerId: string, take = 10) {
  return db.balanceTx.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" }, take });
}

/** Spend from balance, or throw InsufficientFunds with the shortfall. */
export async function charge(
  ownerId: string,
  amountUzs: number,
  kind: "subscription" | "template",
  opts: { note?: string; refId?: string } = {},
): Promise<number> {
  const left = await move(ownerId, -Math.abs(amountUzs), kind, opts);
  log.info("balance charged", { ownerId, amountUzs, kind, left });
  return left;
}

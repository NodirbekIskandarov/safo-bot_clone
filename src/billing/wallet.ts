import type { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { log } from "../lib/log.js";

export type TxKind = "topup" | "subscription" | "template" | "refund" | "bonus" | "adjust";

export class InsufficientFunds extends Error {
  constructor(readonly needUzs: number, readonly haveUzs: number) {
    super("Balansda mablag' yetarli emas");
  }
}

async function moveWith(
  tx: Prisma.TransactionClient,
  ownerId: string,
  amountUzs: number,
  kind: TxKind,
  opts: { note?: string; refId?: string },
): Promise<number> {
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
}

/**
 * Every balance change goes through here so the ledger and the cached balance
 * can never disagree: both are written in one transaction, and each row keeps
 * the resulting balance for auditing. Pass `tx` to join a larger transaction,
 * so a purchase and the thing it buys either both happen or neither does.
 */
export async function move(
  ownerId: string,
  amountUzs: number,
  kind: TxKind,
  opts: { note?: string; refId?: string } = {},
  tx?: Prisma.TransactionClient,
): Promise<number> {
  if (tx) return moveWith(tx, ownerId, amountUzs, kind, opts);
  return db.$transaction((t) => moveWith(t, ownerId, amountUzs, kind, opts));
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
  tx?: Prisma.TransactionClient,
): Promise<number> {
  const left = await move(ownerId, -Math.abs(amountUzs), kind, opts, tx);
  log.info("balance charged", { ownerId, amountUzs, kind, left });
  return left;
}

export const KIND_LABEL: Record<string, string> = {
  topup: "💰 To'ldirish",
  subscription: "📦 Obuna",
  template: "🧩 Shablon",
  refund: "↩️ Qaytarish",
  bonus: "🎁 Referal bonusi",
  adjust: "🛠 Admin tuzatishi",
};

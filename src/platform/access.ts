import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db } from "../db.js";

/** Bootstrap admins from .env can never be demoted from inside the bot. */
export function isRootAdmin(tgId: bigint): boolean {
  return config.platformAdminIds.includes(tgId);
}

export async function isAdmin(tgId: bigint): Promise<boolean> {
  if (isRootAdmin(tgId)) return true;
  const owner = await db.owner.findUnique({ where: { tgUserId: tgId } });
  return owner?.isPlatformAdmin === true;
}

export async function adminTgIds(): Promise<bigint[]> {
  const owners = await db.owner.findMany({
    where: { isPlatformAdmin: true },
    select: { tgUserId: true },
  });
  const ids = new Set<bigint>([...config.platformAdminIds, ...owners.map((o) => o.tgUserId)]);
  return [...ids];
}

export async function audit(actorTgId: bigint, action: string, target?: string, meta?: unknown) {
  await db.auditLog.create({
    data: { actorTgId, action, target: target ?? null, meta: meta ? JSON.stringify(meta) : null },
  });
}

export function paymentReference(): string {
  return `BX-${randomBytes(3).toString("hex").toUpperCase()}`;
}

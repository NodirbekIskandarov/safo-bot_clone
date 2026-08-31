import { createHmac, timingSafeEqual } from "node:crypto";

export interface TgUser {
  id: bigint;
  first_name?: string;
  username?: string;
}

/**
 * Verify Telegram Mini App initData.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Without this check anyone could POST an arbitrary user id and read another
 * tenant's data, so every API route runs it before touching the database.
 */
export function verifyInitData(initData: string, botToken: string, maxAgeSec = 86400): TgUser | null {
  if (!initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null") as
      | { id: number; first_name?: string; username?: string }
      | null;
    if (!user?.id) return null;
    return { id: BigInt(user.id), first_name: user.first_name, username: user.username };
  } catch {
    return null;
  }
}

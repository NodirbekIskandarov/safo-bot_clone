import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";

const KEY = Buffer.from(config.ENCRYPTION_KEY, "base64");
if (KEY.length !== 32) {
  throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes. Run `npm run keygen`.");
}

export interface Sealed {
  cipher: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

/** Encrypt a bot token. Tokens must be recoverable — we send them to Telegram. */
export function seal(plain: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", KEY, iv);
  const cipher = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { cipher, iv, tag: c.getAuthTag() };
}

export function open(sealed: Sealed): string {
  const d = createDecipheriv("aes-256-gcm", KEY, Buffer.from(sealed.iv));
  d.setAuthTag(Buffer.from(sealed.tag));
  return Buffer.concat([d.update(Buffer.from(sealed.cipher)), d.final()]).toString("utf8");
}

/** Deterministic fingerprint so the same token cannot be registered twice. */
export function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

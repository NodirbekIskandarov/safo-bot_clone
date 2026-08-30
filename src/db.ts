import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

// BigInt is not JSON-serialisable by default; Telegram ids are BigInt everywhere.
(BigInt.prototype as unknown as { toJSON(): string }).toJSON = function () {
  return this.toString();
};

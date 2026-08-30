import type { Api } from "grammy";
import { config } from "../config.js";
import { db } from "../db.js";
import { log } from "../lib/log.js";
import { sendSafe } from "../lib/telegram.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BroadcastSource {
  fromChatId: number;
  messageId: number;
}

/**
 * Queue a broadcast to every active user of a bot.
 *
 * Uses copyMessage so any content type (text, photo, video, album item, poll)
 * works without re-uploading — the admin composes it in their own chat and we
 * forward a copy that carries no "forwarded from" header.
 */
export async function createBroadcast(
  botId: string,
  createdBy: bigint,
  source: BroadcastSource,
): Promise<{ id: string; total: number }> {
  const audience = await db.botUser.findMany({
    where: { botId, status: "active" },
    select: { id: true },
  });

  const broadcast = await db.broadcast.create({
    data: {
      botId,
      createdBy,
      content: JSON.stringify(source),
      status: "running",
      totalCount: audience.length,
      startedAt: new Date(),
      targets: { create: audience.map((u) => ({ botUserId: u.id })) },
    },
  });

  return { id: broadcast.id, total: audience.length };
}

/** Drain a broadcast's pending targets. Safe to call again after a crash. */
export async function runBroadcast(
  broadcastId: string,
  api: Api,
  onProgress?: (sent: number, failed: number, total: number) => void,
): Promise<{ sent: number; failed: number; blocked: number }> {
  const broadcast = await db.broadcast.findUnique({ where: { id: broadcastId } });
  if (!broadcast) throw new Error("Broadcast topilmadi");

  const source = JSON.parse(broadcast.content) as BroadcastSource;
  const gapMs = Math.ceil(1000 / config.BROADCAST_RATE_PER_SEC);

  let sent = 0;
  let failed = 0;
  let blocked = 0;

  for (;;) {
    const fresh = await db.broadcast.findUnique({ where: { id: broadcastId }, select: { status: true } });
    if (fresh?.status !== "running") break;

    const batch = await db.broadcastTarget.findMany({
      where: { broadcastId, status: "pending" },
      include: { botUser: true },
      take: 100,
    });
    if (batch.length === 0) break;

    for (const target of batch) {
      const outcome = await sendSafe(
        () => api.copyMessage(Number(target.botUser.tgUserId), source.fromChatId, source.messageId),
        { botId: broadcast.botId, botUserId: target.botUserId },
      );

      const status = outcome === "sent" ? "sent" : outcome === "blocked" ? "blocked" : "failed";
      if (outcome === "sent") sent++;
      else if (outcome === "blocked") blocked++;
      else failed++;

      await db.broadcastTarget.update({
        where: { id: target.id },
        data: { status, sentAt: outcome === "sent" ? new Date() : null },
      });

      await sleep(gapMs);
    }

    await db.broadcast.update({
      where: { id: broadcastId },
      data: { sentCount: sent, failedCount: failed + blocked },
    });
    onProgress?.(sent, failed + blocked, broadcast.totalCount);
  }

  await db.broadcast.update({
    where: { id: broadcastId },
    data: { status: "done", finishedAt: new Date(), sentCount: sent, failedCount: failed + blocked },
  });

  log.info("broadcast finished", { broadcastId, sent, failed, blocked });
  return { sent, failed, blocked };
}

/** Resume broadcasts that were mid-flight when the process died. */
export async function resumeBroadcasts(getApi: (botId: string) => Api | undefined): Promise<void> {
  const stuck = await db.broadcast.findMany({ where: { status: "running" } });
  for (const b of stuck) {
    const api = getApi(b.botId);
    if (!api) continue;
    log.info("resuming broadcast", { broadcastId: b.id });
    void runBroadcast(b.id, api).catch((err) => log.error("resume failed", { err }));
  }
}

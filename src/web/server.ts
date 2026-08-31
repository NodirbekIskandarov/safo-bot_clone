import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import { log } from "../lib/log.js";
import { open } from "../lib/crypto.js";
import { balanceOf, history } from "../billing/wallet.js";
import { accessFor } from "../billing/subscription.js";
import { verifyInitData, type TgUser } from "./auth.js";

const PUBLIC_DIR = new URL("../../public/", import.meta.url).pathname;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 256 * 1024) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Resolve the caller from initData, against the platform bot or one of its tenants. */
async function authenticate(initData: string, botId?: string): Promise<{ user: TgUser; botId?: string } | null> {
  if (botId) {
    const record = await db.bot.findUnique({ where: { id: botId } });
    if (!record) return null;
    const token = open({ cipher: record.tokenCipher, iv: record.tokenIv, tag: record.tokenTag });
    const user = verifyInitData(initData, token);
    return user ? { user, botId } : null;
  }
  const user = verifyInitData(initData, config.PLATFORM_BOT_TOKEN);
  return user ? { user } : null;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method" });

  const raw = await readBody(req);
  const body = JSON.parse(raw || "{}") as { initData?: string; botId?: string };
  const auth = await authenticate(body.initData ?? "", body.botId);
  if (!auth) return json(res, 401, { ok: false, error: "auth" });

  // ---- platform side: the owner's own dashboard
  if (path === "/api/me") {
    const owner = await db.owner.findUnique({ where: { tgUserId: auth.user.id } });
    if (!owner) return json(res, 404, { ok: false, error: "owner" });

    const bots = await db.bot.findMany({
      where: { ownerId: owner.id },
      include: { _count: { select: { users: true } } },
      orderBy: { createdAt: "asc" },
    });

    const withAccess = await Promise.all(
      bots.map(async (b) => {
        const access = await accessFor(b.id);
        const today = await db.botUser.count({
          where: { botId: b.id, joinedAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        });
        return {
          id: b.id,
          username: b.tgUsername,
          template: b.templateKey,
          status: b.status,
          users: b._count.users,
          today,
          plan: access?.planName ?? null,
          planStatus: access?.status ?? null,
          daysLeft: access?.daysLeft ?? null,
          maxUsers: access?.maxBotUsers ?? null,
        };
      }),
    );

    return json(res, 200, {
      ok: true,
      data: {
        name: owner.fullName,
        balance: await balanceOf(owner.id),
        isPremium: owner.isPremium,
        isAdmin: owner.isPlatformAdmin,
        bots: withAccess,
        txs: (await history(owner.id, 15)).map((t) => ({
          amount: t.amountUzs, kind: t.kind, note: t.note, at: t.createdAt,
        })),
      },
    });
  }

  // ---- tenant side: one bot's data, for its owner or admins
  if (path === "/api/bot") {
    const botId = body.botId;
    if (!botId) return json(res, 400, { ok: false, error: "botId" });

    const record = await db.bot.findUnique({ where: { id: botId }, include: { owner: true } });
    if (!record) return json(res, 404, { ok: false, error: "bot" });

    const adminIds = (JSON.parse(record.adminIds) as string[]).map((v) => BigInt(v));
    const isOwner = record.owner.tgUserId === auth.user.id;
    if (!isOwner && !adminIds.includes(auth.user.id)) {
      return json(res, 403, { ok: false, error: "forbidden" });
    }

    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
    const since = new Date();
    since.setDate(since.getDate() - 13);
    since.setHours(0, 0, 0, 0);

    const [users, todayUsers, blocked, unsubscribed, joins, access, plans, subs, subRevenue] =
      await Promise.all([
        db.botUser.count({ where: { botId } }),
        db.botUser.count({ where: { botId, joinedAt: { gte: startOfToday } } }),
        db.botUser.count({ where: { botId, status: { in: ["blocked_by_user", "banned"] } } }),
        db.botUser.count({ where: { botId, status: "unsubscribed" } }),
        db.botUser.findMany({ where: { botId, joinedAt: { gte: since } }, select: { joinedAt: true } }),
        accessFor(botId),
        db.botPlan.findMany({ where: { botId }, orderBy: { sortOrder: "asc" } }),
        db.botSubscription.count({ where: { botId, status: "active", endsAt: { gt: new Date() } } }),
        db.botPayment.aggregate({ where: { botId, status: "approved" }, _sum: { amountUzs: true } }),
      ]);

    // 14-day join histogram, zero-filled so the chart never has gaps
    const buckets = new Map<string, number>();
    for (let i = 0; i < 14; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const e of joins) {
      const key = e.joinedAt.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, buckets.get(key)! + 1);
    }

    // Everything below is template-specific: a kino owner and a shop owner
    // need completely different numbers on the same screen.
    const extra: Record<string, unknown> = {};

    if (record.templateKey === "kino") {
      const [count, top, totalViews] = await Promise.all([
        db.movie.count({ where: { botId } }),
        db.movie.findMany({ where: { botId }, orderBy: { views: "desc" }, take: 10 }),
        db.movie.aggregate({ where: { botId }, _sum: { views: true } }),
      ]);
      const channels = await db.requiredChannel.findMany({ where: { botId, isActive: true } });
      extra.kino = {
        count,
        views: totalViews._sum.views ?? 0,
        channels: channels.map((c) => c.title),
        top: top.map((m) => ({ code: m.code, title: m.title, views: m.views })),
      };
    }

    if (record.templateKey === "shop") {
      const [products, categories, orders, revenue, byStatus] = await Promise.all([
        db.product.count({ where: { botId, isActive: true } }),
        db.category.count({ where: { botId } }),
        db.order.findMany({ where: { botId }, orderBy: { createdAt: "desc" }, take: 25 }),
        db.order.aggregate({
          where: { botId, status: { in: ["confirmed", "delivering", "done"] } },
          _sum: { totalUzs: true },
        }),
        db.order.groupBy({ by: ["status"], where: { botId }, _count: true }),
      ]);
      const topProducts = await db.product.findMany({
        where: { botId }, orderBy: { createdAt: "desc" }, take: 10,
      });
      extra.shop = {
        products, categories,
        revenue: revenue._sum.totalUzs ?? 0,
        byStatus: Object.fromEntries(byStatus.map((b) => [b.status, b._count])),
        orders: orders.map((o) => ({
          number: o.number, total: o.totalUzs, status: o.status, phone: o.phone,
          at: o.createdAt, delivery: o.deliveryType,
          address: [o.region, o.district, o.mahalla, o.address].filter(Boolean).join(", "),
          map: o.lat && o.lon ? `https://maps.google.com/?q=${o.lat},${o.lon}` : null,
        })),
        catalogue: topProducts.map((p) => ({ title: p.title, price: p.priceUzs, active: p.isActive })),
      };
    }

    if (record.templateKey === "support") {
      const [open, answered, closed, recent] = await Promise.all([
        db.ticket.count({ where: { botId, status: "open" } }),
        db.ticket.count({ where: { botId, status: "answered" } }),
        db.ticket.count({ where: { botId, status: "closed" } }),
        db.ticket.findMany({
          where: { botId }, orderBy: { lastMsgAt: "desc" }, take: 15,
          include: { botUser: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
        }),
      ]);
      extra.support = {
        open, answered, closed,
        tickets: recent.map((t) => ({
          number: t.number, status: t.status,
          who: t.botUser.firstName ?? "", username: t.botUser.username,
          last: t.messages[0]?.text?.slice(0, 90) ?? "",
          at: t.lastMsgAt,
        })),
      };
    }

    if (record.templateKey === "booking") {
      const now = new Date();
      const endOfToday = new Date(startOfToday);
      endOfToday.setDate(endOfToday.getDate() + 1);
      const [today, upcoming, done, canceled, list] = await Promise.all([
        db.booking.count({ where: { botId, slotAt: { gte: startOfToday, lt: endOfToday } } }),
        db.booking.count({ where: { botId, slotAt: { gte: now }, status: { in: ["new", "confirmed"] } } }),
        db.booking.count({ where: { botId, status: "done" } }),
        db.booking.count({ where: { botId, status: "canceled" } }),
        db.booking.findMany({
          where: { botId, slotAt: { gte: startOfToday } },
          orderBy: { slotAt: "asc" }, take: 20, include: { botUser: true },
        }),
      ]);
      extra.booking = {
        today, upcoming, done, canceled,
        slots: list.map((b) => ({
          number: b.number, service: b.service, at: b.slotAt, phone: b.phone,
          status: b.status, who: b.botUser.firstName ?? "",
        })),
      };
    }

    if (record.templateKey === "contest") {
      const current = await db.contest.findFirst({
        where: { botId }, orderBy: { createdAt: "desc" },
        include: { entries: { include: { botUser: true } } },
      });
      extra.contest = current
        ? {
            title: current.title, prize: current.prize, status: current.status,
            winnerCount: current.winnerCount, entries: current.entries.length,
            winners: current.entries
              .filter((e) => e.isWinner)
              .map((e) => ({ ticket: e.ticketNo, who: e.botUser.firstName ?? "", username: e.botUser.username })),
          }
        : null;
    }

    if (record.templateKey === "faq") {
      const items = await db.faqItem.findMany({ where: { botId }, orderBy: { hits: "desc" }, take: 20 });
      extra.faq = {
        count: items.length,
        hits: items.reduce((sum, i) => sum + i.hits, 0),
        items: items.map((i) => ({ q: i.question, hits: i.hits })),
      };
    }

    if (record.templateKey === "survey") {
      const survey = await db.survey.findFirst({
        where: { botId, isActive: true }, orderBy: { createdAt: "desc" },
        include: { questions: { orderBy: { order: "asc" } }, _count: { select: { responses: true } } },
      });
      extra.survey = survey
        ? {
            title: survey.title,
            questions: survey.questions.map((q) => q.prompt),
            responses: survey._count.responses,
          }
        : null;
    }

    if (record.templateKey === "broadcast") {
      const sent = await db.broadcast.findMany({
        where: { botId }, orderBy: { createdAt: "desc" }, take: 10,
      });
      extra.broadcast = {
        total: sent.length,
        recent: sent.map((b) => ({
          status: b.status, total: b.totalCount, sent: b.sentCount, failed: b.failedCount, at: b.createdAt,
        })),
      };
    }

    return json(res, 200, {
      ok: true,
      data: {
        title: record.title,
        username: record.tgUsername,
        template: record.templateKey,
        status: record.status,
        createdAt: record.createdAt,
        plan: access ? {
          name: access.planName, status: access.status,
          daysLeft: access.daysLeft, maxUsers: access.maxBotUsers,
        } : null,
        stats: { users, todayUsers, blocked, unsubscribed, active: users - blocked - unsubscribed },
        chart: [...buckets.entries()].map(([date, count]) => ({ date, count })),
        selling: {
          plans: plans.map((p) => ({ title: p.title, price: p.priceUzs, days: p.days, active: p.isActive })),
          subscribers: subs,
          revenue: subRevenue._sum.amountUzs ?? 0,
        },
        extra,
      },
    });
  }

  return json(res, 404, { ok: false, error: "route" });
}

async function serveStatic(res: ServerResponse, urlPath: string) {
  const rel = urlPath === "/" ? "index.html" : normalize(urlPath).replace(/^(\.\.[/\\])+/, "").slice(1);
  try {
    const file = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      "content-type": MIME[extname(rel)] ?? "application/octet-stream",
      "cache-control": rel === "index.html" ? "no-store" : "public, max-age=3600",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}

export function startWebServer(port: number, host: string) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local");
    // Served behind Caddy, which terminates TLS and adds the security headers.
    res.setHeader("x-content-type-options", "nosniff");

    const run = url.pathname.startsWith("/api/")
      ? handleApi(req, res, url.pathname)
      : serveStatic(res, url.pathname);

    run.catch((err) => {
      log.error("web request failed", { path: url.pathname, err });
      if (!res.headersSent) json(res, 500, { ok: false, error: "server" });
    });
  });

  server.listen(port, host, () => log.info("web server listening", { host, port }));
  return server;
}

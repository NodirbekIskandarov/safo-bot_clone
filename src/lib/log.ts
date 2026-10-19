const REDACT = /(\d{8,10}:[A-Za-z0-9_-]{35})/g;

function scrub(value: unknown): unknown {
  if (typeof value === "string") return value.replace(REDACT, "<token:redacted>");
  if (value instanceof Error) return { message: scrub(value.message), stack: scrub(value.stack) };
  return value;
}

const LEVELS: Record<string, number> = { error: 0, warn: 1, info: 2 };
const threshold = LEVELS[(process.env.LOG_LEVEL ?? "info").toLowerCase()] ?? 2;

function emit(level: string, msg: string, extra?: Record<string, unknown>) {
  if ((LEVELS[level] ?? 2) > threshold) return;
  const line: Record<string, unknown> = { t: new Date().toISOString(), level, msg: scrub(msg) };
  if (extra) for (const [k, v] of Object.entries(extra)) line[k] = scrub(v);
  console.log(JSON.stringify(line));
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * In-memory conversation state. Deliberately not Redis: this platform runs as a
 * single process, and a lost wizard step is recoverable by pressing the button
 * again. Entries expire so an abandoned wizard cannot pin memory forever.
 *
 * Every key is namespaced by the bot that is handling the update. Without it a
 * person using two shop bots had one cart for both, and a wizard started in
 * one bot swallowed messages sent to another.
 */
interface Entry {
  data: Record<string, unknown>;
  step: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, Entry>();
const namespace = new AsyncLocalStorage<string>();

/** Run a tenant bot's update handling inside its own state namespace. */
export function withStateNamespace<T>(botId: string, fn: () => Promise<T>): Promise<T> {
  return namespace.run(botId, fn);
}

function ns(): string {
  return namespace.getStore() ?? "platform";
}

function key(scope: string, userId: bigint | number): string {
  return `${ns()}|${scope}:${userId}`;
}

/** Move to a step, keeping data gathered by earlier steps of the same wizard. */
export function setStep(scope: string, userId: bigint | number, step: string, data: Record<string, unknown> = {}) {
  const existing = store.get(key(scope, userId));
  store.set(key(scope, userId), {
    step,
    data: { ...(existing?.data ?? {}), ...data },
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Start a wizard from scratch. Use this whenever a screen begins a new flow:
 * merging into leftovers is how a top-up amount once turned a subscription
 * receipt into a balance top-up.
 */
export function resetStep(scope: string, userId: bigint | number, step: string, data: Record<string, unknown> = {}) {
  store.set(key(scope, userId), { step, data: { ...data }, expiresAt: Date.now() + TTL_MS });
}

export function getStep(scope: string, userId: bigint | number): Entry | undefined {
  const k = key(scope, userId);
  const entry = store.get(k);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(k);
    return undefined;
  }
  return entry;
}

export function clearStep(scope: string, userId: bigint | number) {
  store.delete(key(scope, userId));
}

/**
 * Drop every wizard this user is inside in the current bot, whatever the scope.
 * /bekor must actually cancel — clearing one scope leaves the user trapped in
 * another, where their next menu tap is eaten as wizard input.
 */
export function clearAll(userId: bigint | number, keep: string[] = []) {
  const prefix = `${ns()}|`;
  const suffix = `:${userId}`;
  for (const k of store.keys()) {
    if (!k.startsWith(prefix) || !k.endsWith(suffix)) continue;
    const scope = k.slice(prefix.length, k.length - suffix.length);
    if (!keep.includes(scope)) store.delete(k);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}, 60_000).unref();

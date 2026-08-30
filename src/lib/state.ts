/**
 * In-memory conversation state. Deliberately not Redis: this platform runs as a
 * single process, and a lost wizard step is recoverable by pressing the button
 * again. Entries expire so an abandoned wizard cannot pin memory forever.
 */
interface Entry {
  data: Record<string, unknown>;
  step: string;
  expiresAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const store = new Map<string, Entry>();

function key(scope: string, userId: bigint | number): string {
  return `${scope}:${userId}`;
}

export function setStep(scope: string, userId: bigint | number, step: string, data: Record<string, unknown> = {}) {
  const existing = store.get(key(scope, userId));
  store.set(key(scope, userId), {
    step,
    data: { ...(existing?.data ?? {}), ...data },
    expiresAt: Date.now() + TTL_MS,
  });
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
 * Drop every wizard this user is inside, whatever the scope.
 * /bekor must actually cancel — clearing one scope leaves the user trapped in
 * another, where their next menu tap is eaten as wizard input.
 */
export function clearAll(userId: bigint | number) {
  const suffix = `:${userId}`;
  for (const k of store.keys()) if (k.endsWith(suffix)) store.delete(k);
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) if (v.expiresAt < now) store.delete(k);
}, 60_000).unref();

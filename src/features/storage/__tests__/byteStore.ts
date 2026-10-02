/**
 * An in-memory `chrome.storage.local` that counts bytes as the browser does
 * (key plus JSON value) and runs every call in FIFO order, as one extension's
 * storage calls do (LC10). `hold()` stalls the queue until `release()`, so a
 * test can leave a `set` in flight. With a hard `quota`, a `set` that would
 * exceed it throws; `perKey` lands each key that fits on its own (LC9 variant).
 */
const encoder = new TextEncoder();

export const itemBytes = (key: string, value: unknown): number =>
  encoder.encode(key).byteLength + encoder.encode(JSON.stringify(value)).byteLength;

export class QuotaExceeded extends Error {}

export interface ByteStoreOptions {
  quota?: number | null;
  perKey?: boolean;
}

export function createByteStore(
  initial: Record<string, unknown> = {},
  options: ByteStoreOptions = {},
) {
  const items = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  let tail: Promise<unknown> = Promise.resolve();
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const log: string[] = [];

  const used = (): number =>
    [...items].reduce((sum, [key, value]) => sum + itemBytes(key, value), 0);
  const bytesOf = (keys: readonly string[]): number =>
    keys.reduce((sum, key) => sum + (items.has(key) ? itemBytes(key, items.get(key)) : 0), 0);

  /** Queues `op` behind every earlier call; a held queue keeps it waiting. */
  function enqueue<T>(name: string, op: () => T): Promise<T> {
    const run = async () => {
      if (gate) await gate;
      log.push(name);
      return op();
    };
    const next = tail.then(run, run);
    tail = next.catch(() => undefined);
    return next;
  }

  function put(entries: Array<[string, unknown]>): void {
    const quota = options.quota ?? null;
    const fits = (key: string, value: unknown) =>
      quota === null || used() - bytesOf([key]) + itemBytes(key, value) <= quota;
    if (options.perKey) {
      let failed = false;
      for (const [key, value] of entries) {
        if (fits(key, value)) items.set(key, structuredClone(value));
        else failed = true;
      }
      if (failed) throw new QuotaExceeded('QUOTA_BYTES quota exceeded');
      return;
    }
    const keys = entries.map(([key]) => key);
    const next = used() - bytesOf(keys) + entries.reduce((s, [k, v]) => s + itemBytes(k, v), 0);
    if (quota !== null && next > quota) throw new QuotaExceeded('QUOTA_BYTES quota exceeded');
    for (const [key, value] of entries) items.set(key, structuredClone(value));
  }

  const area = {
    get: (keys: string | readonly string[] | null) =>
      enqueue('get', () => {
        const wanted = keys === null ? [...items.keys()] : [keys].flat();
        return Object.fromEntries(
          wanted
            .filter((key) => items.has(key))
            .map((key) => [key, structuredClone(items.get(key))]),
        );
      }),
    getAll: () => area.get(null),
    set: (values: Record<string, unknown>) => enqueue('set', () => put(Object.entries(values))),
    remove: (keys: string | readonly string[]) =>
      enqueue('remove', () => [keys].flat().forEach((key) => items.delete(key))),
    getBytesInUse: (keys: string | readonly string[] | null) =>
      enqueue('bytes', () => (keys === null ? used() : bytesOf([keys].flat()))),
  };

  return {
    area,
    used,
    log,
    read: (key: string): unknown => structuredClone(items.get(key)),
    has: (key: string): boolean => items.has(key),
    /** Stalls every call issued from now on until `release`. */
    hold(): void {
      gate ??= new Promise<void>((resolve) => (open = resolve));
    },
    release(): void {
      open?.();
      gate = null;
      open = null;
    },
  };
}

export type ByteStore = ReturnType<typeof createByteStore>;

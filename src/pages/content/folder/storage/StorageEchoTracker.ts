/** How long an armed write may wait for its storage.onChanged echo. */
export const STORAGE_ECHO_SUPPRESS_WINDOW_MS = 2000;

export interface StorageEcho {
  readonly key: string;
  readonly serialized: string;
  readonly armedAt: number;
}

/**
 * JSON with object keys sorted at every level. chrome.storage hands listeners a
 * copy whose keys come back sorted, so insertion-order JSON would never match.
 */
export function serializeStoredValue(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
}

/**
 * Tells this context's own storage writes apart from writes by other contexts.
 * An echo matches only the exact value this context wrote: chrome.storage emits
 * nothing for an unchanged or rejected write, so a bare counter would stay armed
 * and swallow the next external update.
 */
export class StorageEchoTracker {
  private echoes: StorageEcho[] = [];
  /** Last value seen in storage.onChanged per key; unknown until an event arrives. */
  private readonly lastSeen = new Map<string, string>();

  /** Call before writing. Returns null when the write cannot produce an echo. */
  arm(key: string, serialized: string | undefined): StorageEcho | null {
    if (serialized === undefined || this.lastSeen.get(key) === serialized) return null;
    const echo: StorageEcho = { key, serialized, armedAt: Date.now() };
    this.echoes.push(echo);
    return echo;
  }

  /** Call when the write failed or threw: it changed nothing, so nothing echoes. */
  disarm(echo: StorageEcho | null): void {
    if (echo) this.echoes = this.echoes.filter((entry) => entry !== echo);
  }

  /** Records a storage change for `key`; true when it is the echo of an armed write. */
  consume(key: string, newValue: unknown): boolean {
    const serialized = serializeStoredValue(newValue);
    if (serialized === undefined) this.lastSeen.delete(key);
    else this.lastSeen.set(key, serialized);

    const now = Date.now();
    const live = this.echoes.filter(
      (echo) => now - echo.armedAt <= STORAGE_ECHO_SUPPRESS_WINDOW_MS,
    );
    const index = live.findIndex((echo) => echo.key === key && echo.serialized === serialized);
    // Events arrive in write order, so earlier echoes for this key will never come.
    // On a mismatch, drop them all: a later external write could restore their value.
    const cutoff = index === -1 ? Infinity : index;
    this.echoes = live.filter((echo, position) => echo.key !== key || position > cutoff);
    return index !== -1;
  }

  /** Forget everything, e.g. when the account binding changes. */
  reset(): void {
    this.echoes = [];
    this.lastSeen.clear();
  }
}

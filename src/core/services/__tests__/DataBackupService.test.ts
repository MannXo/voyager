import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import browser from 'webextension-polyfill';

import { DataBackupService } from '../DataBackupService';

// In-memory stand-in for browser.storage.local (the Safari durable mirror).
const durableStore: Record<string, unknown> = {};

vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) {
            if (key in durableStore) out[key] = durableStore[key];
          }
          return out;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(durableStore, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const key of list) delete durableStore[key];
        }),
      },
    },
  },
}));

// Toggle Safari detection per test. Read once per DataBackupService construction.
let isSafariValue = false;
vi.mock('@/core/utils/browser', () => ({
  isSafari: () => isSafariValue,
}));

interface Sample {
  folders: number[];
}

const PRIMARY_KEY = 'gvBackup_test-ns_primary';

describe('DataBackupService durable mirror (Safari)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSafariValue = false;
    vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
      Object.assign(durableStore, items);
    });
    localStorage.clear();
    for (const key of Object.keys(durableStore)) delete durableStore[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('writes only to localStorage on non-Safari and recovers from it', async () => {
    isSafariValue = false;
    const service = new DataBackupService<Sample>('test-ns');
    const data: Sample = { folders: [1, 2, 3] };

    expect(await service.createPrimaryBackup(data)).toBe(true);
    expect(localStorage.getItem(PRIMARY_KEY)).toBeTruthy();
    // No durable mirror writes on non-Safari browsers.
    expect(Object.keys(durableStore)).toHaveLength(0);
    expect(service.recoverFromBackup()).toEqual(data);
  });

  it('mirrors backups to the durable store on Safari', async () => {
    isSafariValue = true;
    const service = new DataBackupService<Sample>('test-ns');
    await service.ensureHydrated();

    await service.createPrimaryBackup({ folders: [9, 8, 7] });

    expect(localStorage.getItem(PRIMARY_KEY)).toBeTruthy();
    expect(durableStore[PRIMARY_KEY]).toBeTruthy();
  });

  it('restores backups from the durable store after Safari evicts localStorage', async () => {
    isSafariValue = true;
    const data: Sample = { folders: [5, 5, 5] };

    const writer = new DataBackupService<Sample>('test-ns');
    await writer.ensureHydrated();
    await writer.createPrimaryBackup(data);
    expect(durableStore[PRIMARY_KEY]).toBeTruthy();

    // Simulate Safari ITP wiping localStorage after ~7 days of inactivity.
    localStorage.clear();
    expect(localStorage.getItem(PRIMARY_KEY)).toBeNull();

    // A fresh page session hydrates from the durable mirror before recovery,
    // so the sync recoverFromBackup() still finds the data.
    const reader = new DataBackupService<Sample>('test-ns');
    await reader.ensureHydrated();
    expect(localStorage.getItem(PRIMARY_KEY)).toBeTruthy();
    expect(reader.recoverFromBackup()).toEqual(data);
  });

  it('still recovers a Safari backup older than 7 days (the ITP window the mirror targets)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      isSafariValue = true;
      const data: Sample = { folders: [7, 7, 7] };

      const writer = new DataBackupService<Sample>('test-ns');
      await writer.ensureHydrated();
      await writer.createPrimaryBackup(data);

      // Day 8: past the old 7-day TTL, and ITP has wiped page localStorage.
      vi.setSystemTime(new Date('2026-01-09T00:00:00Z'));
      localStorage.clear();

      const reader = new DataBackupService<Sample>('test-ns');
      await reader.ensureHydrated();
      // Must NOT be rejected as "too old" — that would defeat the whole fix.
      expect(reader.recoverFromBackup()).toEqual(data);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-Safari backup older than 7 days (original TTL preserved)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      isSafariValue = false;
      const service = new DataBackupService<Sample>('test-ns');
      await service.createPrimaryBackup({ folders: [1] });

      vi.setSystemTime(new Date('2026-01-09T00:00:00Z')); // 8 days later
      expect(service.recoverFromBackup()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('can read durable fallbacks on non-Safari', async () => {
    isSafariValue = false;
    const service = new DataBackupService<Sample>('test-ns');
    await expect(service.ensureHydrated()).resolves.toBeUndefined();
  });
});

// Atomic quota stand-in: an unsuccessful replacement must leave the old value intact.
function limitLocalStorage(limit: number): void {
  const values = new Map<string, string>();
  const setItem = localStorage.setItem.bind(localStorage);
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    const next = new Map(values).set(key, value);
    const size = [...next].reduce((sum, [name, stored]) => sum + name.length + stored.length, 0);
    if (size > limit) throw new DOMException('Storage full', 'QuotaExceededError');
    setItem(key, value);
    values.set(key, value);
  });
}

const EMERGENCY_KEY = 'gvBackup_test-ns_emergency';

describe('DataBackupService quota fallback', () => {
  beforeEach(() => {
    isSafariValue = false;
    vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
      Object.assign(durableStore, items);
    });
    localStorage.clear();
    for (const key of Object.keys(durableStore)) delete durableStore[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the previous emergency slot and recovers the newer durable copy on a fresh page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    limitLocalStorage(700);
    const old: Sample = { folders: [1] };
    const newer: Sample = { folders: Array.from({ length: 300 }, (_, i) => i) };
    const writer = new DataBackupService<Sample>('test-ns');
    expect(await writer.createEmergencyBackup(old)).toBe(true);
    const previous = localStorage.getItem(EMERGENCY_KEY);

    vi.advanceTimersByTime(1);
    expect(await writer.createEmergencyBackup(newer)).toBe(true);
    expect(localStorage.getItem(EMERGENCY_KEY)).toBe(previous);
    const reader = new DataBackupService<Sample>('test-ns');
    await reader.ensureHydrated();
    expect(reader.recoverFromBackup()).toEqual(newer);
  });

  it('reports failure when both stores reject a write and retains both older backups', async () => {
    limitLocalStorage(700);
    const old: Sample = { folders: [1] };
    const writer = new DataBackupService<Sample>('test-ns');
    expect(await writer.createEmergencyBackup(old)).toBe(true);
    const previous = localStorage.getItem(EMERGENCY_KEY)!;
    durableStore[EMERGENCY_KEY] = previous;
    vi.spyOn(browser.storage.local, 'set').mockRejectedValue(new Error('Extension quota full'));

    expect(await writer.createEmergencyBackup({ folders: Array(300).fill(100) })).toBe(false);
    expect(localStorage.getItem(EMERGENCY_KEY)).toBe(previous);
    expect(durableStore[EMERGENCY_KEY]).toBe(previous);
    await writer.ensureHydrated();
    expect(writer.recoverFromBackup()).toEqual(old);
  });

  it.each([false, true])(
    'recovers an absent emergency slot while localStorage stays full (Safari: %s)',
    async (safari) => {
      isSafariValue = safari;
      limitLocalStorage(700);
      const data: Sample = { folders: Array(300).fill(100) };
      const writer = new DataBackupService<Sample>('test-ns');
      expect(await writer.createEmergencyBackup(data)).toBe(true);
      expect(localStorage.getItem(EMERGENCY_KEY)).toBeNull();

      const reader = new DataBackupService<Sample>('test-ns');
      await reader.ensureHydrated();
      expect(localStorage.getItem(EMERGENCY_KEY)).toBeNull();
      expect(reader.recoverFromBackup()).toEqual(data);
    },
  );

  it('recovers an unload fallback when neither higher-priority slot is available', async () => {
    limitLocalStorage(700);
    const data: Sample = { folders: Array(300).fill(100) };
    const writer = new DataBackupService<Sample>('test-ns');
    writer.setupBeforeUnloadBackup(() => data);
    window.dispatchEvent(new Event('beforeunload'));
    await writer.ensureHydrated();
    writer.destroy();

    const reader = new DataBackupService<Sample>('test-ns');
    await reader.ensureHydrated();
    expect(reader.recoverFromBackup()).toEqual(data);
  });

  it('rejects an invalid durable copy and keeps the valid local copy', async () => {
    const data: Sample = { folders: [1] };
    const service = new DataBackupService<Sample>('test-ns', (value) =>
      Array.isArray(value.folders),
    );
    await service.createEmergencyBackup(data);
    durableStore[EMERGENCY_KEY] = JSON.stringify({
      data: { folders: 'broken' },
      metadata: { timestamp: new Date().toISOString() },
    });
    await service.ensureHydrated();
    expect(service.recoverFromBackup()).toEqual(data);
  });

  it('does not let an older delayed fallback replace a newer emergency backup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    limitLocalStorage(700);
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    let writes = 0;
    vi.mocked(browser.storage.local.set).mockImplementation(async (items) => {
      if (++writes === 1) await firstWrite;
      Object.assign(durableStore, items);
    });
    const service = new DataBackupService<Sample>('test-ns');
    const old = service.createEmergencyBackup({ folders: Array(300).fill(100) });
    vi.advanceTimersByTime(1);
    const newer: Sample = { folders: Array(300).fill(101) };
    const latest = service.createEmergencyBackup(newer);
    await Promise.resolve();
    await Promise.resolve();
    release();
    await Promise.all([old, latest]);

    const reader = new DataBackupService<Sample>('test-ns');
    await reader.ensureHydrated();
    expect(reader.recoverFromBackup()).toEqual(newer);
  });

  it('clears durable fallbacks as well as page slots', async () => {
    limitLocalStorage(700);
    const service = new DataBackupService<Sample>('test-ns');
    await service.createEmergencyBackup({ folders: Array(300).fill(100) });
    service.clearAllBackups();
    await service.ensureHydrated();
    expect(service.recoverFromBackup()).toBeNull();
    expect(Object.keys(durableStore)).toHaveLength(0);
  });
});

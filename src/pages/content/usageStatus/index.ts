/** Account-scoped usage cache, DOM scraping and silent refresh for Gemini. */
import browser from 'webextension-polyfill';

import { StorageKeys } from '@/core/types/common';
import { getCurrentLanguage, getTranslationSync, initI18n } from '@/utils/i18n';
import type { AppLanguage } from '@/utils/language';
import type { TranslationKey } from '@/utils/translations';

import { watchRouteChanges } from '../utils/routeWatcher';
import { USAGE_REFRESH_ICON } from './icons';
import {
  formatResetLabel,
  hydrateUsageResetEpochs,
  parseUsageRpcResponse,
  scrapeUsageFromDocument,
  snapshotFromParsed,
} from './usageParsing';
import {
  isUsagePathname,
  mergeAutomaticUsageSnapshots,
  mergeUsageSnapshots,
  selectUsageSnapshotForAccount,
  snapshotEquals,
  usageAccountKeyFromPathname,
  usageCacheKeyForAccount,
  usagePathForPathname,
  usageUrlForPathname,
} from './usageSnapshot';
import type {
  MergeUsageSnapshotOptions,
  RawMetric,
  UsageMetric,
  UsageSnapshot,
} from './usageSnapshot';

/** Map a Voyager language to a BCP-47 tag for Intl date formatting. */
function localeFromLanguage(lang: AppLanguage): string {
  if (lang === 'zh') return 'zh-CN';
  if (lang === 'zh_TW') return 'zh-TW';
  return lang;
}

export type UsagePillMode = 'hidden' | 'empty' | 'ready';

const PILL_ID = 'gv-usage-pill';
const SCRAPE_DEBOUNCE_MS = 300;
// Refresh the relative "updated X ago" stamp without re-scraping.
const STAMP_REFRESH_MS = 30_000;
// Bridge to the MAIN-world usage-observer (document_start). Must match the
// `source` strings in public/usage-observer.js.
const OBS_SRC = 'gv-usage-observer';
const OBS_CMD = 'gv-usage-observer-cmd';
// Silent refresh. Usage only changes when the user sends a message, so the
// primary trigger is event-driven (a generation completing); these are the
// conservative idle fallbacks. Larger intervals = fewer requests = lower
// detection surface; the replay is the same call the page makes, with the
// user's own tokens, at human cadence.
const STALE_MS = 5 * 60_000; // consider a snapshot stale after 5 min
const HEARTBEAT_MS = 2 * 60_000; // idle re-check cadence (staleness-gated)
const GEN_DEBOUNCE_MS = 4_000; // wait after a generation completes, then refresh
const REGRESSION_CONFIRM_MS = 2_000;
// Known usage RPC (verified live: rpcid `jSf9Qc`, empty args). Used as the
// out-of-the-box recipe so silent refresh works on enable without first cold-
// loading /usage; the document_start observer re-calibrates (DOM-verified) if
// Google rotates the obfuscated id.
interface UsageRecipe {
  rpcid: string;
  args: string;
}

const DEFAULT_RECIPE: UsageRecipe = { rpcid: 'jSf9Qc', args: '[]' };

// -----------------------------------------------------------------------------
// Module state
// -----------------------------------------------------------------------------

let started = false;
let enabled = false;
let snapshot: UsageSnapshot | null = null;

let scrapeObserver: MutationObserver | null = null;
let scrapeTimer: number | null = null;
let scrapeRetryTimer: number | null = null;
let stampTimer: number | null = null;
let stopRouteWatcher: (() => void) | null = null;
let storageListener:
  | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
  | null = null;
let pill: HTMLElement | null = null;
let observerMessageHandler: ((ev: MessageEvent) => void) | null = null;
let observerReady = false;
// User-placed position (viewport px, top-left). Null = default bottom-right.
let dragPos: { x: number; y: number } | null = null;
let dragging = false;
let dragMoved = false;
let dragOffset = { x: 0, y: 0 };
let dragStart = { x: 0, y: 0 };
let pillMoveHandler: ((ev: PointerEvent) => void) | null = null;
let recipe: UsageRecipe | null = null;
let replayTimer: number | null = null;
let replaySeq = 0;
const replayRequests = new Map<number, { allowRegression: boolean; startedAt: number }>();
let pendingRegression: UsageSnapshot | null = null;
let regressionConfirmTimer: number | null = null;
let genTimer: number | null = null;
let spinTimer: number | null = null;
let visibilityHandler: (() => void) | null = null;
// BCP-47 locale for reset-time formatting, derived from the Voyager language.
let uiLocale: string | undefined;

const t = (key: TranslationKey, fallback: string): string => {
  const value = getTranslationSync(key);
  return value === key ? fallback : value;
};

// -----------------------------------------------------------------------------
// Scraper (pure helpers are exported for unit tests)
// -----------------------------------------------------------------------------

function isOnUsagePage(): boolean {
  return isUsagePathname(location.pathname);
}

function currentUsageAccountKey(): string {
  return usageAccountKeyFromPathname(location.pathname);
}

function currentUsageCacheKey(): string {
  return usageCacheKeyForAccount(currentUsageAccountKey());
}

function scopeSnapshot(next: UsageSnapshot): UsageSnapshot {
  return {
    ...next,
    accountKey: currentUsageAccountKey(),
    sourceStartedAt: next.updatedAt,
    regressionVerified: true,
  };
}

function isCurrentAccountSnapshot(raw: UsageSnapshot | null | undefined): raw is UsageSnapshot {
  return raw?.accountKey === currentUsageAccountKey();
}

async function saveSnapshot(next: UsageSnapshot): Promise<void> {
  try {
    await browser.storage.local.set({
      [usageCacheKeyForAccount(next.accountKey ?? currentUsageAccountKey())]: next,
      [StorageKeys.GV_USAGE_CACHE]: next,
    });
  } catch (error) {
    console.warn('[UsageStatus] Failed to persist usage cache:', error);
  }
}

async function loadSnapshot(): Promise<UsageSnapshot | null> {
  try {
    const accountKey = currentUsageAccountKey();
    const scopedKey = usageCacheKeyForAccount(accountKey);
    const result = await browser.storage.local.get([scopedKey, StorageKeys.GV_USAGE_CACHE]);
    const selected = selectUsageSnapshotForAccount(
      (result as Record<string, unknown>)[scopedKey],
      (result as Record<string, unknown>)[StorageKeys.GV_USAGE_CACHE],
      accountKey,
    );
    return selected
      ? hydrateUsageResetEpochs(selected, Date.now(), [
          document.documentElement.lang,
          uiLocale,
          'en',
          'zh-CN',
          'zh-TW',
        ])
      : null;
  } catch (error) {
    console.warn('[UsageStatus] Failed to load usage cache:', error);
  }
  return null;
}

function scheduleScrape(): void {
  if (scrapeTimer !== null) return;
  scrapeTimer = window.setTimeout(() => {
    scrapeTimer = null;
    const next = scrapeUsageFromDocument();
    if (!next) return; // transient empty render — keep the last good snapshot
    snapshot = mergeUsageSnapshots(snapshot, scopeSnapshot(next), { allowRegression: true });
    void saveSnapshot(snapshot);
    render();
  }, SCRAPE_DEBOUNCE_MS);
}

function setupScrapeObserver(): void {
  if (!isOnUsagePage()) return;

  const root = document.querySelector('usage-metrics-window, .usage-metrics-container');
  if (!root) {
    // Angular hasn't mounted the usage component yet; retry shortly.
    if (scrapeRetryTimer === null) {
      scrapeRetryTimer = window.setTimeout(() => {
        scrapeRetryTimer = null;
        setupScrapeObserver();
      }, 500);
    }
    return;
  }
  if (scrapeRetryTimer !== null) {
    clearTimeout(scrapeRetryTimer);
    scrapeRetryTimer = null;
  }

  scheduleScrape();
  scrapeObserver?.disconnect();
  scrapeObserver = new MutationObserver(() => scheduleScrape());
  scrapeObserver.observe(root, { childList: true, subtree: true, characterData: true });
}

function teardownScrapeObserver(): void {
  scrapeObserver?.disconnect();
  scrapeObserver = null;
  if (scrapeTimer !== null) {
    clearTimeout(scrapeTimer);
    scrapeTimer = null;
  }
  if (scrapeRetryTimer !== null) {
    clearTimeout(scrapeRetryTimer);
    scrapeRetryTimer = null;
  }
}

// -----------------------------------------------------------------------------
// RPC parsing (silent refresh) — pure, exported for tests
//
// The usage data comes from a `batchexecute` RPC (rpcid `jSf9Qc`, args `[]`)
// whose payload is `[flag, [metric, metric], bool]` and each metric is
// `[limit, fractionUsed, periodEnum, [[resetEpochSec, nanos]]]`. We parse it
// structurally (not by hard-coded rpcid) so it keeps working if Google rotates
// the obfuscated id, and DOM-verify it before trusting it. Envelope decoding
// lives in the shared `decodeBatchExecute` util.
// -----------------------------------------------------------------------------

/** Re-localize a metric's reset label from its epoch (used on language change). */
function reformatReset(m: UsageMetric): string {
  return typeof m.resetEpoch === 'number'
    ? formatResetLabel(m.resetEpoch, Date.now(), uiLocale)
    : m.resetLabel;
}

// -----------------------------------------------------------------------------
// Injector — the pill
// -----------------------------------------------------------------------------

/** "updated X ago" stamp from a timestamp. Pure so it can be unit-tested. */
export function formatUpdatedAgo(updatedAt: number, now: number): string {
  const diffMs = Math.max(0, now - updatedAt);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return t('usageStatusJustUpdated', 'Just updated');
  if (min < 60) return t('usageStatusMinutesAgo', 'Updated {n}m ago').replace('{n}', String(min));
  const hours = Math.floor(min / 60);
  if (hours < 24) return t('usageStatusHoursAgo', 'Updated {n}h ago').replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  return t('usageStatusDaysAgo', 'Updated {n}d ago').replace('{n}', String(days));
}

export function formatResetCountdown(epochSec: number | undefined, now: number): string {
  if (typeof epochSec !== 'number') return '';
  const diffMs = epochSec * 1000 - now;
  if (diffMs <= 0) return '';
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const restMins = mins % 60;
  if (hours < 1) return `${mins}m`;
  if (hours < 24) return restMins > 0 ? `${hours}h${restMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `${days}d${rest}h`;
}

const OPEN_ICON = `<svg viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true"><path d="M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h280v80H200v560h560v-280h80v280q0 33-23.5 56.5T760-120H200Zm188-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z"/></svg>`;

/** Build a compact metric segment: label · thin bar · percent. */
function buildMetric(kind: 'daily' | 'weekly'): HTMLElement {
  const seg = document.createElement('div');
  seg.className = 'gv-usage-metric';
  seg.dataset.kind = kind;

  const name = document.createElement('span');
  name.className = 'gv-usage-label';
  seg.appendChild(name);

  const track = document.createElement('span');
  track.className = 'gv-usage-track';
  const fill = document.createElement('span');
  fill.className = 'gv-usage-fill';
  track.appendChild(fill);
  seg.appendChild(track);

  const pct = document.createElement('span');
  pct.className = 'gv-usage-pct';
  seg.appendChild(pct);

  return seg;
}

/**
 * Build the pill skeleton once. Labels/titles are (re)applied on every render so
 * a late-initialised i18n language still lands correctly (no frozen English).
 */
function ensurePill(): HTMLElement {
  const existing = document.getElementById(PILL_ID);
  if (existing) {
    pill = existing;
    return existing;
  }

  const el = document.createElement('div');
  el.id = PILL_ID;
  el.className = 'gv-usage-pill';
  el.setAttribute('role', 'group');

  const tier = document.createElement('span');
  tier.className = 'gv-usage-tier';
  el.appendChild(tier);

  const empty = document.createElement('a');
  empty.className = 'gv-usage-empty';
  empty.target = '_blank';
  empty.rel = 'noopener noreferrer';
  empty.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(empty);

  el.appendChild(buildMetric('daily'));
  el.appendChild(buildMetric('weekly'));

  // Refresh = force an immediate silent replay. Never navigates.
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'gv-usage-refresh';
  refresh.innerHTML = USAGE_REFRESH_ICON;
  refresh.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    requestReplay(true);
  });
  el.appendChild(refresh);

  // The only affordance that opens the native /usage page — a real link, new tab.
  const open = document.createElement('a');
  open.className = 'gv-usage-open';
  open.href = usageUrlForPathname(location.pathname);
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.innerHTML = OPEN_ICON;
  open.addEventListener('click', (e) => e.stopPropagation());
  el.appendChild(open);

  // Draggable: grab anywhere on the bar to reposition; the spot is persisted.
  // The refresh/open controls opt out so they stay clickable.
  el.addEventListener('pointerdown', onPillPointerDown);

  document.body.appendChild(el);
  pill = el;
  return el;
}

function setMetric(el: HTMLElement, kind: 'daily' | 'weekly', metric: UsageMetric | null): void {
  const seg = el.querySelector<HTMLElement>(`.gv-usage-metric[data-kind="${kind}"]`);
  if (!seg) return;
  const label = seg.querySelector<HTMLElement>('.gv-usage-label');
  const fill = seg.querySelector<HTMLElement>('.gv-usage-fill');
  const pct = seg.querySelector<HTMLElement>('.gv-usage-pct');
  if (label) {
    label.textContent =
      kind === 'daily' ? t('usageStatusDaily', '5h') : t('usageStatusWeekly', 'Weekly');
  }
  if (metric) {
    seg.removeAttribute('hidden');
    if (fill) fill.style.width = `${metric.percent}%`;
    if (pct) {
      const reset = formatResetCountdown(metric.resetEpoch, Date.now());
      pct.textContent = `${metric.percent}%${reset ? ` (${reset})` : ''}`;
    }
    seg.classList.toggle('gv-usage-high', metric.percent >= 90);
    seg.classList.toggle('gv-usage-mid', metric.percent >= 70 && metric.percent < 90);
    // Reset time lives in the segment tooltip to keep the bar short.
    seg.title = metric.resetLabel ? `${t('usageStatusResets', 'Resets')} ${metric.resetLabel}` : '';
  } else {
    seg.setAttribute('hidden', '');
  }
}

function updatePillContent(el: HTMLElement, snap: UsageSnapshot | null): void {
  el.setAttribute('aria-label', t('usageStatusTitle', 'Gemini usage limits'));

  const hasData = Boolean(snap?.daily || snap?.weekly);
  const empty = el.querySelector<HTMLAnchorElement>('.gv-usage-empty');
  if (empty) {
    const label = t('usageStatusEmptyHint', 'Click to load usage');
    empty.textContent = label;
    empty.href = usageUrlForPathname(location.pathname);
    empty.toggleAttribute('hidden', hasData);
    empty.setAttribute('aria-label', label);
  }

  const tier = el.querySelector<HTMLElement>('.gv-usage-tier');
  if (tier) {
    tier.textContent = snap?.tier ?? '';
    tier.toggleAttribute('hidden', !snap?.tier);
  }
  const refresh = el.querySelector<HTMLElement>('.gv-usage-refresh');
  if (refresh) {
    const label = t('usageStatusRefresh', 'Refresh');
    refresh.setAttribute('aria-label', label);
    refresh.title = label;
    refresh.toggleAttribute('hidden', !hasData);
  }
  const open = el.querySelector<HTMLElement>('.gv-usage-open');
  if (open) {
    const label = t('usageStatusOpenHint', 'Open usage limits');
    open.setAttribute('aria-label', label);
    open.title = label;
    if (open instanceof HTMLAnchorElement) open.href = usageUrlForPathname(location.pathname);
    open.toggleAttribute('hidden', !hasData);
  }

  setMetric(el, 'daily', snap?.daily ?? null);
  setMetric(el, 'weekly', snap?.weekly ?? null);

  // Freshness lives in the pill's own tooltip (segment tooltips show resets).
  el.title = snap
    ? formatUpdatedAgo(snap.updatedAt, Date.now())
    : t('usageStatusEmptyHint', 'Click to load usage');
}

/** Clamp a top-left position so the pill stays fully on screen. */
function clampPos(x: number, y: number): { x: number; y: number } {
  const w = pill?.offsetWidth ?? 240;
  const h = pill?.offsetHeight ?? 32;
  return {
    x: Math.max(8, Math.min(window.innerWidth - w - 8, x)),
    y: Math.max(8, Math.min(window.innerHeight - h - 8, y)),
  };
}

/** Position the bar: at the user-dragged spot if set, else bottom-centered. */
function positionPill(el: HTMLElement): void {
  if (dragging) return;
  if (dragPos) {
    const { x, y } = clampPos(dragPos.x, dragPos.y);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.transform = 'none';
  } else {
    // Default: centered along the bottom edge, clear of the corner.
    el.style.left = '50%';
    el.style.top = 'auto';
    el.style.right = 'auto';
    el.style.bottom = '20px';
    el.style.transform = 'translateX(-50%)';
  }
}

function onPillPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0 || !pill) return;
  // Don't start a drag from the interactive controls.
  if ((ev.target as Element | null)?.closest('.gv-usage-empty, .gv-usage-refresh, .gv-usage-open'))
    return;
  dragging = true;
  dragMoved = false;
  const rect = pill.getBoundingClientRect();
  dragOffset = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  dragStart = { x: ev.clientX, y: ev.clientY };
  try {
    pill.setPointerCapture(ev.pointerId);
  } catch {
    // ignore
  }
  pill.classList.add('gv-usage-dragging');
  pillMoveHandler = onPillPointerMove;
  window.addEventListener('pointermove', pillMoveHandler);
  window.addEventListener('pointerup', onPillPointerUp, { once: true });
}

function onPillPointerMove(ev: PointerEvent): void {
  if (!dragging || !pill) return;
  if (Math.abs(ev.clientX - dragStart.x) + Math.abs(ev.clientY - dragStart.y) > 3) dragMoved = true;
  const { x, y } = clampPos(ev.clientX - dragOffset.x, ev.clientY - dragOffset.y);
  pill.style.left = `${x}px`;
  pill.style.top = `${y}px`;
  pill.style.right = 'auto';
  pill.style.bottom = 'auto';
  // Drop the centered-default transform so `left` maps 1:1 to the pointer.
  pill.style.transform = 'none';
}

function onPillPointerUp(): void {
  if (!dragging) return;
  dragging = false;
  if (pillMoveHandler) {
    window.removeEventListener('pointermove', pillMoveHandler);
    pillMoveHandler = null;
  }
  pill?.classList.remove('gv-usage-dragging');
  if (dragMoved && pill) {
    const rect = pill.getBoundingClientRect();
    dragPos = { x: Math.round(rect.left), y: Math.round(rect.top) };
    void saveDragPos(dragPos);
  }
}

async function loadDragPos(): Promise<void> {
  try {
    const r = await browser.storage.local.get(StorageKeys.GV_USAGE_POS);
    const raw = (r as Record<string, unknown>)[StorageKeys.GV_USAGE_POS];
    if (raw && typeof raw === 'object') {
      const p = raw as { x?: unknown; y?: unknown };
      if (typeof p.x === 'number' && typeof p.y === 'number') dragPos = { x: p.x, y: p.y };
    }
  } catch {
    // ignore
  }
}

async function saveDragPos(pos: { x: number; y: number }): Promise<void> {
  try {
    await browser.storage.local.set({ [StorageKeys.GV_USAGE_POS]: pos });
  } catch {
    // ignore
  }
}

function setSpinning(on: boolean): void {
  pill?.classList.toggle('gv-usage-loading', on);
}

function removePill(): void {
  if (pillMoveHandler) {
    window.removeEventListener('pointermove', pillMoveHandler);
    pillMoveHandler = null;
  }
  dragging = false;
  if (pill) {
    pill.remove();
    pill = null;
  }
  const stray = document.getElementById(PILL_ID);
  if (stray) stray.remove();
  if (stampTimer !== null) {
    clearInterval(stampTimer);
    stampTimer = null;
  }
  window.removeEventListener('resize', onResize);
}

function onResize(): void {
  if (pill) positionPill(pill);
}

export function getUsagePillMode(
  isEnabled: boolean,
  hostname: string,
  currentSnapshot: UsageSnapshot | null,
): UsagePillMode {
  if (!isEnabled || hostname !== 'gemini.google.com') return 'hidden';
  return currentSnapshot?.daily || currentSnapshot?.weekly ? 'ready' : 'empty';
}

function render(): void {
  const mode = getUsagePillMode(enabled, location.hostname, snapshot);
  if (mode === 'hidden') {
    removePill();
    return;
  }

  const el = ensurePill();
  updatePillContent(el, snapshot);
  positionPill(el);
  window.addEventListener('resize', onResize);

  if (stampTimer === null) {
    stampTimer = window.setInterval(() => {
      if (pill) updatePillContent(pill, snapshot);
    }, STAMP_REFRESH_MS);
  }
}

// -----------------------------------------------------------------------------
// Settings + lifecycle
// -----------------------------------------------------------------------------

async function loadEnabled(): Promise<boolean> {
  try {
    const sync = await browser.storage.sync.get({ [StorageKeys.USAGE_STATUS_ENABLED]: false });
    return (sync as Record<string, unknown>)[StorageKeys.USAGE_STATUS_ENABLED] === true;
  } catch {
    return false;
  }
}

function setupStorageListener(): void {
  storageListener = (changes, areaName) => {
    if (areaName === 'sync' && changes[StorageKeys.USAGE_STATUS_ENABLED]) {
      enabled = changes[StorageKeys.USAGE_STATUS_ENABLED].newValue === true;
      render();
      if (enabled) {
        startReplayLoop();
      } else {
        stopReplayLoop();
      }
      return;
    }
    if (changes[StorageKeys.LANGUAGE]) {
      // Voyager language changed — re-localize reset dates + labels.
      void getCurrentLanguage().then((lang) => {
        uiLocale = localeFromLanguage(lang);
        if (snapshot) {
          // Reformat reset labels under the new locale.
          snapshot = {
            ...snapshot,
            daily: snapshot.daily
              ? { ...snapshot.daily, resetLabel: reformatReset(snapshot.daily) }
              : null,
            weekly: snapshot.weekly
              ? { ...snapshot.weekly, resetLabel: reformatReset(snapshot.weekly) }
              : null,
          };
        }
        render();
      });
    }
    const usageCacheChange =
      areaName === 'local'
        ? (changes[currentUsageCacheKey()] ?? changes[StorageKeys.GV_USAGE_CACHE])
        : null;
    if (usageCacheChange) {
      const raw = usageCacheChange.newValue as UsageSnapshot | undefined;
      if (raw && typeof raw.updatedAt === 'number' && isCurrentAccountSnapshot(raw)) {
        const merged = mergeUsageSnapshots(snapshot, raw, {
          allowRegression: raw.regressionVerified === true,
        });
        if (!snapshotEquals(merged, raw)) void saveSnapshot(merged);
        snapshot = merged;
        render();
      }
    }
    if (areaName === 'local' && changes[StorageKeys.GV_USAGE_RECIPE]) {
      // Another tab calibrated the recipe — adopt it so this tab can replay too.
      const raw = changes[StorageKeys.GV_USAGE_RECIPE].newValue as UsageRecipe | undefined;
      if (raw && typeof raw.rpcid === 'string') recipe = raw;
    }
    if (areaName === 'local' && changes[StorageKeys.GV_USAGE_POS]) {
      // Another tab moved the bar — mirror its placement.
      const raw = changes[StorageKeys.GV_USAGE_POS].newValue as
        | { x?: unknown; y?: unknown }
        | undefined;
      dragPos =
        raw && typeof raw.x === 'number' && typeof raw.y === 'number'
          ? { x: raw.x, y: raw.y }
          : null;
      if (pill) positionPill(pill);
    }
  };
  browser.storage.onChanged.addListener(storageListener);
}

function handleNavigation(): void {
  clearRegressionConfirmation();
  window.setTimeout(() => {
    void (async () => {
      snapshot = await loadSnapshot();
      if (isOnUsagePage()) {
        setupScrapeObserver();
      } else {
        teardownScrapeObserver();
      }
      render();
      if (enabled) maybeReplay();
    })();
  }, 250);
}

// -----------------------------------------------------------------------------
// MAIN-world observer bridge (silent refresh)
// -----------------------------------------------------------------------------

async function loadRecipe(): Promise<UsageRecipe | null> {
  try {
    const result = await browser.storage.local.get(StorageKeys.GV_USAGE_RECIPE);
    const raw = (result as Record<string, unknown>)[StorageKeys.GV_USAGE_RECIPE];
    if (raw && typeof raw === 'object' && typeof (raw as UsageRecipe).rpcid === 'string') {
      return raw as UsageRecipe;
    }
  } catch {
    // ignore
  }
  return null;
}

async function saveRecipe(next: UsageRecipe): Promise<void> {
  recipe = next;
  try {
    await browser.storage.local.set({ [StorageKeys.GV_USAGE_RECIPE]: next });
  } catch {
    // ignore
  }
}

/** Adopt a freshly parsed snapshot if it has data; carry the tier forward. */
function applyParsed(
  parsed: { daily: RawMetric | null; weekly: RawMetric | null },
  tier: string | undefined,
  options: MergeUsageSnapshotOptions = {},
  sourceStartedAt: number = Date.now(),
): void {
  if (!parsed.daily && !parsed.weekly) return;
  const now = Date.now();
  snapshot = mergeUsageSnapshots(
    snapshot,
    snapshotFromParsed(
      parsed,
      now,
      tier ?? snapshot?.tier,
      currentUsageAccountKey(),
      uiLocale,
      sourceStartedAt,
      options.allowRegression === true,
    ),
    options,
  );
  void saveSnapshot(snapshot);
  render();
}

function clearRegressionConfirmation(): void {
  pendingRegression = null;
  if (regressionConfirmTimer !== null) {
    clearTimeout(regressionConfirmTimer);
    regressionConfirmTimer = null;
  }
}

function scheduleRegressionConfirmation(): void {
  if (!enabled || regressionConfirmTimer !== null) return;
  regressionConfirmTimer = window.setTimeout(() => {
    regressionConfirmTimer = null;
    requestReplay();
  }, REGRESSION_CONFIRM_MS);
}

function applyAutomaticParsed(
  parsed: { daily: RawMetric | null; weekly: RawMetric | null },
  sourceStartedAt: number,
): void {
  if (!parsed.daily && !parsed.weekly) return;
  const now = Date.now();
  const next = snapshotFromParsed(
    parsed,
    now,
    snapshot?.tier,
    currentUsageAccountKey(),
    uiLocale,
    sourceStartedAt,
  );
  const result = mergeAutomaticUsageSnapshots(snapshot, pendingRegression, next, now);
  snapshot = result.snapshot;
  pendingRegression = result.candidate;
  if (result.needsConfirmation) scheduleRegressionConfirmation();
  else clearRegressionConfirmation();
  void saveSnapshot(snapshot);
  render();
}

/**
 * A capture arrived from the observer (only fires on /usage). Parse it; if it's
 * the usage RPC and its numbers agree with the rendered DOM, remember the
 * {rpcid, args} recipe for silent replay and adopt the precise values.
 */
function handleCapture(payload: { rpcid?: string; args?: string | null; body?: string }): void {
  if (!enabled || !isOnUsagePage()) return;
  if (!payload || typeof payload.body !== 'string') return;
  const parsed = parseUsageRpcResponse(payload.body);
  if (!parsed) return;

  // Cross-verify against the rendered DOM (ground truth) before trusting it as
  // the recipe — a wrong recipe would silently feed bad numbers off /usage.
  const dom = scrapeUsageFromDocument();
  const close = (a: UsageMetric | null, b: RawMetric | null): boolean =>
    !a || !b || Math.abs(a.percent - b.percent) <= 2;
  if (dom && (!close(dom.daily, parsed.daily) || !close(dom.weekly, parsed.weekly))) return;

  void saveRecipe({
    rpcid: typeof payload.rpcid === 'string' ? payload.rpcid : parsed.rpcid,
    args: typeof payload.args === 'string' ? payload.args : '[]',
  });
  clearRegressionConfirmation();
  applyParsed(parsed, dom?.tier, { allowRegression: true });
}

function handleReplayResult(payload: { id?: number; body?: string; error?: string }): void {
  setSpinning(false);
  if (spinTimer !== null) {
    clearTimeout(spinTimer);
    spinTimer = null;
  }
  const request = typeof payload.id === 'number' ? replayRequests.get(payload.id) : undefined;
  if (typeof payload.id === 'number') replayRequests.delete(payload.id);
  if (typeof payload.error === 'string' && payload.error) {
    console.warn('[UsageStatus] Usage refresh failed:', payload.error);
  }
  if (!enabled || !payload || typeof payload.body !== 'string') return;
  const parsed = parseUsageRpcResponse(payload.body);
  if (!parsed) return;
  if (request?.allowRegression) {
    clearRegressionConfirmation();
    applyParsed(parsed, undefined, { allowRegression: true }, request.startedAt);
  } else {
    applyAutomaticParsed(parsed, request?.startedAt ?? Date.now());
  }
}

/** A Gemini generation just finished → usage changed → refresh shortly after. */
function onGenerationComplete(): void {
  if (!enabled || !recipe) return;
  if (genTimer !== null) clearTimeout(genTimer);
  genTimer = window.setTimeout(() => {
    genTimer = null;
    requestReplay();
  }, GEN_DEBOUNCE_MS);
}

function setupObserverBridge(): void {
  if (observerMessageHandler) return;
  observerMessageHandler = (ev: MessageEvent) => {
    if (ev.source !== window) return;
    const data = ev.data as { source?: string; type?: string; payload?: unknown } | null;
    if (!data || data.source !== OBS_SRC) return;
    if (data.type === 'ready') {
      observerReady = true;
    } else if (data.type === 'capture') {
      handleCapture(data.payload as { rpcid?: string; args?: string | null; body?: string });
    } else if (data.type === 'replay-result') {
      handleReplayResult(data.payload as { id?: number; body?: string; error?: string });
    } else if (data.type === 'generation-complete') {
      onGenerationComplete();
    }
  };
  window.addEventListener('message', observerMessageHandler);
  window.postMessage({ source: OBS_CMD, type: 'ping' }, window.location.origin);
}

function teardownObserverBridge(): void {
  if (observerMessageHandler) {
    window.removeEventListener('message', observerMessageHandler);
    observerMessageHandler = null;
  }
  observerReady = false;
  stopReplayLoop();
  if (spinTimer !== null) {
    clearTimeout(spinTimer);
    spinTimer = null;
  }
}

/** Ask the MAIN-world observer to re-issue the usage RPC with the page's tokens. */
function requestReplay(allowRegression = false): void {
  if (!recipe) return;
  setSpinning(true);
  if (spinTimer !== null) clearTimeout(spinTimer);
  spinTimer = window.setTimeout(() => {
    spinTimer = null;
    setSpinning(false);
    console.warn(
      observerReady
        ? '[UsageStatus] Usage refresh timed out.'
        : '[UsageStatus] Usage observer unavailable; refresh could not run.',
    );
  }, 6_000);
  const id = ++replaySeq;
  const startedAt = Date.now();
  for (const [requestId, request] of replayRequests) {
    if (startedAt - request.startedAt > 30_000) replayRequests.delete(requestId);
  }
  replayRequests.set(id, { allowRegression, startedAt });
  try {
    window.postMessage(
      {
        source: OBS_CMD,
        type: 'replay',
        payload: {
          id,
          rpcid: recipe.rpcid,
          args: recipe.args,
          // This RPC belongs to Gemini's usage surface. Passing the current
          // conversation route worked only while the backend ignored
          // `source-path`; account-scoped `/usage` keeps replay faithful to the
          // request we originally captured.
          sourcePath: usagePathForPathname(location.pathname),
        },
      },
      location.origin,
    );
  } catch {
    // ignore — page gone / context invalidated
  }
}

/** Idle fallback: replay only when off /usage, holding a recipe, and stale. */
function maybeReplay(): void {
  if (!enabled || !recipe || isOnUsagePage()) return;
  if (snapshot && Date.now() - snapshot.updatedAt < STALE_MS) return;
  requestReplay();
}

function startReplayLoop(): void {
  if (replayTimer !== null) return;
  maybeReplay();
  replayTimer = window.setInterval(maybeReplay, HEARTBEAT_MS);
  if (!visibilityHandler) {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') maybeReplay();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
}

function stopReplayLoop(): void {
  if (replayTimer !== null) {
    clearInterval(replayTimer);
    replayTimer = null;
  }
  if (genTimer !== null) {
    clearTimeout(genTimer);
    genTimer = null;
  }
  clearRegressionConfirmation();
  replayRequests.clear();
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
}

export async function startUsageStatus(): Promise<() => void> {
  if (started) return () => {};
  started = true;

  // Ensure the language is resolved before the first render so labels and reset
  // dates localize correctly (no frozen English).
  try {
    await initI18n();
    uiLocale = localeFromLanguage(await getCurrentLanguage());
  } catch {
    // best-effort — English fallback is acceptable
  }

  enabled = await loadEnabled();
  snapshot = await loadSnapshot();
  recipe = (await loadRecipe()) ?? DEFAULT_RECIPE;
  await loadDragPos();
  setupStorageListener();
  setupObserverBridge();

  if (isOnUsagePage()) setupScrapeObserver();
  render();
  if (enabled) startReplayLoop();

  stopRouteWatcher = watchRouteChanges(handleNavigation);

  return () => {
    started = false;
    teardownScrapeObserver();
    teardownObserverBridge();
    removePill();
    stopRouteWatcher?.();
    stopRouteWatcher = null;
    if (storageListener) {
      browser.storage.onChanged.removeListener(storageListener);
      storageListener = null;
    }
  };
}

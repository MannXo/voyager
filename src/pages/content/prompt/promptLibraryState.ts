/**
 * Prompt Manager's copy of the prompt library (`gvPromptItems`) and every
 * change the panel makes to it. The panel renders `items` and calls these
 * methods; it never writes the library itself.
 *
 * Each change is sent as an op to the background owner, which applies it to
 * the library as stored at that moment, so an edit in another tab, a template
 * save, an import or a Drive merge is never written over. The panel shows the
 * change at once by applying the same op to its own copy, then adopts the list
 * the owner wrote. While ops are in flight, storage echoes are held back: they
 * may be older than the panel's copy. When the last op settles, the panel takes
 * the owner's list, or re-reads storage if a write failed or another writer's
 * change arrived meanwhile.
 *
 * Ops leave one at a time, each after the previous one's reply, so the owner
 * applies a tab's ops in the order the user made them even if the transport
 * would deliver two messages out of order. The panel is already showing them,
 * so the wait is not visible.
 */
import type { PromptItem } from '@/core/types/sync';
import {
  type PromptLibraryOp,
  type PromptLibraryResult,
  applyPromptLibraryOp,
} from '@/features/prompt/library/promptLibraryOwner';

import { isPinned } from './promptPinning';

export interface PromptDraft {
  name: string;
  text: string;
  tags: string[];
}

/** `failed`: the library was not changed and the panel shows it as stored. */
export type PromptAddOutcome = 'added' | 'duplicate' | 'failed';
export type PromptEditOutcome = 'saved' | 'duplicate' | 'missing' | 'failed';

export interface PromptLibraryStateDeps {
  /** The stored library, or an empty one. */
  read: () => Promise<PromptItem[]>;
  /** Sends an op to the library's owner. */
  apply: (op: PromptLibraryOp) => Promise<PromptLibraryResult>;
  /** The library this page once kept in localStorage, as stored there. */
  readLegacy?: () => string | null;
  /**
   * The panel's copy changed after the fact: `changed` when another writer's
   * change came in, `failed` when a write failed and the stored library is shown.
   */
  onReconcile?: (reason: 'changed' | 'failed') => void;
  /** One or more changes were not saved and the panel was rolled back; called once per settle. */
  onWriteFailed?: () => void;
  now?: () => number;
  makeId?: () => string;
}

export interface PromptLibraryState {
  readonly items: PromptItem[];
  /**
   * Reads the library, first copying in a legacy localStorage one through the
   * owner, which stores it only if no library is stored yet.
   */
  load(): Promise<PromptItem[]>;
  /** Adds a prompt ahead of the library unless its text is already there. */
  add(draft: PromptDraft): Promise<PromptAddOutcome>;
  /** Changes a prompt in place unless another prompt has the same text. */
  edit(id: string, draft: PromptDraft): Promise<PromptEditOutcome>;
  /** Resolves true once the owner has removed it, false if the delete failed. */
  remove(id: string): Promise<boolean>;
  togglePin(id: string): void;
  /** Takes the order a drag or key move produced. */
  reorder(next: PromptItem[]): void;
  /**
   * A `storage.onChanged` value for the library. Returns true when it differs
   * from the panel's copy and was adopted; the panel's own writes echo back
   * equal and are ignored.
   */
  receive(newValue: unknown): boolean;
}

/** How Prompt Manager tells two prompt bodies apart: trimmed, ignoring case. */
function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const sameList = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A new prompt's id: an FNV-1a-ish hash over the time and a random part. */
function promptId(): string {
  const seed = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** A legacy localStorage value worth seeding: a list of prompt records. */
export function parseLegacyPromptLibrary(raw: string | null): unknown[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))
      ? value
      : null;
  } catch {
    return null;
  }
}

export function createPromptLibraryState(deps: PromptLibraryStateDeps): PromptLibraryState {
  const now = deps.now ?? Date.now;
  const makeId = deps.makeId ?? promptId;
  let items: PromptItem[] = [];

  let issued = 0;
  let pending = 0;
  /** The owner's list from the newest op that succeeded since the last settle. */
  let newest: { seq: number; items: PromptItem[] } | null = null;
  let failed = false;
  /** The reply to the last op sent; the next op leaves after it. */
  let lastReply: Promise<unknown> = Promise.resolve();
  /** The last storage echo held back while ops were in flight. */
  let heldEcho: unknown[] | null = null;

  const adopt = (next: PromptItem[], reason: 'changed' | 'failed'): void => {
    if (sameList(next, items)) return;
    items = next;
    deps.onReconcile?.(reason);
  };

  const settle = async (): Promise<void> => {
    const epoch = issued;
    const result = newest;
    const reason = failed ? 'failed' : 'changed';
    const mustRead = failed || !result || (heldEcho !== null && !sameList(heldEcho, result.items));
    newest = null;
    failed = false;
    heldEcho = null;
    if (reason === 'failed') deps.onWriteFailed?.();
    if (!mustRead) {
      adopt(result.items, reason);
      return;
    }
    let stored: PromptItem[];
    try {
      stored = await deps.read();
    } catch {
      // The extension was reloaded or storage failed; keep what is shown.
      return;
    }
    // An op sent meanwhile settles again and reconciles then.
    if (issued === epoch && pending === 0) adopt(stored, reason);
  };

  /** Shows `op` at once, then sends it. Resolves after the panel is reconciled. */
  const send = async (op: PromptLibraryOp): Promise<PromptLibraryResult | null> => {
    // Every timestamp travels in the op; the time argument only serves imports.
    const optimistic = applyPromptLibraryOp(items, op, Date.now()).items;
    if (optimistic) items = optimistic as PromptItem[];
    const seq = ++issued;
    pending += 1;
    let result: PromptLibraryResult | null = null;
    const reply = lastReply.then(() => deps.apply(op));
    lastReply = reply.catch(() => undefined);
    try {
      result = await reply;
      if (!newest || seq > newest.seq) newest = { seq, items: result.items as PromptItem[] };
    } catch {
      failed = true;
    } finally {
      pending -= 1;
    }
    if (pending === 0) await settle();
    return result;
  };

  return {
    get items() {
      return items;
    },
    async load() {
      const legacy = parseLegacyPromptLibrary(deps.readLegacy?.() ?? null);
      // Unseeded, the library loads as stored; the next start tries again.
      if (legacy) await deps.apply({ kind: 'seed', items: legacy }).catch(() => undefined);
      items = await deps.read();
      return items;
    },
    async add(draft) {
      if (items.some((x) => sameText(x.text, draft.text))) return 'duplicate';
      const item: PromptItem = {
        id: makeId(),
        name: draft.name,
        text: draft.text,
        tags: draft.tags,
        createdAt: now(),
      };
      const result = await send({ kind: 'add', items: [item] });
      if (!result) return 'failed';
      // Another tab may have taken the same text or name first.
      return result.added > 0 ? 'added' : 'duplicate';
    },
    async edit(id, draft) {
      if (items.some((x) => x.id !== id && sameText(x.text, draft.text))) return 'duplicate';
      if (!items.some((x) => x.id === id)) return 'missing';
      const changes = { text: draft.text, tags: draft.tags, name: draft.name, updatedAt: now() };
      const result = await send({ kind: 'update', id, changes });
      if (!result) return 'failed';
      // Another tab may have deleted it meanwhile.
      return result.items.some((item) => (item as PromptItem | null)?.id === id)
        ? 'saved'
        : 'missing';
    },
    async remove(id) {
      return (await send({ kind: 'delete', id })) !== null;
    },
    togglePin(id) {
      const item = items.find((x) => x.id === id);
      if (!item) return;
      // The pin bumps updatedAt so the cloud merge carries it; see promptPinning.ts.
      const at = now();
      void send({
        kind: 'update',
        id,
        changes: isPinned(item)
          ? { pinnedAt: null, updatedAt: at }
          : { pinnedAt: at, updatedAt: at },
      });
    },
    reorder(next) {
      void send({ kind: 'reorder', ids: next.map((item) => item.id) });
    },
    receive(newValue) {
      if (!Array.isArray(newValue)) return false;
      if (pending > 0) {
        heldEcho = newValue;
        return false;
      }
      if (sameList(newValue, items)) return false;
      items = newValue;
      return true;
    },
  };
}

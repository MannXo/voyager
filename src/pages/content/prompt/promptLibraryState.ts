/**
 * Prompt Manager's copy of the prompt library (`gvPromptItems`) and every
 * change the panel makes to it. The panel renders `items` and calls these
 * methods; it never writes the library itself.
 */
import type { PromptItem } from '@/core/types/sync';

import { togglePin } from './promptPinning';

export interface PromptDraft {
  name: string;
  text: string;
  tags: string[];
}

export type PromptAddOutcome = 'added' | 'duplicate';
export type PromptEditOutcome = 'saved' | 'duplicate' | 'missing';

export interface PromptLibraryStateDeps {
  /** The stored library, or an empty one. */
  read: () => Promise<PromptItem[]>;
  write: (items: PromptItem[]) => Promise<void>;
  now?: () => number;
  makeId?: () => string;
}

export interface PromptLibraryState {
  readonly items: PromptItem[];
  load(): Promise<PromptItem[]>;
  /** Adds a prompt ahead of the library unless its text is already there. */
  add(draft: PromptDraft): Promise<PromptAddOutcome>;
  /** Changes a prompt in place unless another prompt has the same text. */
  edit(id: string, draft: PromptDraft): Promise<PromptEditOutcome>;
  remove(id: string): void;
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

export function createPromptLibraryState(deps: PromptLibraryStateDeps): PromptLibraryState {
  const now = deps.now ?? Date.now;
  const makeId = deps.makeId ?? (() => `${now()}`);
  let items: PromptItem[] = [];

  return {
    get items() {
      return items;
    },
    async load() {
      items = await deps.read();
      return items;
    },
    async add(draft) {
      if (items.some((x) => sameText(x.text, draft.text))) return 'duplicate';
      const it: PromptItem = {
        id: makeId(),
        name: draft.name,
        text: draft.text,
        tags: draft.tags,
        createdAt: now(),
      };
      items = [it, ...items];
      await deps.write(items);
      return 'added';
    },
    async edit(id, draft) {
      if (items.some((x) => x.id !== id && sameText(x.text, draft.text))) return 'duplicate';
      const target = items.find((x) => x.id === id);
      if (!target) return 'missing';
      target.text = draft.text;
      target.tags = draft.tags;
      target.name = draft.name;
      target.updatedAt = now();
      await deps.write(items);
      return 'saved';
    },
    remove(id) {
      items = items.filter((x) => x.id !== id);
      void deps.write(items);
    },
    togglePin(id) {
      items = togglePin(items, id, now());
      void deps.write(items);
    },
    reorder(next) {
      items = next;
      void deps.write(items);
    },
    receive(newValue) {
      if (!Array.isArray(newValue) || JSON.stringify(newValue) === JSON.stringify(items)) {
        return false;
      }
      items = newValue;
      return true;
    },
  };
}

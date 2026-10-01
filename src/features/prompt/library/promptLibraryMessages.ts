/**
 * Message boundary between prompt-library writers (content scripts, the
 * popup) and the background owner. Writers read the library straight from
 * storage and send every change here as an op.
 */
import type { PromptItem } from '@/features/backup/types/backup';

import type {
  PromptChanges,
  PromptLibraryOp,
  PromptLibraryOwner,
  PromptLibraryResult,
} from './promptLibraryOwner';

export const PROMPT_LIBRARY_APPLY_MESSAGE = 'gv.promptLibrary.apply';

/** Far above any real library; it only bounds what one message can carry. */
const MAX_OP_ITEMS = 10_000;

export interface PromptLibraryApplyRequest {
  type: typeof PROMPT_LIBRARY_APPLY_MESSAGE;
  op: PromptLibraryOp;
}

export type PromptLibraryApplyResponse =
  | { ok: true; result: PromptLibraryResult }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** A prompt as the library stores it, rebuilt from its known fields only. */
function parsePromptItem(value: unknown): PromptItem | null {
  if (!isRecord(value)) return null;
  const { id, text, tags, createdAt, updatedAt, name, pinnedAt } = value;
  if (typeof id !== 'string' || !id || typeof text !== 'string' || !text.trim()) return null;
  if (!isStringList(tags) || !isFiniteNumber(createdAt)) return null;
  if (updatedAt !== undefined && !isFiniteNumber(updatedAt)) return null;
  if (pinnedAt !== undefined && !isFiniteNumber(pinnedAt)) return null;
  if (name !== undefined && typeof name !== 'string') return null;
  const item: PromptItem = { id, text, tags, createdAt };
  if (updatedAt !== undefined) item.updatedAt = updatedAt;
  if (name !== undefined) item.name = name;
  if (pinnedAt !== undefined) item.pinnedAt = pinnedAt;
  return item;
}

function parseItems(value: unknown): PromptItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OP_ITEMS) return null;
  const items = value.map(parsePromptItem);
  return items.every((item): item is PromptItem => item !== null) ? items : null;
}

function parseChanges(value: unknown): PromptChanges | null {
  if (!isRecord(value)) return null;
  const { name, text, tags, pinnedAt, updatedAt } = value;
  const changes: PromptChanges = {};
  if (name !== undefined) {
    if (typeof name !== 'string') return null;
    changes.name = name;
  }
  if (text !== undefined) {
    if (typeof text !== 'string' || !text.trim()) return null;
    changes.text = text;
  }
  if (tags !== undefined) {
    if (!isStringList(tags)) return null;
    changes.tags = tags;
  }
  if (pinnedAt !== undefined) {
    if (pinnedAt !== null && !isFiniteNumber(pinnedAt)) return null;
    changes.pinnedAt = pinnedAt;
  }
  if (updatedAt !== undefined) {
    if (!isFiniteNumber(updatedAt)) return null;
    changes.updatedAt = updatedAt;
  }
  return changes;
}

export function parsePromptLibraryOp(value: unknown): PromptLibraryOp | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'add':
    case 'import': {
      const items = parseItems(value.items);
      return items ? { kind: value.kind, items } : null;
    }
    case 'update': {
      const changes = parseChanges(value.changes);
      return typeof value.id === 'string' && changes
        ? { kind: 'update', id: value.id, changes }
        : null;
    }
    case 'delete':
      return typeof value.id === 'string' ? { kind: 'delete', id: value.id } : null;
    case 'reorder':
      return isStringList(value.ids) && value.ids.length <= MAX_OP_ITEMS
        ? { kind: 'reorder', ids: value.ids }
        : null;
    default:
      return null;
  }
}

export function isPromptLibraryApplyMessage(message: unknown): boolean {
  return isRecord(message) && message.type === PROMPT_LIBRARY_APPLY_MESSAGE;
}

/** Background side: validate the op and apply it through the owner. */
export async function handlePromptLibraryApplyMessage(
  message: unknown,
  owner: PromptLibraryOwner,
): Promise<PromptLibraryApplyResponse> {
  const op = isRecord(message) ? parsePromptLibraryOp(message.op) : null;
  if (!op) return { ok: false, error: 'invalid_op' };
  try {
    return { ok: true, result: await owner.apply(op) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isResult(value: unknown): value is PromptLibraryResult {
  return (
    isRecord(value) &&
    isFiniteNumber(value.added) &&
    isFiniteNumber(value.skipped) &&
    isFiniteNumber(value.total) &&
    isFiniteNumber(value.nameConflicts)
  );
}

/** Writer side: send an op to the background owner and read its result. */
export function createPromptLibraryClient(
  send: (request: PromptLibraryApplyRequest) => Promise<unknown>,
): { apply: (op: PromptLibraryOp) => Promise<PromptLibraryResult> } {
  return {
    async apply(op) {
      const response = await send({ type: PROMPT_LIBRARY_APPLY_MESSAGE, op });
      if (!isRecord(response) || response.ok !== true || !isResult(response.result)) {
        const error =
          isRecord(response) && typeof response.error === 'string' ? response.error : '';
        throw new Error(`Prompt library update failed${error ? `: ${error}` : ''}`);
      }
      return response.result;
    },
  };
}

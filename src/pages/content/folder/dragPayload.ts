import type { ConversationReference } from '@/core/types/folder';

import type { DragData } from './types';

/**
 * One validated reader for Voyager folder drag data.
 *
 * Any page can start a drag that carries `application/json`, so a drop target
 * must not trust the payload shape. The parser rebuilds a fresh object field
 * by field: unknown keys (including `__proto__`) are dropped, structural fields
 * are type-checked, and a payload whose shape no drop site can use is
 * rejected. It stays host-neutral so every folder surface can share it.
 */

export const VOYAGER_DRAG_MIME = 'application/json';

export interface DragPayloadOptions {
  /**
   * Opt-in plain-URL fallback (AI Studio). Gemini drop sites stay JSON-only:
   * its drag ids come from `jslog` (`c_<hex>`) while URLs carry `/app/<hex>`,
   * so a URL-derived id would duplicate an existing reference.
   */
  conversationIdFromUrl?: (url: string) => string | null;
  /** Origin used to resolve a root-relative dropped URL. Defaults to `location.origin`. */
  origin?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Accept http(s) URLs and same-origin relative paths. Reject other schemes
 * (`javascript:`, `data:` ...) and protocol-relative URLs. The URL parser
 * strips tabs/newlines and leading spaces, so check a copy without them.
 */
export function isAllowedConversationUrl(url: string): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = url.replace(/[\u0000- ]/g, '');
  if (/^[\\/]{2}/.test(compact)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return true;
  const name = scheme[1].toLowerCase();
  return name === 'http' || name === 'https';
}

function parseConversationReference(value: unknown): ConversationReference | null {
  if (!isRecord(value) || !isNonEmptyString(value.conversationId)) return null;
  const url = value.url ?? '';
  if (typeof url !== 'string' || !isAllowedConversationUrl(url)) return null;

  const reference: ConversationReference = {
    conversationId: value.conversationId,
    title: typeof value.title === 'string' ? value.title : '',
    url,
    addedAt: isFiniteNumber(value.addedAt) ? value.addedAt : 0,
  };
  if (isFiniteNumber(value.lastOpenedAt)) reference.lastOpenedAt = value.lastOpenedAt;
  if (isFiniteNumber(value.lastTurnAt)) reference.lastTurnAt = value.lastTurnAt;
  if (isFiniteNumber(value.updatedAt)) reference.updatedAt = value.updatedAt;
  if (typeof value.isGem === 'boolean') reference.isGem = value.isGem;
  if (typeof value.gemId === 'string') reference.gemId = value.gemId;
  if (typeof value.starred === 'boolean') reference.starred = value.starred;
  if (typeof value.customTitle === 'boolean') reference.customTitle = value.customTitle;
  if (isFiniteNumber(value.sortIndex)) reference.sortIndex = value.sortIndex;
  return reference;
}

/** Validate an already-decoded payload object. */
export function parseDragPayloadObject(value: unknown): DragData | null {
  if (!isRecord(value)) return null;
  const { type } = value;
  if (type !== undefined && type !== 'conversation' && type !== 'folder') return null;
  const title = typeof value.title === 'string' ? value.title : '';

  if (type === 'folder') {
    if (!isNonEmptyString(value.folderId)) return null;
    return { type: 'folder', folderId: value.folderId, title };
  }

  const payload: DragData = { title };
  if (type) payload.type = type;

  if (value.sourceFolderId !== undefined) {
    if (!isNonEmptyString(value.sourceFolderId)) return null;
    payload.sourceFolderId = value.sourceFolderId;
  }

  if (value.conversations !== undefined) {
    if (!Array.isArray(value.conversations)) return null;
    const conversations: ConversationReference[] = [];
    for (const item of value.conversations) {
      const reference = parseConversationReference(item);
      if (!reference) return null;
      conversations.push(reference);
    }
    payload.conversations = conversations;
  }

  if (value.conversationId !== undefined) {
    if (!isNonEmptyString(value.conversationId)) return null;
    payload.conversationId = value.conversationId;
  }

  if (value.url !== undefined) {
    if (typeof value.url !== 'string' || !isAllowedConversationUrl(value.url)) return null;
    payload.url = value.url;
  }
  if (typeof value.isGem === 'boolean') payload.isGem = value.isGem;
  if (typeof value.gemId === 'string') payload.gemId = value.gemId;

  const hasConversations = (payload.conversations?.length ?? 0) > 0;
  if (!hasConversations && !payload.conversationId) return null;
  return payload;
}

function normalizeDroppedUrl(raw: string, origin: string): string | null {
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine) return null;
  if (/^https?:\/\//i.test(firstLine)) return firstLine;
  // Root-relative paths are prefixed with the page origin, so they stay same-origin.
  if (firstLine.startsWith('/')) return `${origin}${firstLine}`;
  return null;
}

function resolveOrigin(options: DragPayloadOptions): string {
  if (options.origin !== undefined) return options.origin;
  try {
    return location.origin;
  } catch {
    return '';
  }
}

/**
 * Parse one drag string. JSON is tried first; when `conversationIdFromUrl` is
 * given, a URL line (text/uri-list, text/x-moz-url, URL) becomes a
 * conversation payload with an empty title.
 */
export function parseDragPayload(
  raw: string | null | undefined,
  options: DragPayloadOptions = {},
): DragData | null {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;

  try {
    const parsed = parseDragPayloadObject(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch {}

  if (!options.conversationIdFromUrl) return null;
  const url = normalizeDroppedUrl(trimmed, resolveOrigin(options));
  if (!url) return null;
  const conversationId = options.conversationIdFromUrl(url);
  if (!isNonEmptyString(conversationId)) return null;
  return { type: 'conversation', conversationId, title: '', url };
}

/** Read the Voyager JSON payload from a drop event's DataTransfer (JSON only). */
export function readDragPayload(transfer: DataTransfer | null | undefined): DragData | null {
  if (!transfer) return null;
  let raw = '';
  try {
    raw = transfer.getData(VOYAGER_DRAG_MIME);
  } catch {
    return null;
  }
  return parseDragPayload(raw);
}

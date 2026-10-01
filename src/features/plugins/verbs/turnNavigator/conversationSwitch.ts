/**
 * What the navigator does with the turns on screen when the route's
 * conversation id changes.
 *
 * SPA hosts change the URL and the thread DOM in separate steps. When the URL
 * moves first, the old conversation's turns are still mounted at the first
 * refresh under the new id; merging them would file the old prompts into the
 * new conversation for good (grow-only markers never drop them), and let them
 * be starred under its id. Those turns are therefore held back as STALE until
 * they leave the DOM or their text changes.
 *
 * One switch is not a different conversation: a new chat (a path-hash id)
 * gaining its stable id once the host has created it. The same turns stay on
 * screen, and stars made on the draft must follow it. That switch is
 * provisional: stars stay under the draft id and the markers stay put until
 * the turns have survived `REKEY_SETTLE_MS` unchanged, and only then move to
 * the new id. If the draft's turns give way to others first, it was a
 * navigation after all and they become stale like any other.
 *
 * Pure bookkeeping: the navigator passes markers and a text reader in, and
 * applies the returned step.
 */
import { hashString } from '@/core/utils/hash';

import { MAX_REGEX_INPUT_LENGTH } from '../../sites/safeRegex';
import { type Marker } from './turnMerge';

/** How long a draft's turns must survive a new stable id to count as the same chat. */
export const REKEY_SETTLE_MS = 1_500;

export interface SwitchInput {
  /** Conversation id the URL names now. */
  readonly routeId: string;
  /** Conversation id the markers and stars belong to ('' before the first refresh). */
  readonly currentId: string;
  readonly markers: readonly Marker[];
  /** Turns mounted now, in DOM order. */
  readonly turns: readonly HTMLElement[];
  readonly readText: (element: HTMLElement) => string;
  readonly now: number;
}

export interface SwitchStep {
  /** Drop the markers: the turns now on screen belong to another conversation. */
  readonly reset: boolean;
  /** Stars to move once a draft is confirmed under its stable id. */
  readonly migrate?: { readonly from: string; readonly to: string; readonly hashes: string[] };
  /** Refresh again after this long to settle a provisional switch. */
  readonly recheckInMs?: number;
}

interface PendingRekey {
  readonly from: string;
  readonly to: string;
  /** The draft's mounted prompts, in order, when the stable id appeared. */
  readonly prompts: readonly string[];
  readonly settleAt: number;
}

/** `<siteId>:conv:<id>` from the site's route pattern, else a hash of the path. */
export function buildConversationId(
  config: { readonly siteId: string; readonly conversationIdPattern?: string },
  input: string = location.href,
): string {
  try {
    const url = new URL(input, location.origin);
    if (config.conversationIdPattern) {
      // The pattern policy (sites/safeRegex.ts) forbids the constructs that
      // backtrack catastrophically; a bounded subject caps the rest.
      const subject = url.pathname.slice(0, MAX_REGEX_INPUT_LENGTH);
      const match = new RegExp(config.conversationIdPattern).exec(subject);
      if (match?.[1]) return `${config.siteId}:conv:${match[1]}`;
    }
    return `${config.siteId}:${hashString(`${url.origin}${url.pathname}`)}`;
  } catch {
    return `${config.siteId}:${hashString(String(input || ''))}`;
  }
}

/** A pattern-derived id (`<site>:conv:<id>`), as opposed to a path hash. */
export function isStableConversationId(id: string): boolean {
  return id.includes(':conv:');
}

export class ConversationSwitch {
  private readonly stale = new Map<HTMLElement, string>();
  private pending: PendingRekey | null = null;

  /** The id stars are read and written under: the draft's while a re-key is unconfirmed. */
  namespace(routeId: string): string {
    return this.pending?.to === routeId ? this.pending.from : routeId;
  }

  /** Whether a mounted turn is a leftover of the previous conversation. */
  isStale(element: HTMLElement, readText: (element: HTMLElement) => string): boolean {
    const text = this.stale.get(element);
    if (text === undefined) return false;
    if (element.isConnected && readText(element) === text) return true;
    this.stale.delete(element);
    return false;
  }

  update(input: SwitchInput): SwitchStep {
    const { routeId, currentId, markers, turns, readText, now } = input;
    const pending = this.pending;
    if (pending?.to === routeId) {
      const mounted = turns.filter((turn) => !this.isStale(turn, readText)).map(readText);
      // An empty thread is a host mid-render, not yet evidence either way.
      if (mounted.length === 0) return { reset: false, recheckInMs: REKEY_SETTLE_MS };
      if (!pending.prompts.every((prompt, index) => mounted[index] === prompt)) {
        this.pending = null;
        this.holdBack(markers, readText);
        return { reset: true };
      }
      if (now < pending.settleAt) return { reset: false, recheckInMs: pending.settleAt - now };
      this.pending = null;
      return {
        reset: false,
        migrate: { from: pending.from, to: pending.to, hashes: markers.map((m) => m.hash) },
      };
    }
    this.pending = null;
    if (!currentId || routeId === currentId) return { reset: false };

    const carried = markers.filter(
      (marker) => marker.element.isConnected && readText(marker.element) === marker.summary,
    );
    if (
      carried.length > 0 &&
      !isStableConversationId(currentId) &&
      isStableConversationId(routeId)
    ) {
      this.pending = {
        from: currentId,
        to: routeId,
        prompts: carried.map((marker) => marker.summary),
        settleAt: now + REKEY_SETTLE_MS,
      };
      return { reset: false, recheckInMs: REKEY_SETTLE_MS };
    }
    this.holdBack(carried, readText);
    return { reset: true };
  }

  private holdBack(markers: readonly Marker[], readText: (element: HTMLElement) => string): void {
    for (const marker of markers) {
      if (marker.element.isConnected) this.stale.set(marker.element, readText(marker.element));
    }
  }
}

/**
 * Which conversation each turn on screen belongs to, from DOM evidence only.
 *
 * Hosts change the URL and the thread DOM in separate steps, in either
 * order, so the URL at a press does not say whose turn was pressed. A turn
 * instead gets an owner when it is first seen, and keeps it:
 *   - While the current route has not yet shown a turn of its own (just
 *     after a route change), new turns are the current conversation's.
 *   - Once it has, a new turn is its own only with continuity: in keyed mode
 *     another of its turns is still on screen, or a turn with the same text
 *     vanished in the previous refresh (the host renamed it). Otherwise the
 *     new turn is unattributed and cannot be starred, which is how a thread
 *     swapped in under the old URL is kept out of it.
 *   - In merge mode (no host key) a far scroll replaces every mounted
 *     element, so continuity is not required once the route owns a turn.
 *     Before that, a new element is unattributed while another
 *     conversation's turn is on screen, or when every new element repeats a
 *     text seen under the previous conversation (its thread remounting).
 * A turn first seen on a new chat (no id) is owned by null; it may be
 * starred under the id the chat later gets, which then owns it.
 *
 * Host keys are remembered in a bounded map; elements in a WeakMap.
 */
import { hashString } from '@/core/utils/hash';

import type { Marker, MountedTurn } from './turnMerge';

/** A turn on screen: the host's key for it, else its element, and its text hash if known. */
export interface ObservedTurn {
  readonly token: string | object;
  readonly hash: string | null;
}

const UNATTRIBUTED = Symbol('unattributed');
export type TurnOwner = string | null | typeof UNATTRIBUTED;

const MAX_REMEMBERED_KEYS = 2_000;

export class TurnOwnership {
  private readonly byKey = new Map<string, TurnOwner>();
  private readonly byElement = new WeakMap<object, TurnOwner>();
  /** Star id of the current route; undefined before the first route. */
  private routeId: string | null | undefined;
  private previousRouteId: string | null = null;
  /** The current route has shown a turn it owns. */
  private routeOwnsTurn = false;
  private routeHashes = new Set<string>();
  private previousRouteHashes = new Set<string>();
  private lastSeen: readonly ObservedTurn[] = [];

  constructor(private readonly keyed: () => boolean) {}

  ownerOf(token: string | object): TurnOwner | undefined {
    return typeof token === 'string' ? this.byKey.get(token) : this.byElement.get(token);
  }

  /** Whether a turn may be starred under `conversationId`. */
  allows(token: string | object, conversationId: string): boolean {
    const owner = this.ownerOf(token);
    return owner === conversationId || owner === null;
  }

  /** A new chat's turn starred under the id the chat was given now belongs to it. */
  adopt(token: string | object, conversationId: string): void {
    if (this.ownerOf(token) === null) this.assign(token, conversationId);
  }

  enterRoute(conversationId: string | null): void {
    if (this.routeId !== undefined) {
      this.previousRouteId = this.routeId;
      this.previousRouteHashes = this.routeHashes;
    }
    this.routeId = conversationId;
    this.routeHashes = new Set();
    this.routeOwnsTurn = false;
  }

  observe(turns: readonly ObservedTurn[]): void {
    const current = this.routeId ?? null;
    const fresh = turns.filter((turn) => this.ownerOf(turn.token) === undefined);
    if (fresh.length) {
      if (this.keyed()) this.attributeKeyed(fresh, turns, current);
      else this.attributeMounted(fresh, turns, current);
    }
    if (current !== null && turns.some((turn) => this.ownerOf(turn.token) === current)) {
      this.routeOwnsTurn = true;
    }
    for (const turn of turns) {
      if (turn.hash !== null) this.routeHashes.add(turn.hash);
      // Keep keys on screen the most recent, so only off-screen ones are evicted.
      if (typeof turn.token === 'string') this.touch(turn.token);
    }
    while (this.byKey.size > MAX_REMEMBERED_KEYS + turns.length) {
      const oldest = this.byKey.keys().next().value;
      if (oldest === undefined) break;
      this.byKey.delete(oldest);
    }
    this.lastSeen = turns;
  }

  private attributeKeyed(
    fresh: readonly ObservedTurn[],
    turns: readonly ObservedTurn[],
    current: string | null,
  ): void {
    if (!this.routeOwnsTurn) {
      for (const turn of fresh) this.assign(turn.token, current);
      return;
    }
    // A renamed turn: same text, its old key gone since the previous refresh.
    const onScreen = new Set(turns.map((turn) => turn.token));
    const vanished = new Map<string, TurnOwner[]>();
    for (const turn of this.lastSeen) {
      const owner = this.ownerOf(turn.token);
      if (turn.hash === null || onScreen.has(turn.token) || owner === undefined) continue;
      vanished.set(turn.hash, [...(vanished.get(turn.hash) ?? []), owner]);
    }
    for (const turn of fresh) {
      const owner = turn.hash === null ? undefined : vanished.get(turn.hash)?.shift();
      if (owner !== undefined) this.assign(turn.token, owner);
    }
    const grew = turns.some((turn) => this.ownerOf(turn.token) === current);
    for (const turn of fresh) {
      if (this.ownerOf(turn.token) === undefined) {
        this.assign(turn.token, grew ? current : UNATTRIBUTED);
      }
    }
  }

  private attributeMounted(
    fresh: readonly ObservedTurn[],
    turns: readonly ObservedTurn[],
    current: string | null,
  ): void {
    let owner: TurnOwner = current;
    if (!this.routeOwnsTurn) {
      const foreign = turns.some((turn) => {
        const seen = this.ownerOf(turn.token);
        return typeof seen === 'string' && seen !== current;
      });
      // A new chat's thread re-renders under its id: that is not a replay.
      const replayed =
        this.previousRouteId !== null &&
        fresh.every((turn) => turn.hash !== null && this.previousRouteHashes.has(turn.hash));
      if (foreign || replayed) owner = UNATTRIBUTED;
    }
    for (const turn of fresh) this.assign(turn.token, owner);
  }

  private assign(token: string | object, owner: TurnOwner): void {
    if (typeof token === 'string') this.byKey.set(token, owner);
    else this.byElement.set(token, owner);
  }

  private touch(key: string): void {
    const owner = this.byKey.get(key);
    if (owner === undefined) return;
    this.byKey.delete(key);
    this.byKey.set(key, owner);
  }
}

/** What ownership is recorded for: the host key in snapshot mode, else the element. */
export function turnToken(marker: Marker): string | object {
  return marker.key ?? marker.element;
}

/**
 * Snapshot mode: every turn, plus every other turn item on screen. An item
 * whose message was never seen is still owned, so a turn of the previous
 * conversation that first mounts after the URL changed is not taken as new.
 */
export function snapshotOwnershipTurns(
  markers: readonly Marker[],
  itemKeys: readonly string[],
): ObservedTurn[] {
  const turns: ObservedTurn[] = markers.map((marker) => ({
    token: turnToken(marker),
    hash: marker.hash,
  }));
  const keyed = new Set(markers.map((marker) => marker.key));
  for (const key of itemKeys) if (!keyed.has(key)) turns.push({ token: key, hash: null });
  return turns;
}

export function mountedOwnershipTurns(mounted: readonly MountedTurn[]): ObservedTurn[] {
  return mounted.map((turn) => ({ token: turn.element, hash: hashString(turn.summary) }));
}

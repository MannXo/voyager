/**
 * Which conversation each turn on screen belongs to, for star writes.
 *
 * A turn belongs to the conversation the URL named when the turn entered the
 * page: a MutationObserver stamps every inserted node with the URL's id at
 * that moment, before any debounced refresh, and a turn takes the latest
 * stamp on itself or its ancestors (in keyed mode, on its list item, so a
 * message mounting later inside an old item keeps the item's owner). This is
 * proof only on hosts that change the URL before they render the next
 * conversation, which ChatGPT, Claude and DeepSeek were measured to do: a
 * host that renders B while the URL still names A gives B's turns to A.
 *
 * Nothing else grants ownership. Further rules only withhold it (the turn is
 * then unattributed and cannot be starred):
 *   - A new chat's turns (no id in the URL) are never starrable, not even
 *     under the id the chat later gets.
 *   - A turn inserted while another conversation's turn, or an unattributed
 *     one, is still on screen (connected and not under a hidden ancestor).
 *   - Keyed mode: items inserted after the route showed its own turns, when
 *     none of them are still on screen. The host keeps every item mounted, so
 *     that is another thread replacing it rather than a scroll.
 *   - Merge mode: before the route showed its own turns, new elements whose
 *     texts all appeared under the previous conversation (its thread
 *     remounting).
 * A turn keeps the owner it was first seen with. Host keys are remembered in
 * a bounded map; elements in a WeakMap.
 */
import { hashString } from '@/core/utils/hash';

import type { Marker, MountedTurn } from './turnMerge';
import { renderedCheck } from './turnVisibility';

/** A turn on screen: the host's key for it, else its element; where it sits; its text hash if known. */
export interface ObservedTurn {
  readonly token: string | object;
  /** The turn's list item in keyed mode, else the turn's element. */
  readonly element: Node;
  readonly hash: string | null;
}

const UNATTRIBUTED = Symbol('unattributed');
export type TurnOwner = string | null | typeof UNATTRIBUTED;

const MAX_REMEMBERED_KEYS = 2_000;

interface Insertion {
  readonly seq: number;
  readonly owner: TurnOwner;
}

export class TurnOwnership {
  private readonly byKey = new Map<string, TurnOwner>();
  private readonly byElement = new WeakMap<object, TurnOwner>();
  private readonly insertions = new WeakMap<Node, Insertion>();
  private seq = 0;
  /** Owner of turns already on the page when recording began. */
  private initialOwner: TurnOwner = UNATTRIBUTED;
  /** Star id of the route the last refresh saw; undefined before the first. */
  private routeId: string | null | undefined;
  /** That route has shown a turn it owns. */
  private routeShown = false;
  private previousRouteId: string | null = null;
  private routeHashes = new Set<string>();
  private previousRouteHashes = new Set<string>();
  /** The turns the last refresh saw. */
  private tracked: readonly ObservedTurn[] = [];

  constructor(
    private readonly keyed: () => boolean,
    private readonly currentId: () => string | null,
  ) {}

  ownerOf(token: string | object): TurnOwner | undefined {
    return typeof token === 'string' ? this.byKey.get(token) : this.byElement.get(token);
  }

  /** Whether a turn may be starred under `conversationId`. */
  allows(token: string | object, conversationId: string): boolean {
    return this.ownerOf(token) === conversationId;
  }

  /** Turns on the page now belong to the URL now; call before recording insertions. */
  begin(): void {
    this.initialOwner = this.currentId();
  }

  /** Stamp nodes that just entered the page with the conversation the URL names now. */
  recordInsertions(nodes: readonly Node[]): void {
    const elements = nodes.filter((node) => node.nodeType === Node.ELEMENT_NODE);
    if (!elements.length) return;
    const insertion: Insertion = { seq: ++this.seq, owner: this.insertionOwner() };
    for (const element of elements) this.insertions.set(element, insertion);
  }

  enterRoute(conversationId: string | null): void {
    if (this.routeId !== undefined) {
      this.previousRouteId = this.routeId;
      this.previousRouteHashes = this.routeHashes;
    }
    this.routeId = conversationId;
    this.routeHashes = new Set();
    this.routeShown = false;
  }

  observe(turns: readonly ObservedTurn[]): void {
    const current = this.routeId ?? null;
    const fresh = turns.filter((turn) => this.ownerOf(turn.token) === undefined);
    const replayed =
      !this.keyed() &&
      !this.routeShown &&
      this.previousRouteId !== null &&
      fresh.length > 0 &&
      fresh.every((turn) => turn.hash !== null && this.previousRouteHashes.has(turn.hash));
    for (const turn of fresh) {
      const owner = this.insertedUnder(turn.element);
      this.assign(turn.token, replayed && owner === current ? UNATTRIBUTED : owner);
    }
    if (current !== null && turns.some((turn) => this.ownerOf(turn.token) === current)) {
      this.routeShown = true;
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
    this.tracked = turns;
  }

  /** Owner for nodes inserted now. */
  private insertionOwner(): TurnOwner {
    const current = this.currentId();
    let ownOnScreen = false;
    const isRendered = renderedCheck();
    for (const turn of this.tracked) {
      // A thread the host hid (ChatGPT keeps earlier ones as display: none) is off screen.
      if (!(turn.element instanceof Element) || !isRendered(turn.element)) continue;
      const owner = this.ownerOf(turn.token);
      if (owner === current) ownOnScreen = true;
      else if (owner !== null && owner !== undefined) return UNATTRIBUTED;
    }
    const shown = this.routeId === current && this.routeShown;
    if (this.keyed() && shown && !ownOnScreen) return UNATTRIBUTED;
    return current;
  }

  /** The owner stamped by the latest insertion that brought `element` into the page. */
  private insertedUnder(element: Node): TurnOwner {
    let latest: Insertion | undefined;
    for (let node: Node | null = element; node; node = node.parentNode) {
      const insertion = this.insertions.get(node);
      if (insertion && (!latest || insertion.seq > latest.seq)) latest = insertion;
    }
    return latest ? latest.owner : this.initialOwner;
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
 * Snapshot mode: every turn, plus every other turn item on screen, each with
 * its list item. An item whose message was never seen is still owned, so a
 * turn of the previous conversation that first mounts after the URL changed
 * keeps its item's owner.
 */
export function snapshotOwnershipTurns(
  markers: readonly Marker[],
  items: ReadonlyMap<string, HTMLElement>,
): ObservedTurn[] {
  const turns: ObservedTurn[] = markers.map((marker) => ({
    token: turnToken(marker),
    element: (marker.key ? items.get(marker.key) : undefined) ?? marker.element,
    hash: marker.hash,
  }));
  const keyed = new Set(markers.map((marker) => marker.key));
  for (const [key, element] of items) {
    if (!keyed.has(key)) turns.push({ token: key, element, hash: null });
  }
  return turns;
}

export function mountedOwnershipTurns(mounted: readonly MountedTurn[]): ObservedTurn[] {
  return mounted.map((turn) => ({
    token: turn.element,
    element: turn.element,
    hash: hashString(turn.summary),
  }));
}

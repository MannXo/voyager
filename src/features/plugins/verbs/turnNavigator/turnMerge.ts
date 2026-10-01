/**
 * Stitch the currently mounted turns into the accumulated marker list.
 *
 * Virtualized hosts (Claude, DeepSeek, ChatGPT) mount only a window of the
 * conversation, so the DOM is never the full conversation. Markers are
 * therefore ACCUMULATED across refreshes (ids keyed by content hash, not mount
 * index) and stitched into order via turns shared between overlapping windows.
 * Known turns are NEVER dropped: virtualization can mount sparse,
 * non-contiguous windows mid-transition, so a missing turn only means "not
 * mounted right now", not "deleted" — mirroring the Gemini timeline's
 * grow-only behaviour.
 *
 * Pure apart from stamping `data-gv-turn-id` on the turns it files; the
 * navigator owns the marker list and passes it in.
 *
 * A host whose virtual list keeps a per-turn attribute on each item (ChatGPT's
 * `data-turn-id-container`) can name it as `turnKey`. The key then tells
 * repeated prompts apart and folds a turn the host briefly renders twice into
 * one marker, instead of leaving a phantom `~2` dot behind.
 */
import { hashString } from '@/core/utils/hash';

export const TURN_ID_ATTR = 'data-gv-turn-id';

export interface Marker {
  id: string;
  hash: string;
  summary: string;
  starred: boolean;
  starredAt?: number;
  /** Last-seen element; disconnected once the host virtualizes the turn out. */
  element: HTMLElement;
  /** Last-known center offset within the scroll target; reused while unmounted. */
  center: number;
  dotElement: HTMLButtonElement | null;
  /** The host's own id for the turn, when the navigator has a `turnKey`. */
  key?: string;
}

export interface MountedTurn {
  readonly element: HTMLElement;
  readonly summary: string;
}

interface KeyedTurn extends MountedTurn {
  readonly key?: string;
}

interface MountedEntry extends KeyedTurn {
  readonly hash: string;
  readonly center: number;
}

export function buildTurnId(text: string): string {
  return `c-${hashString(text)}`;
}

function claimTurnId(hash: string, usedIds: Set<string>): string {
  const base = `c-${hash}`;
  let id = base;
  for (let n = 2; usedIds.has(id); n++) id = `${base}~${n}`;
  usedIds.add(id);
  return id;
}

/**
 * Read each turn's key from the nearest element carrying `attribute`, then
 * fold copies of one turn. An element that owns several turns is a list
 * wrapper (ChatGPT's `*-root` bookkeeping containers carry the same attribute),
 * so its value is not a turn key. Two different elements with one value are a
 * transient duplicate render: keep the copy already filed, else the first.
 */
function keyTurns(turns: readonly MountedTurn[], attribute: string | undefined): KeyedTurn[] {
  if (!attribute) return [...turns];
  const owners = turns.map((turn) => {
    try {
      return turn.element.closest<HTMLElement>(`[${attribute}]`);
    } catch {
      return null;
    }
  });
  const turnsPerOwner = new Map<HTMLElement, number>();
  for (const owner of owners) {
    if (owner) turnsPerOwner.set(owner, (turnsPerOwner.get(owner) ?? 0) + 1);
  }
  const keyed: KeyedTurn[] = turns.map((turn, index) => {
    const owner = owners[index];
    const key = owner && turnsPerOwner.get(owner) === 1 ? owner.getAttribute(attribute) : null;
    return key ? { ...turn, key } : turn;
  });
  const keptByKey = new Map<string, number>();
  const dropped = new Set<number>();
  keyed.forEach((turn, index) => {
    if (!turn.key) return;
    const kept = keptByKey.get(turn.key);
    if (kept === undefined) {
      keptByKey.set(turn.key, index);
    } else if (
      !keyed[kept].element.hasAttribute(TURN_ID_ATTR) &&
      turn.element.hasAttribute(TURN_ID_ATTR)
    ) {
      dropped.add(kept);
      keptByKey.set(turn.key, index);
    } else {
      dropped.add(index);
    }
  });
  return keyed.filter((_, index) => !dropped.has(index));
}

/**
 * For each mounted turn, the index of the known marker it is, or -1 for a new
 * turn. Matches keep conversation order (indexes only grow).
 *
 * Repeated prompts ("continue", "yes") share a hash, so the first same-hash
 * marker is not necessarily the right one: with `[hi, x, hi]` known and only
 * the last `hi` mounted, first-match would re-point marker 0 at the third turn.
 * A turn is therefore matched, in order of certainty, by
 *   1. the id stamped on its element (it stayed mounted since we filed it),
 *      even if the host has since renamed its key;
 *   2. its host key;
 *   3. a hash only one known marker carries;
 *   4. among same-hash markers, the one whose remembered centre is nearest,
 *      never past the next certain match so later anchors keep their order.
 * Outside a stamp match, a marker whose key differs from the turn's is never
 * a candidate.
 */
function matchKnownMarkers(known: readonly Marker[], mounted: readonly MountedEntry[]): number[] {
  const hashCount = new Map<string, number>();
  const firstByHash = new Map<string, number>();
  const indexById = new Map<string, number>();
  const indexByKey = new Map<string, number>();
  known.forEach((marker, index) => {
    hashCount.set(marker.hash, (hashCount.get(marker.hash) ?? 0) + 1);
    if (!firstByHash.has(marker.hash)) firstByHash.set(marker.hash, index);
    indexById.set(marker.id, index);
    if (marker.key) indexByKey.set(marker.key, index);
  });

  const sameTurnText = (index: number | undefined, entry: MountedEntry, from: number): boolean =>
    index !== undefined && index >= from && known[index].hash === entry.hash;
  const isCandidate = (index: number | undefined, entry: MountedEntry, from: number): boolean =>
    sameTurnText(index, entry, from) &&
    (!known[index!].key || !entry.key || known[index!].key === entry.key);

  const certainMatch = (entry: MountedEntry, from: number): number => {
    const stamped = entry.element.getAttribute(TURN_ID_ATTR);
    const byStamp = stamped === null ? undefined : indexById.get(stamped);
    if (sameTurnText(byStamp, entry, from)) return byStamp!;
    const byKey = entry.key ? indexByKey.get(entry.key) : undefined;
    if (isCandidate(byKey, entry, from)) return byKey!;
    if (hashCount.get(entry.hash) === 1) {
      const only = firstByHash.get(entry.hash);
      if (isCandidate(only, entry, from)) return only!;
    }
    return -1;
  };

  const matched = new Array<number>(mounted.length).fill(-1);
  let from = 0;
  for (let i = 0; i < mounted.length; i++) {
    const entry = mounted[i];
    let match = certainMatch(entry, from);
    if (match === -1 && (hashCount.get(entry.hash) ?? 0) > 1) {
      let bound = known.length;
      for (let k = i + 1; k < mounted.length; k++) {
        const next = certainMatch(mounted[k], from);
        if (next !== -1) {
          bound = next;
          break;
        }
      }
      let bestDistance = Infinity;
      for (let j = from; j < bound; j++) {
        if (!isCandidate(j, entry, from)) continue;
        const distance = Math.abs(known[j].center - entry.center);
        if (distance < bestDistance) {
          bestDistance = distance;
          match = j;
        }
      }
    }
    if (match !== -1) {
      matched[i] = match;
      from = match + 1;
    }
  }
  return matched;
}

export function mergeMountedTurns(
  known: Marker[],
  turns: readonly MountedTurn[],
  centerOf: (element: HTMLElement) => number,
  turnKey?: string,
): Marker[] {
  const mounted: MountedEntry[] = keyTurns(turns, turnKey).map((turn) => ({
    ...turn,
    hash: hashString(turn.summary),
    center: centerOf(turn.element),
  }));
  if (!mounted.length) return known;

  const matchedKnownIndex = matchKnownMarkers(known, mounted);

  const usedIds = new Set(known.map((marker) => marker.id));
  const createMarker = (entry: MountedEntry): Marker => {
    const id = claimTurnId(entry.hash, usedIds);
    entry.element.setAttribute(TURN_ID_ATTR, id);
    return {
      id,
      hash: entry.hash,
      summary: entry.summary,
      starred: false,
      element: entry.element,
      center: entry.center,
      dotElement: null,
      ...(entry.key ? { key: entry.key } : {}),
    };
  };

  const firstMatch = matchedKnownIndex.findIndex((index) => index >= 0);
  if (firstMatch === -1) {
    // Jumped into an unexplored region: place the whole block by its
    // vertical position relative to the accumulated turns.
    const fresh = mounted.map(createMarker);
    const insertAt = known.findIndex((marker) => marker.center > fresh[0].center);
    return insertAt === -1
      ? [...known, ...fresh]
      : [...known.slice(0, insertAt), ...fresh, ...known.slice(insertAt)];
  }

  const beforeFirstAnchor: Marker[] = [];
  const afterKnownIndex = new Map<number, Marker[]>();
  // Fresh centre minus remembered centre per anchor: how far the host's
  // re-measuring has shifted this region since the neighbours were seen.
  const anchorDrift = new Map<number, number>();
  let lastAnchor = -1;
  for (let i = 0; i < mounted.length; i++) {
    const knownIndex = matchedKnownIndex[i];
    if (knownIndex >= 0) {
      const survivor = known[knownIndex];
      anchorDrift.set(knownIndex, mounted[i].center - survivor.center);
      survivor.element = mounted[i].element;
      survivor.summary = mounted[i].summary;
      // The host may rename a turn (a client id becoming the server's).
      survivor.key = mounted[i].key ?? survivor.key;
      mounted[i].element.setAttribute(TURN_ID_ATTR, survivor.id);
      lastAnchor = knownIndex;
      continue;
    }
    const marker = createMarker(mounted[i]);
    if (lastAnchor === -1) {
      beforeFirstAnchor.push(marker);
    } else {
      const bucket = afterKnownIndex.get(lastAnchor);
      if (bucket) bucket.push(marker);
      else afterKnownIndex.set(lastAnchor, [marker]);
    }
  }

  // Anchors fix the order of the turns they match; a block of new turns is
  // then filed by scroll position among the known turns between its two
  // bounding anchors. "Right next to the anchor" is not enough: Claude keeps
  // the latest turn mounted while the reader sits at the top, and that lone
  // tail anchor would drag the conversation's opening turns behind the
  // bottom window. Known centres are compared after the nearest anchor's
  // drift so re-measured content does not skew the comparison.
  const anchors = matchedKnownIndex.filter((index) => index >= 0);
  const insertBefore = new Map<number, Marker[]>();
  // A known turn between two anchors is assumed to have drifted like the
  // anchor nearer to it; anchors on different sides of a re-measured region
  // can carry very different drifts.
  const driftAt = (index: number, prev: number | undefined, next: number | undefined): number => {
    const prevDrift = prev === undefined ? undefined : anchorDrift.get(prev);
    const nextDrift = next === undefined ? undefined : anchorDrift.get(next);
    if (prevDrift === undefined) return nextDrift ?? 0;
    if (nextDrift === undefined) return prevDrift;
    return index - prev! <= next! - index ? prevDrift : nextDrift;
  };
  const file = (block: Marker[], prev: number | undefined, next: number | undefined): void => {
    if (!block.length) return;
    const lo = prev === undefined ? 0 : prev + 1;
    const hi = next ?? known.length;
    let at = hi;
    for (let index = lo; index < hi; index++) {
      if (known[index].center + driftAt(index, prev, next) > block[0].center) {
        at = index;
        break;
      }
    }
    const bucket = insertBefore.get(at);
    if (bucket) bucket.push(...block);
    else insertBefore.set(at, block);
  };
  file(beforeFirstAnchor, undefined, anchors[0]);
  anchors.forEach((anchor, rank) => {
    const block = afterKnownIndex.get(anchor);
    if (block) file(block, anchor, anchors[rank + 1]);
  });

  const result: Marker[] = [];
  known.forEach((marker, index) => {
    const block = insertBefore.get(index);
    if (block) result.push(...block);
    result.push(marker);
  });
  const tail = insertBefore.get(known.length);
  if (tail) result.push(...tail);
  return result;
}

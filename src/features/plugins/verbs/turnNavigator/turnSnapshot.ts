/**
 * Snapshot mode, for hosts whose virtual list keeps one item per turn mounted
 * and only unloads the message inside it (ChatGPT's `[data-turn-id-container]`
 * items; see `chatgptCollectTurnContainers` in the ChatGPT export adapter).
 * The site names that item attribute as the `turnKey` param.
 *
 * The rail is rebuilt from the items in the DOM on every refresh, with no
 * history. Whatever thread is on screen is what the rail shows, so the order
 * in which the host changes the URL and the DOM cannot leave one
 * conversation's turns on another's rail. An item whose message is unloaded
 * keeps its label from a cache keyed by the host's turn id; that id is unique
 * across conversations, so the cache needs no conversation.
 */
import { hashString } from '@/core/utils/hash';

import { type Marker, TURN_ID_ATTR, TurnIds } from './turnMerge';

/** Labels kept for unloaded items; the oldest are dropped first. */
const MAX_REMEMBERED_LABELS = 2_000;

export interface SnapshotTurn {
  /** The mounted message, else its item. */
  readonly element: HTMLElement;
  readonly summary: string;
  /** The mounted message, which carries the turn-id stamp; null while unloaded. */
  readonly content: HTMLElement | null;
  /** The host's id for the turn, when it sits in its own list item. */
  readonly key: string | null;
}

export class TurnSnapshot {
  private readonly labels = new Map<string, string>();
  /** Every turn item at the last `collect`, labelled or not, by key. */
  items: ReadonlyMap<string, HTMLElement> = new Map();

  constructor(
    private readonly turnSelector: string,
    private readonly keyAttribute: string,
  ) {}

  /** The user turns in list order: mounted ones, and unloaded items whose label is known. */
  collect(root: ParentNode, readText: (element: HTMLElement) => string): SnapshotTurn[] {
    const keyed = `[${this.keyAttribute}]`;
    let nodes: HTMLElement[];
    try {
      nodes = Array.from(root.querySelectorAll<HTMLElement>(`${this.turnSelector}, ${keyed}`));
    } catch {
      return [];
    }
    const turns: SnapshotTurn[] = [];
    const items = new Map<string, HTMLElement>();
    const indexByKey = new Map<string, number>();
    const add = (turn: SnapshotTurn): void => {
      const { key } = turn;
      const seen = key === null ? undefined : indexByKey.get(key);
      // ChatGPT can briefly keep two items with one id: the first sets the
      // position, the copy with a mounted message supplies it.
      if (seen !== undefined) {
        if (!turns[seen].content && turn.content) turns[seen] = turn;
        return;
      }
      if (key !== null) indexByKey.set(key, turns.length);
      turns.push(turn);
    };
    for (const node of nodes) {
      if (node.matches(this.turnSelector)) {
        const owner = node.closest<HTMLElement>(keyed);
        const key = owner && this.isTurnItem(owner) ? this.keyOf(owner) : null;
        if (owner && key !== null) items.set(key, owner);
        const summary = readText(node);
        if (key !== null) this.remember(key, summary);
        add({ element: node, summary, content: node, key });
        continue;
      }
      // An item with its message unloaded: a user turn only if we saw it as one.
      const key = this.keyOf(node);
      if (key === null || node.querySelector(this.turnSelector) || !this.isTurnItem(node)) continue;
      items.set(key, node);
      const summary = this.labels.get(key);
      if (summary !== undefined) add({ element: node, summary, content: null, key });
    }
    this.items = items;
    return turns;
  }

  /** A list wrapper (`*-root`) holds other items or several turns; its id is not a turn's. */
  private isTurnItem(item: HTMLElement): boolean {
    return (
      !item.querySelector(`[${this.keyAttribute}]`) &&
      item.querySelectorAll(this.turnSelector).length <= 1
    );
  }

  private keyOf(item: HTMLElement): string | null {
    return item.getAttribute(this.keyAttribute)?.trim() || null;
  }

  private remember(key: string, summary: string): void {
    this.labels.delete(key);
    this.labels.set(key, summary);
    if (this.labels.size > MAX_REMEMBERED_LABELS) {
      const oldest = this.labels.keys().next().value;
      if (oldest !== undefined) this.labels.delete(oldest);
    }
  }
}

/**
 * Markers for a snapshot. Ids follow from the text and its order among
 * repeats (`c-<hash>`, `c-<hash>~2`), so they are stable across refreshes; a
 * marker from the previous snapshot with the same id is reused, keeping its dot.
 */
export function snapshotMarkers(
  previous: readonly Marker[],
  turns: readonly SnapshotTurn[],
  centerOf: (element: HTMLElement) => number,
): Marker[] {
  const byId = new Map(previous.map((marker) => [marker.id, marker]));
  const turnIds = new TurnIds();
  return turns.map((turn) => {
    const hash = hashString(turn.summary);
    const id = turnIds.claim(hash);
    turn.content?.setAttribute(TURN_ID_ATTR, id);
    const center = centerOf(turn.element);
    const marker = byId.get(id);
    if (!marker) {
      return {
        id,
        hash,
        summary: turn.summary,
        starred: false,
        element: turn.element,
        center,
        dotElement: null,
        placeholder: !turn.content,
        key: turn.key,
      };
    }
    marker.placeholder = !turn.content;
    marker.key = turn.key;
    marker.element = turn.element;
    marker.summary = turn.summary;
    marker.center = center;
    return marker;
  });
}

/**
 * The navigator's starred messages: which turns of the current conversation
 * are starred, and the guarded writes that star or unstar one.
 *
 * Stars are read for the conversation the URL names at the moment of the
 * read. A write needs more than the URL, because hosts change the URL and the
 * thread DOM in separate steps: the turns on screen right after a route change
 * may still be the previous conversation's. So a write is refused
 *   - before a refresh has seen the current route (`observe`), and
 *   - while any turn that was on screen under the previous conversation is
 *     still on screen. A new chat gaining its id is exempt: it had no
 *     conversation to come from, and the turns are its own.
 * When the DOM changes first, a refresh under the old route sees every turn
 * replaced at once; the turns from before that swap are the old
 * conversation's, and the new ones may be starred once the URL follows. Only
 * host turn keys show that: list items stay mounted for the whole thread, so
 * a disjoint set is another thread. Mounted elements are replaced by any far
 * scroll on a virtualized host, so there a swap proves nothing.
 * Each press takes its target, conversation and URL before any await, and is
 * dropped if the route changed by the time the stars it toggles have loaded.
 */
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';

import { extractTurnHash, StarSnapshotLoader } from './starSnapshot';

export interface StarTarget {
  readonly id: string;
  readonly hash: string;
  readonly summary: string;
}

interface StarEntry {
  readonly turnId: string;
  readonly starredAt: number;
}

interface StarSources {
  /** Conversation id of the current route, stable or not. */
  readonly routeId: () => string;
  /** Id stars are filed under for the current route, or null where starring is off. */
  readonly starId: () => string | null;
  readonly alive: () => boolean;
  /** Whether the turns on screen are host turn keys (snapshot mode). */
  readonly keyedTurns: () => boolean;
}

export class NavigatorStars {
  private byHash = new Map<string, StarEntry>();
  /** Conversation of the latest read, settled or not. */
  private requestedFor: string | null | undefined;
  /** Conversation whose read `byHash` holds. */
  private loadedFor: string | null | undefined;
  private read: Promise<void> = Promise.resolve();
  private readonly snapshots = new StarSnapshotLoader();

  private observedRoute: string | null = null;
  private observedStarId: string | null = null;
  /** Turns on screen at the last refresh that found any: host turn keys or elements. */
  private lastSeen: ReadonlySet<unknown> = new Set();
  /** Under the observed route, the turns seen before every turn was replaced. */
  private beforeSwap: ReadonlySet<unknown> | null = null;
  /** The previous conversation's turns; starring waits until none is on screen. */
  private carried: ReadonlySet<unknown> | null = null;
  private generation = 0;

  constructor(private readonly sources: StarSources) {}

  get(hash: string): StarEntry | undefined {
    return this.byHash.get(hash);
  }

  /** Read the stars of the conversation the URL names now; joins a read already under way. */
  load(force = false): Promise<void> {
    const conversationId = this.sources.starId();
    if (!force && conversationId === this.requestedFor) return this.read;
    this.requestedFor = conversationId;
    const isCurrent = this.snapshots.begin(
      () => this.sources.alive() && this.sources.starId() === conversationId,
    );
    this.read = (async () => {
      const messages = conversationId
        ? await StarredMessagesService.getStarredMessagesForConversation(conversationId)
        : [];
      if (!isCurrent()) return;
      this.byHash = new Map(
        messages.map((message) => [
          extractTurnHash(message.turnId),
          { turnId: message.turnId, starredAt: message.starredAt },
        ]),
      );
      this.loadedFor = conversationId;
    })();
    return this.read;
  }

  /**
   * Record the route and the turns a refresh found on screen. Returns true
   * when the route changed since the previous refresh.
   */
  observe(onScreen: ReadonlySet<unknown>): boolean {
    const routeId = this.sources.routeId();
    const changed = this.observedRoute !== null && routeId !== this.observedRoute;
    if (changed) {
      this.generation += 1;
      this.carried = this.observedStarId === null ? null : (this.beforeSwap ?? this.lastSeen);
      this.beforeSwap = null;
    } else if (
      this.sources.keyedTurns() &&
      onScreen.size &&
      this.lastSeen.size &&
      !overlaps(this.lastSeen, onScreen)
    ) {
      this.beforeSwap = this.lastSeen;
    }
    if (this.carried && !overlaps(this.carried, onScreen)) this.carried = null;
    this.observedRoute = routeId;
    this.observedStarId = this.sources.starId();
    if (onScreen.size) this.lastSeen = onScreen;
    return changed;
  }

  /** Whether a star written now is backed by what is on screen. */
  canStar(): boolean {
    return (
      this.sources.starId() !== null &&
      this.sources.routeId() === this.observedRoute &&
      this.carried === null
    );
  }

  /**
   * Star or unstar `target` in the current conversation. Resolves true when
   * a write was made, false when the press was refused or dropped.
   */
  async toggle(
    target: StarTarget,
    describe: () => { readonly url: string; readonly title: string },
  ): Promise<boolean> {
    // Everything the write needs is fixed before the first await.
    const { id, hash, summary } = target;
    const conversationId = this.sources.starId();
    if (!conversationId || !this.canStar()) return false;
    const generation = this.generation;
    const { url, title } = describe();
    if (this.loadedFor !== conversationId) {
      await this.load();
      if (
        !this.sources.alive() ||
        this.generation !== generation ||
        this.sources.starId() !== conversationId ||
        this.loadedFor !== conversationId
      ) {
        return false;
      }
    }
    const existing = this.byHash.get(hash);
    if (existing) {
      this.byHash.delete(hash);
      // Remove by the stored id, which may still be in the legacy format.
      await StarredMessagesService.removeStarredMessage(conversationId, existing.turnId);
      return true;
    }
    const starredAt = Date.now();
    this.byHash.set(hash, { turnId: id, starredAt });
    await StarredMessagesService.addStarredMessage({
      turnId: id,
      content: summary,
      conversationId,
      conversationUrl: url,
      conversationTitle: title,
      starredAt,
    });
    return true;
  }
}

function overlaps(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

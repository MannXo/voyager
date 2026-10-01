/**
 * The navigator's starred messages: which turns of the current conversation
 * are starred, and the guarded writes that star or unstar one.
 *
 * Stars are read for the conversation the URL names at the moment of the
 * read. A write needs more than the URL, because hosts change the URL and the
 * thread DOM in separate steps. A write is refused
 *   - before a refresh has seen the current route (`observe`), and
 *   - for a turn that did not enter the page under the current conversation
 *     (`turnOwnership.ts`).
 * Each press takes its target, conversation and URL before any await, and is
 * dropped if the route changed by the time the stars it toggles have loaded.
 */
import { StarredMessagesService } from '@/pages/content/timeline/StarredMessagesService';

import { extractTurnHash, StarSnapshotLoader } from './starSnapshot';
import { type ObservedTurn, TurnOwnership } from './turnOwnership';

export interface StarTarget {
  readonly id: string;
  readonly hash: string;
  readonly summary: string;
  /** The turn's host key, else its element: what ownership was recorded for. */
  readonly token: string | object;
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
  private generation = 0;
  private readonly owners: TurnOwnership;

  constructor(private readonly sources: StarSources) {
    this.owners = new TurnOwnership(sources.keyedTurns, sources.starId);
  }

  /** Turns on the page now belong to the URL now; call before `recordInsertions`. */
  begin(): void {
    this.owners.begin();
  }

  /** Stamp what a mutation batch inserted with the conversation the URL names now. */
  recordInsertions(records: readonly MutationRecord[]): void {
    this.owners.recordInsertions(records.flatMap((record) => Array.from(record.addedNodes)));
  }

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
  observe(turns: readonly ObservedTurn[]): boolean {
    const routeId = this.sources.routeId();
    const changed = this.observedRoute !== null && routeId !== this.observedRoute;
    if (changed) this.generation += 1;
    if (routeId !== this.observedRoute) this.owners.enterRoute(this.sources.starId());
    this.observedRoute = routeId;
    this.owners.observe(turns);
    return changed;
  }

  /** Whether a star written now on this turn is backed by what is on screen. */
  canStar(token: string | object): boolean {
    const conversationId = this.sources.starId();
    return (
      conversationId !== null &&
      this.sources.routeId() === this.observedRoute &&
      this.owners.allows(token, conversationId)
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
    const { id, hash, summary, token } = target;
    const conversationId = this.sources.starId();
    if (!conversationId || !this.canStar(token)) return false;
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

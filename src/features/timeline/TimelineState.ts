import { StarredMessagesService } from '@/features/savedLibrary/StarredMessagesService';
import type { StarredMessage, StarredMessagesData } from '@/features/savedLibrary/starTypes';
import { findMatchingStarredMessages } from '@/pages/content/timeline/starredLookup';
import { resolveStarredDisplay } from '@/pages/content/timeline/starredResolution';

import { TimelineHierarchy } from './TimelineHierarchy';
import { TimelineHydration } from './TimelineHydration';
import type { TimelineStoragePolicy } from './TimelineStoragePolicy';
import type { TimelineMarker } from './types';

/** Conversation-scoped stars and hierarchy. Rendering never writes storage. */
export class TimelineState {
  readonly conversationId: string;
  readonly hierarchy: TimelineHierarchy;
  markers: TimelineMarker[] = [];
  readonly markerMap = new Map<string, TimelineMarker>();
  private destroyed = false;
  private starred = new Set<string>();
  private starWrites: Promise<void> = Promise.resolve();
  private starSnapshotRevision = 0;
  private pendingStarChoices = new Map<string, { starred: boolean }>();
  private readonly starHydration = new TimelineHydration(() => this.isCurrent);
  private readonly hierarchyHydration = new TimelineHydration(() => this.isCurrent);
  private starDisplayOverride = new Map<string, boolean>();
  private starStorageIdsByMarkerId = new Map<string, string[]>();
  private onStorage: ((e: StorageEvent) => void) | null = null;
  private onChromeStorageChanged:
    | ((changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void)
    | null = null;
  constructor(
    private readonly onChange: () => void,
    readonly policy: TimelineStoragePolicy,
  ) {
    this.conversationId = policy.conversationId;
    this.hierarchy = new TimelineHierarchy(
      policy,
      onChange,
      (id) => this.canEdit(id),
      this.hierarchyHydration,
    );
  }
  private get url(): string {
    return this.policy.url;
  }
  private get isCurrent(): boolean {
    return !this.destroyed && this.policy.isCurrent();
  }
  private canEdit(id: string): boolean {
    return this.policy.canEdit(this.markerMap.get(id), id);
  }
  private initPromise: Promise<void> | null = null;
  init(): Promise<void> {
    return (this.initPromise ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    if (!this.isCurrent) return;
    this.listen();
    // Outline readiness is independent of an unrelated Saved Library request.
    const hierarchyRead = this.hierarchy.init();
    await Promise.all([hierarchyRead, this.readStars()]);
  }
  replaceMarkers(markers: TimelineMarker[]): void {
    this.markers = markers;
    this.markerMap.clear();
    for (const marker of markers) this.markerMap.set(marker.id, marker);
    this.recomputeStarredDisplay();
    for (const marker of markers) marker.starred = this.isMarkerStarred(marker.id);
  }
  private listen(): void {
    if ('localKey' in this.policy.hierarchy) {
      this.onStorage = (event) => {
        if (!this.isCurrent || event.storageArea !== localStorage) return;
        if (
          'localKey' in this.policy.hierarchy &&
          (event.key === null || event.key === this.policy.hierarchy.localKey)
        ) {
          this.hierarchy.loadLocalHierarchy();
          this.onChange();
        }
      };
      window.addEventListener('storage', this.onStorage);
    }

    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      this.onChromeStorageChanged = (changes, areaName) => {
        if (areaName === 'local' && this.isCurrent) {
          const starredData = StarredMessagesService.decodeStorageChange(areaName, changes);
          if (starredData) {
            this.applySharedStarredData(starredData);
          }

          this.hierarchy.applyStorageChanges(changes);
        }
      };
      chrome.storage.onChanged.addListener(this.onChromeStorageChanged);
    }
  }
  destroy(): void {
    this.destroyed = true;
    this.hierarchy.destroy();
    if (this.onStorage) window.removeEventListener('storage', this.onStorage);
    if (this.onChromeStorageChanged)
      chrome.storage.onChanged.removeListener(this.onChromeStorageChanged);
  }

  /**
   * Recompute which mounted turn each stored star belongs to. Cheap enough to
   * run on every star/marker change; never touches storage.
   */
  private recomputeStarredDisplay(): void {
    const { displayByMarkerId, storageIdsByMarkerId } = resolveStarredDisplay({
      markers: this.markers.flatMap((marker) => {
        const id = this.policy.resolveMountedTurnId(marker.id);
        return id ? [{ id }] : [];
      }),
      starredIds: this.starred,
      resolveCanonicalId: this.policy.resolveStoredTurnId,
    });
    this.starDisplayOverride.clear();
    this.starStorageIdsByMarkerId.clear();
    for (const marker of this.markers) {
      const canonical = this.policy.resolveMountedTurnId(marker.id);
      this.starDisplayOverride.set(
        marker.id,
        (canonical &&
          (this.pendingStarChoices.get(canonical)?.starred ?? displayByMarkerId.get(canonical))) ||
          false,
      );
      const storageIds = canonical ? storageIdsByMarkerId.get(canonical) : undefined;
      if (storageIds) this.starStorageIdsByMarkerId.set(marker.id, storageIds);
    }
  }

  isMarkerStarred(markerId: string): boolean {
    const override = this.starDisplayOverride.get(markerId);
    if (override !== undefined) return override;
    return this.starred.has(markerId);
  }

  private getStarStorageIds(markerId: string): string[] {
    return this.starStorageIdsByMarkerId.get(markerId) ?? [markerId];
  }

  /** Recompute star ownership and repaint every marker to match. */
  refreshStars(): void {
    this.recomputeStarredDisplay();
    for (const marker of this.markers) {
      const want = this.isMarkerStarred(marker.id);
      if (marker.starred !== want) {
        marker.starred = want;
      }
    }
    this.onChange();
  }

  private applyStarredIdSet(nextSet: Set<string>): void {
    this.starred = new Set(nextSet);
    this.refreshStars();
  }

  private applySharedStarredData(data: StarredMessagesData): void {
    if (!this.conversationId) return;
    this.starHydration.snapshot(() => {
      this.starSnapshotRevision += 1;
      const matched = this.matchLibrary(data);
      this.applyStarredIdSet(new Set(matched.messages.map((message) => message.turnId)));
    });
  }

  private matchLibrary(data: StarredMessagesData): {
    messages: StarredMessage[];
    sourceConversationIds: string[];
  } {
    return this.policy.stars.matchLegacyConversations
      ? findMatchingStarredMessages(data, this.conversationId, this.url)
      : {
          messages: data.messages[this.conversationId] ?? [],
          sourceConversationIds: [this.conversationId],
        };
  }
  private readStars(): Promise<void> {
    return this.starHydration.read((accept) => this.syncStarredFromService(accept));
  }
  private async syncStarredFromService(accept: (apply: () => void) => boolean): Promise<void> {
    if (!this.conversationId) {
      accept(() => {});
      return;
    }
    try {
      const data = this.policy.stars.matchLegacyConversations
        ? await StarredMessagesService.getAllStarredMessages()
        : {
            messages: {
              [this.conversationId]: await StarredMessagesService.getStarredMessagesForConversation(
                this.conversationId,
              ),
            },
          };
      if (!this.isCurrent) return;
      const matched = this.matchLibrary(data);

      let messages = matched.messages;
      const needsReconcile = matched.sourceConversationIds.some(
        (sourceConversationId) => sourceConversationId !== this.conversationId,
      );

      if (needsReconcile) {
        const reconciled = await StarredMessagesService.reconcileConversationIds(
          this.conversationId,
          matched.sourceConversationIds,
          this.url,
        );
        if (!this.isCurrent) return;
        messages = reconciled;
      }

      accept(() => {
        this.starSnapshotRevision += 1;
        this.applyStarredIdSet(new Set(messages.map((message) => message.turnId)));
      });
    } catch (error) {
      console.warn('[Timeline] Failed to sync starred messages from shared storage:', error);
    }
  }

  async toggleStar(turnId: string): Promise<void> {
    const id = String(turnId || '');
    if (!id) return;
    // A mounted `u-N` is only the current DOM-window index. Even when a cache
    // exists, it is not evidence that this node is full-conversation turn N.
    if (!this.isCurrent || !this.canEdit(id)) return;

    const marker = this.markerMap.get(id);
    // A press captures its message before an initial read can yield to a route or DOM change.
    const summary = marker?.summary;
    const conversationTitle = this.policy.getConversationTitle(this.markers);
    // Resolve from the header at the press, before hydration or queued writes can yield to another page.
    const accountRead =
      !this.starHydration.ready || !this.isMarkerStarred(id)
        ? this.policy.stars.resolveAccount().then(
            (account) => ({ account }),
            (error: unknown) => ({ error }),
          )
        : null;
    if (!this.starHydration.ready) await this.readStars();
    if (!this.isCurrent || !this.policy.canEdit(marker, id) || !this.starHydration.ready) return;
    this.starHydration.changed();
    const wasStarred = this.isMarkerStarred(id);
    // A stable marker may represent both its current server-id record and an
    // older verified positional alias. Removing the star clears both records.
    const storageIds = wasStarred ? this.getStarStorageIds(id) : [id];

    const canonical = this.policy.resolveMountedTurnId(id) ?? id;
    const choice = { starred: !wasStarred };
    const snapshotRevision = this.starSnapshotRevision;
    this.pendingStarChoices.set(canonical, choice);
    // The next press must see this choice before the Library write settles.
    if (wasStarred) storageIds.forEach((storageId) => this.starred.delete(storageId));
    else this.starred.add(id);
    this.refreshStars();

    // Account lookups must not reorder rapid add/remove presses.
    const operation = this.starWrites.then(async () => {
      try {
        if (!this.isCurrent || !this.policy.canEdit(marker, id) || !this.starHydration.ready)
          return;
        if (wasStarred) {
          await Promise.all(
            storageIds.map((storageId) =>
              StarredMessagesService.removeStarredMessage(this.conversationId, storageId),
            ),
          );
        } else if (marker) {
          const result = await accountRead;
          if (!result) return;
          if ('error' in result) throw result.error;
          const account = result.account;
          if (!this.isCurrent || !this.policy.canEdit(marker, id) || !this.starHydration.ready)
            return;
          const message: StarredMessage = {
            turnId: id,
            content: summary ?? '',
            conversationId: this.conversationId,
            conversationUrl: this.url,
            conversationTitle,
            starredAt: Date.now(),
            ...(account ? { account } : {}),
          };
          await StarredMessagesService.addStarredMessage(message);
        }
        const libraryStarred = Array.from(this.starred).some(
          (storedId) => this.policy.resolveStoredTurnId(storedId) === canonical,
        );
        if (
          this.pendingStarChoices.get(canonical) === choice &&
          snapshotRevision !== this.starSnapshotRevision &&
          libraryStarred !== choice.starred
        ) {
          // Confirm a superseded optimistic choice from the owner, never replay it over a newer snapshot.
          this.starHydration.invalidate();
          await this.starHydration.read((accept) => this.syncStarredFromService(accept));
        }
      } catch (error) {
        if (!this.isCurrent) return;
        if (this.pendingStarChoices.get(canonical) === choice)
          this.pendingStarChoices.delete(canonical);
        // A failed write must repaint from the Library, including partially removed aliases.
        this.starHydration.invalidate();
        await this.starHydration.read((accept) => this.syncStarredFromService(accept));
        console.warn('[Timeline] Failed to change starred message:', error);
      } finally {
        if (this.pendingStarChoices.get(canonical) === choice)
          this.pendingStarChoices.delete(canonical);
        if (this.isCurrent) {
          this.refreshStars();
        }
      }
    });
    this.starWrites = operation.catch(() => {});
    await operation;

    if (this.isCurrent) this.refreshStars();
  }

  /**
   * Resolve which mounted marker currently carries a stored star. Used by
   * `#gv-turn-<id>` deep links, whose ids come from storage and may have been
   * relocated onto a different index.
   */
  resolveMarkerIdForStorageId(storageId: string): string | null {
    for (const [markerId, ids] of this.starStorageIdsByMarkerId) {
      if (ids.includes(storageId)) return markerId;
    }
    const canonical = this.policy.resolveStoredTurnId(storageId);
    if (!canonical) return null;
    return (
      this.markers.find((marker) => this.policy.resolveMountedTurnId(marker.id) === canonical)
        ?.id ?? canonical
    );
  }

  getStoredTurnIdAliases(turnId: string): string[] {
    return this.policy.getStoredTurnIdAliases(turnId);
  }
}

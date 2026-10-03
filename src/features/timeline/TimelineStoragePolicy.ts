import type { AccountScope } from '@/core/services/AccountIsolationService';

import type { TimelineMarker } from './types';

/** Captured site storage/identity facts; the engine owns all mutable timeline state. */
export interface TimelineStoragePolicy {
  readonly conversationId: string;
  readonly url: string;
  readonly settingsPrefix: string;
  readonly stars: {
    readonly key: string | null;
    readonly legacyKeys: readonly string[];
    readonly copyLegacy: boolean;
    readonly source: 'library' | 'local';
    readonly libraryMirror: boolean;
    readonly matchLegacyConversations: boolean;
  };
  readonly hierarchy:
    | { readonly localKey: string | null }
    | {
        readonly extensionKey: string;
        readonly legacyLevelsKey: string | null;
        readonly legacyCollapsedKey: string | null;
        readonly resolveAccountScope: () => Promise<AccountScope | null>;
      };
  readonly resolveCanonicalTurnId: (id: string) => string | null;
  readonly getStoredTurnIdAliases: (id: string) => string[];
  readonly canEdit: (marker: TimelineMarker | undefined, id: string) => boolean;
  readonly isCurrent: () => boolean;
  readonly getConversationTitle: (markers: readonly TimelineMarker[]) => string;
}

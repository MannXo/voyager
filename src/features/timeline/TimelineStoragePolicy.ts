import type { AccountScope } from '@/core/services/AccountIsolationService';

import type { TimelineMarker } from './types';

/** Captured site storage/identity facts; the engine owns all mutable timeline state. */
export interface TimelineStoragePolicy {
  readonly conversationId: string;
  readonly url: string;
  readonly settingsPrefix: string;
  readonly stars: {
    readonly matchLegacyConversations: boolean;
    readonly resolveAccount: () => Promise<string | undefined>;
  };
  readonly hierarchy: {
    readonly extensionKey: string;
    readonly legacyLevelsKey: string | null;
    readonly legacyCollapsedKey: string | null;
    /** Gemini only: a missing scoped blob adopts the pre-isolation unscoped blob once. */
    readonly adoptUnscopedHierarchy: boolean;
    /** null stores unscoped; 'unknown' reads and writes nothing until a later edit retries. */
    readonly resolveAccountScope: () => Promise<
      Pick<AccountScope, 'accountKey' | 'routeUserId'> | null | 'unknown'
    >;
  };
  /** Full-history aliases belong to stored records, never to DOM-window positions. */
  readonly resolveMountedTurnId: (id: string) => string | null;
  readonly resolveStoredTurnId: (id: string) => string | null;
  readonly getStoredTurnIdAliases: (id: string) => string[];
  readonly canEdit: (marker: TimelineMarker | undefined, id: string) => boolean;
  readonly isCurrent: () => boolean;
  readonly getConversationTitle: (markers: readonly TimelineMarker[]) => string;
}

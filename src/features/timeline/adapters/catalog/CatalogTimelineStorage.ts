import type { TimelineStoragePolicy } from '../../TimelineStoragePolicy';
import { CatalogTurnOwnership } from './CatalogTurnOwnership';
import {
  catalogHierarchyStorageKey,
  catalogStarsStorageKey,
  type CatalogTimelineConfig,
} from './config';
import { buildConversationId, starConversationId } from './conversationId';
import { extractTurnHash } from './turnHash';

export function createCatalogTimelineStoragePolicy(
  config: CatalogTimelineConfig,
  ownership: CatalogTurnOwnership,
  url = location.href.split('#')[0],
): TimelineStoragePolicy {
  const conversationId = starConversationId(config, url);
  const routeId = buildConversationId(config, url);
  return {
    conversationId: conversationId ?? '',
    url,
    settingsPrefix: `gvTimeline:${config.siteId}:`,
    stars: {
      key: conversationId ? catalogStarsStorageKey(config.siteId, conversationId) : null,
      legacyKeys: conversationId ? [`geminiTimelineStars:${conversationId}`] : [],
      copyLegacy: false,
      source: 'local',
      libraryMirror: true,
      matchLegacyConversations: false,
    },
    hierarchy: {
      localKey: conversationId ? catalogHierarchyStorageKey(config.siteId, conversationId) : null,
    },
    resolveCanonicalTurnId: extractTurnHash,
    getStoredTurnIdAliases: (id) => [id],
    canEdit: (marker) => !!conversationId && !!marker && ownership.canStar(marker.element),
    // Hosts change their URL and thread DOM separately; neither old turns nor pending work may write into the next route.
    isCurrent: () => buildConversationId(config) === routeId && location.href.split('#')[0] === url,
    getConversationTitle: (markers) => {
      const title = document.title
        .replace(
          new RegExp(
            `\\s*[|-]\\s*${config.siteLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`,
            'i',
          ),
          '',
        )
        .trim();
      return title || markers[0]?.summary.slice(0, 50) || `${config.siteLabel} conversation`;
    },
  };
}

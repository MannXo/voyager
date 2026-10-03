import { type Dispose, PluginScope } from '@/features/plugins/runtime/pluginScope';
import { requestPluginSetting } from '@/features/plugins/storage/pluginSettingRequest';
import type { PluginSettings } from '@/features/plugins/types';
import type { PrimitiveHandle } from '@/features/plugins/verbs/types';
import { showTimelineStyleCoachmark } from '@/pages/content/timeline/timelineStyleCoachmark';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';

import { TimelineEngine } from '../../TimelineEngine';
import { CatalogTimelineAdapter } from './CatalogTimelineAdapter';
import { catalogStarsStorageKey, type CatalogTimelineConfig } from './config';
import { starConversationId, turnConversationId } from './conversationId';
import { NavigatorStars } from './navigatorStars';

/** The primitive scope owns route lifetime; viewport remounts stay inside one engine. */
export function activateCatalogTimeline(
  scope: PluginScope,
  config: CatalogTimelineConfig,
  settings: PluginSettings = {},
): PrimitiveHandle {
  let engine: TimelineEngine | null = null;
  let stopStart: Dispose | null = null;
  let currentSettings = settings;
  let route = location.href.split('#')[0];
  const stars = new NavigatorStars({
    routeId: () => location.href.split('#')[0],
    starId: () => starConversationId(config),
    alive: () => !scope.isDisposed,
    turnConversation: (element) => turnConversationId(config, element),
    storageKey: (id) => catalogStarsStorageKey(config.siteId, id),
  });
  stars.begin();
  if (document.body)
    scope.observe(document.body, { childList: true, subtree: true }, (records) =>
      stars.recordInsertions(records),
    );
  const start = (): void => {
    if (scope.isDisposed) return;
    engine?.destroy();
    void stopStart?.();
    engine = new TimelineEngine(new CatalogTimelineAdapter(config, stars));
    // Settings belong to the mounted plugin version; route changes keep them.
    engine.updateSettings(currentSettings);
    const captured = engine;
    stopStart = scope.effect(
      () =>
        captured.init().then(() => {
          if (!scope.isDisposed && engine === captured) captured.updateSettings(currentSettings);
          return () => captured.destroy();
        }),
      'catalog-timeline-start',
    );
  };
  scope.effect(
    () => () => {
      engine?.destroy();
      engine = null;
    },
    'catalog-timeline',
  );
  scope.effect(
    () =>
      watchRouteChanges(() => {
        const next = location.href.split('#')[0];
        if (next === route) return;
        route = next;
        start();
      }),
    'catalog-timeline-route',
  );
  scope.on(window, 'hashchange', () => engine?.handleHash());
  start();
  let yieldGuide = false;
  try {
    yieldGuide = !!config.yieldWhenSelector && !!document.querySelector(config.yieldWhenSelector);
  } catch {
    /* Invalid optional catalog selector does not block the timeline. */
  }
  if (!yieldGuide && currentSettings.compactView !== true) {
    void showTimelineStyleCoachmark({
      id: config.coachmarkId,
      enabled: false,
      signal: scope.signal,
      onStyleChange: async (compact) => {
        if (scope.isDisposed) return;
        currentSettings = { ...currentSettings, compactView: compact };
        engine?.updateSettings(currentSettings);
        await requestPluginSetting(config.pluginId, 'compactView', compact);
      },
    });
  }
  return {
    updateSettings(next) {
      currentSettings = next;
      engine?.updateSettings(next);
    },
  };
}

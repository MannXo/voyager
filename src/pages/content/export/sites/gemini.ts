import type { ExportPlatformAdapter } from '../adapter/platformAdapters';
import { createConversationCollector } from '../conversationCollector';
import type { ExportSite } from '../exportSite';

/** Gemini keeps every loaded turn mounted, so the export reads the page in place. */
export function createGeminiExportSite(adapter: ExportPlatformAdapter): ExportSite {
  const page = createConversationCollector(adapter);
  return {
    id: adapter.site.id,
    label: adapter.site.label,
    entryPoints: {
      kind: 'gemini',
      userSelectors: adapter.getUserSelectors,
      assistantMessageIdFor: page.assistantMessageIdFor,
    },
    title: adapter.extractConversationTitle,
    turns: {
      scrollsWhileBuilding: false,
      messages: page.collectSelectionMessages,
      build: async (selectedIds) => page.turnsForMessageIds(selectedIds),
    },
    page,
    history: {
      userSelectors: adapter.getUserSelectors,
      assistantSelectors: adapter.getAssistantSelectors,
    },
  };
}

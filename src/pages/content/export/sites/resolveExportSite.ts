import { resolveExportAdapter } from '../adapter/platformAdapters';
import type { ExportSite } from '../exportSite';
import { createChatGptExportSite } from './chatgpt';
import { createGeminiExportSite } from './gemini';

/** The conversation export for the current host; any host other than ChatGPT reads like Gemini. */
export function resolveExportSite(): ExportSite {
  const adapter = resolveExportAdapter();
  return adapter.site.id === 'chatgpt'
    ? createChatGptExportSite(adapter)
    : createGeminiExportSite(adapter);
}

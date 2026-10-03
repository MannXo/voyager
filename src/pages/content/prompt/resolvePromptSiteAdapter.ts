import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { PromptSiteAdapter } from '@/features/prompt/PromptSiteAdapter';

/** gemini.google.com and business.gemini.google: the only composers whose send path slash expands. */
const GEMINI: PromptSiteAdapter = { slash: true };

/** AI Studio, the catalog platforms and custom websites. */
const OTHER: PromptSiteAdapter = { slash: false };

export function resolvePromptSiteAdapter(url: string): PromptSiteAdapter {
  return SiteRegistry.createDefault().resolveByUrl(url)?.id === 'gemini' ? GEMINI : OTHER;
}

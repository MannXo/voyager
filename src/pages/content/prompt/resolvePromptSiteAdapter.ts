import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { PromptSiteAdapter } from '@/features/prompt/PromptSiteAdapter';

import { insertTextIntoChatInput } from '../chatInput/index';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';

/** gemini.google.com and business.gemini.google: the only composers whose send path slash expands. */
const GEMINI: PromptSiteAdapter = {
  slash: true,
  insert(text) {
    // Input collapse folds only Gemini's composer; a folded one has no height to insert into.
    expandInputCollapseIfNeeded();
    return insertTextIntoChatInput(text);
  },
};

/** AI Studio, the catalog platforms and custom websites. */
const OTHER: PromptSiteAdapter = {
  slash: false,
  insert: insertTextIntoChatInput,
};

export function resolvePromptSiteAdapter(url: string): PromptSiteAdapter {
  return SiteRegistry.createDefault().resolveByUrl(url)?.id === 'gemini' ? GEMINI : OTHER;
}

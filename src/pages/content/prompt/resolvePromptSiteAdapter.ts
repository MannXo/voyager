import { SiteRegistry } from '@/features/plugins/sites/registry';
import type { PromptSiteAdapter } from '@/features/prompt/PromptSiteAdapter';

import { insertTextIntoChatInput } from '../chatInput/index';
import { expandInputCollapseIfNeeded } from '../inputCollapse/index';
import { getScheme } from '../platformTheme/scheme';
import { detectPageScheme } from './pageScheme';

/** gemini.google.com and business.gemini.google: the only composers whose send path slash expands. */
const GEMINI: PromptSiteAdapter = {
  slash: true,
  insert(text) {
    // Input collapse folds only Gemini's composer; a folded one has no height to insert into.
    expandInputCollapseIfNeeded();
    return insertTextIntoChatInput(text);
  },
  scheme: detectPageScheme,
};

/** AI Studio, ChatGPT, Claude and custom websites. */
const OTHER: PromptSiteAdapter = {
  slash: false,
  insert: insertTextIntoChatInput,
  scheme: detectPageScheme,
};

/**
 * DeepSeek marks its theme with `body.dark` / `body.light`, which the generic
 * markers miss, so the panel opened light on a dark page. The page-wide scheme
 * bridge already reads DeepSeek's site descriptor.
 */
const DEEPSEEK: PromptSiteAdapter = {
  ...OTHER,
  scheme: () => getScheme(),
};

export function resolvePromptSiteAdapter(url: string): PromptSiteAdapter {
  switch (SiteRegistry.createDefault().resolveByUrl(url)?.id) {
    case 'gemini':
      return GEMINI;
    case 'deepseek':
      return DEEPSEEK;
    default:
      return OTHER;
  }
}

/**
 * Background owner of prompt-library writes. Writers send their changes here
 * and one queue applies them against the latest stored library; the Drive
 * prompt merges in this worker go through the same queue directly.
 */
import {
  handlePromptLibraryApplyMessage,
  isPromptLibraryApplyMessage,
} from '@/features/prompt/library/promptLibraryMessages';
import { createPromptLibraryOwner } from '@/features/prompt/library/promptLibraryOwner';

import { isTrustedExtensionPageSender } from './runtimeMessageRouting';

export const promptLibraryOwner = createPromptLibraryOwner({
  area: {
    get: (key) => chrome.storage.local.get(key),
    set: (items) => chrome.storage.local.set(items),
  },
});

/**
 * An extension page such as the popup, or this extension's content script in
 * a tab's top frame. Prompt Manager runs on custom sites too, so the page's
 * host is not checked; a content script can already write the key itself.
 */
export function isAllowedPromptLibrarySender(sender: chrome.runtime.MessageSender): boolean {
  if (isTrustedExtensionPageSender(sender)) return true;
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  return sender.frameId === undefined || sender.frameId === 0;
}

export function startPromptLibraryOwner(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isPromptLibraryApplyMessage(message)) return undefined;
    if (!isAllowedPromptLibrarySender(sender)) {
      sendResponse({ ok: false, error: 'sender_not_allowed' });
      return undefined;
    }
    void handlePromptLibraryApplyMessage(message, promptLibraryOwner).then(sendResponse);
    return true;
  });
}

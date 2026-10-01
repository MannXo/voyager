/**
 * Background owner of research-pack writes. Every Gemini tab sends its edits
 * here, and one queue applies them against the latest stored pack, so two
 * tabs adding at the same moment both keep their item.
 */
import {
  handleResearchPackApplyMessage,
  isResearchPackApplyMessage,
} from '@/features/researchPack/services/packMessages';
import { createResearchPackOwner } from '@/features/researchPack/services/packStore';

import { isAllowedSyncContentSender } from './runtimeMessageRouting';

/** Same gate as the Drive sync content messages: this extension, on a Gemini tab. */
export function isAllowedResearchPackSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && isAllowedSyncContentSender(sender.tab?.url, 'gemini');
}

export function startResearchPackOwner(): void {
  const owner = createResearchPackOwner({
    area: {
      get: (key) => chrome.storage.local.get(key),
      set: (items) => chrome.storage.local.set(items),
    },
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isResearchPackApplyMessage(message)) return undefined;
    if (!isAllowedResearchPackSender(sender)) {
      sendResponse({ ok: false, error: 'sender_not_allowed' });
      return undefined;
    }
    void handleResearchPackApplyMessage(message, owner).then(sendResponse);
    return true;
  });
}

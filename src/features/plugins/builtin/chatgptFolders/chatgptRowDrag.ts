/**
 * Dragging a conversation out of ChatGPT's sidebar onto a Voyager folder.
 *
 * ChatGPT renders each row link `draggable="false"` and starts no HTML5 drag of
 * its own (see the fixture), so a primary press on a row link makes it
 * draggable for that one gesture, and the drag carries Voyager's JSON payload.
 * The folder trees read it back with `readSidebarRowDrop`. Nothing stays on
 * ChatGPT's nodes: the link gets its own `draggable` back when the gesture ends.
 */
import type { ConversationReference } from '@/core/types/folder';
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { VOYAGER_DRAG_MIME, readDragPayload } from '@/pages/content/folder/dragPayload';
import type { DragData } from '@/pages/content/folder/types';

import { CHATGPT_CONVERSATION_ID_PREFIX, readChatGptConversation } from './chatgptIdentity';
import {
  type SidebarConversation,
  findChatGptSidebar,
  readSidebarLink,
  readSidebarTitle,
} from './chatgptSidebarDom';

export type DroppedConversation = Pick<ConversationReference, 'conversationId' | 'title' | 'url'>;

function sidebarRowAt(target: EventTarget | null): SidebarConversation | null {
  const link = target instanceof Element ? target.closest('a[href]') : null;
  if (!link || !findChatGptSidebar()?.contains(link)) return null;
  return readSidebarLink(link);
}

/** Makes ChatGPT's sidebar rows drag sources for Voyager folders while `scope` lives. */
export function bindChatGptRowDrag(scope: PluginScope, untitled: () => string): void {
  let armed: { link: HTMLAnchorElement; draggable: string | null } | null = null;

  const disarm = (): void => {
    if (!armed) return;
    const { link, draggable } = armed;
    if (draggable === null) link.removeAttribute('draggable');
    else link.setAttribute('draggable', draggable);
    armed = null;
  };

  // The browser picks the drag source when the pointer starts moving, so
  // setting `draggable` on press is in time for this gesture.
  const arm = (event: PointerEvent): void => {
    disarm();
    if (event.button !== 0) return;
    const row = sidebarRowAt(event.target);
    if (!row) return;
    armed = { link: row.link, draggable: row.link.getAttribute('draggable') };
    row.link.draggable = true;
  };

  const start = (event: DragEvent): void => {
    const row = sidebarRowAt(event.target);
    if (!row || !event.dataTransfer) return;
    const payload: DragData = {
      type: 'conversation',
      conversationId: `${CHATGPT_CONVERSATION_ID_PREFIX}${row.id}`,
      title: readSidebarTitle(row) || untitled(),
      url: `${location.origin}${row.path}`,
    };
    // Move only: a link drag may otherwise offer to open the chat in a new tab or split view.
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(VOYAGER_DRAG_MIME, JSON.stringify(payload));
  };

  scope.on(document, 'pointerdown', arm, { capture: true });
  scope.on(document, 'pointerup', disarm, { capture: true });
  scope.on(document, 'dragend', disarm, { capture: true });
  scope.on(document, 'dragstart', start, { capture: true });
  scope.effect(() => disarm, 'chatgpt-folders:row-drag');
}

/**
 * The ChatGPT conversation a drop carries, or `null`. Any page can start a drag
 * with JSON, so only a conversation keyed by its own ChatGPT URL is accepted.
 */
export function readSidebarRowDrop(transfer: DataTransfer | null): DroppedConversation | null {
  const payload = readDragPayload(transfer);
  if (payload?.type !== 'conversation' || payload.sourceFolderId || !payload.url) return null;
  const conversation = readChatGptConversation(payload.url);
  if (!conversation || conversation.conversationId !== payload.conversationId) return null;
  return {
    conversationId: conversation.conversationId,
    title: payload.title,
    url: conversation.url,
  };
}

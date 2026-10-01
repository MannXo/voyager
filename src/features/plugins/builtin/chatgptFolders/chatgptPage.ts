import type { ConversationReference } from '@/core/types/folder';

import { readChatGptConversation } from './chatgptIdentity';

/** ChatGPT's own sidebar; its conversation links are router links. */
const SIDEBAR_SELECTOR = 'nav[aria-label], #stage-slideover-sidebar';
const ACTIVE_LINK_SELECTOR = `:is(${SIDEBAR_SELECTOR}) a[aria-current="page"]`;
const PLACEHOLDER_TITLES = new Set(['ChatGPT', 'New chat']);

function isTemporaryChatUrl(href: string): boolean {
  try {
    return new URL(href).searchParams.get('temporary-chat') === 'true';
  } catch {
    return false;
  }
}

function readTitle(doc: Document): string | null {
  const title = doc.title.trim();
  if (title && !PLACEHOLDER_TITLES.has(title)) return title;
  return doc.querySelector(ACTIVE_LINK_SELECTOR)?.textContent?.trim() || null;
}

/**
 * The open conversation as a folder entry, or `null` on any page that is not a
 * saved conversation (home, a Project overview, a temporary chat).
 */
export function readCurrentConversation(
  untitled: string,
  doc: Document = document,
  href: string = location.href,
  now: number = Date.now(),
): ConversationReference | null {
  if (isTemporaryChatUrl(href)) return null;
  const identity = readChatGptConversation(href);
  if (!identity) return null;
  return {
    conversationId: identity.conversationId,
    title: readTitle(doc) ?? untitled,
    url: identity.url,
    addedAt: now,
  };
}

/** A link ChatGPT rendered for conversation `id`, at whatever route it lives under. */
function findNativeLink(doc: Document, id: string): HTMLAnchorElement | null {
  for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (readChatGptConversation(link.href)?.id === id) return link;
  }
  return null;
}

/**
 * Opens a filed conversation inside the running app, never with a full load:
 * click ChatGPT's own link for it when one is rendered (its router handles the
 * click), else push the path and announce it with `popstate`, which client
 * routers read as a navigation. Returns `false` for a non-ChatGPT entry.
 */
export function openChatGptConversation(
  conversation: ConversationReference,
  doc: Document = document,
  win: Window = window,
): boolean {
  const identity = readChatGptConversation(conversation.url);
  if (!identity) return false;
  if (readChatGptConversation(win.location.href)?.id === identity.id) return true;

  const link = findNativeLink(doc, identity.id);
  if (link) {
    link.click();
    return true;
  }
  // A fresh entry carries no state: copying the router's state would give two
  // entries the same router key.
  win.history.pushState(null, '', identity.path);
  win.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  return true;
}

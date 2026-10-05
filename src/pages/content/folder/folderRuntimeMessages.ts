import browser, { type Runtime } from 'webextension-polyfill';

import type { AccountScope } from '@/core/services/AccountIsolationService';
import type { SyncAccountScope } from '@/core/types/sync';

import type { FolderStore } from './FolderStore';
import { folderDebug, folderDebugWarn } from './folderManagerDebug';
import { type NativeSidebarReadContext, collectAllSidebarConversations } from './nativeSidebarDom';

type SendResponse = (response: unknown) => void;

type FolderRuntimeMessageOptions = {
  store: FolderStore;
  refresh(): void;
  getSidebarContext(): NativeSidebarReadContext;
};

function toSyncAccountScope(scope: AccountScope | null): SyncAccountScope | undefined {
  if (!scope) return undefined;
  return {
    accountKey: scope.accountKey,
    accountId: scope.accountId,
    routeUserId: scope.routeUserId,
  };
}

function respondWithData(store: FolderStore, sendResponse: SendResponse): true {
  folderDebug('Received request for folder data from popup');
  // An unresolved or unreadable session's empty data must not replace the popup's storage fallback.
  if (!store.canEdit) {
    sendResponse({ ok: false });
    return true;
  }
  sendResponse({
    ok: true,
    data: store.data,
    accountScope: toSyncAccountScope(store.accountScope),
  });
  return true;
}

// The popup's reload request after a cloud sync. This is the single handler
// for this message (a duplicate storage-listener handler used to
// double-process every sync).
function reloadAndRespond(options: FolderRuntimeMessageOptions, sendResponse: SendResponse): true {
  folderDebug('Received reload request');
  options.store.loadData().then(() => {
    options.refresh();
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
  });
  return true;
}

// Collects all conversations and the folder structure for AI organization.
function respondWithStructureForAI(
  options: FolderRuntimeMessageOptions,
  sendResponse: SendResponse,
): true {
  const { store } = options;
  folderDebug('Received AI structure request');
  collectAllSidebarConversations(options.getSidebarContext)
    .then((sidebarConversations) => {
      sendResponse({ ok: true, sidebarConversations, folderData: store.data });
    })
    .catch((error) => {
      folderDebugWarn('getStructureForAI collection failed:', error);
      sendResponse({ ok: true, sidebarConversations: [], folderData: store.data });
    });
  return true; // respond asynchronously after rows populate
}

/** Answers the popup's folder requests; returns the listener's removal. */
export function listenForFolderRuntimeMessages(options: FolderRuntimeMessageOptions): () => void {
  const listener = (
    message: unknown,
    _sender: Runtime.MessageSender,
    sendResponse: SendResponse,
  ): true | undefined => {
    const type = (message as Record<string, unknown>).type;
    if (type === 'gv.sync.requestData') return respondWithData(options.store, sendResponse);
    if (type === 'gv.folders.reload') return reloadAndRespond(options, sendResponse);
    if (type === 'gv.folders.getStructureForAI') {
      return respondWithStructureForAI(options, sendResponse);
    }
    // Not a message we handle. Returning `true` here would claim "I will
    // respond asynchronously" and never do so, leaving the sender's promise
    // pending forever (e.g. a background broadcast awaiting Promise.all over
    // every tab). Return undefined so the channel closes normally.
    return undefined;
  };
  // The polyfill's OnMessageListener typing cannot express "sync-respond to
  // some messages, ignore the rest" (its callback variant requires a constant
  // `true` return). Runtime behavior is well-defined for both values, so
  // cast: `true` keeps the channel open for handled messages, `undefined`
  // closes it for unknown ones.
  const callback = listener as Runtime.OnMessageListenerCallback;
  browser.runtime.onMessage.addListener(callback);
  return () => browser.runtime.onMessage.removeListener(callback);
}

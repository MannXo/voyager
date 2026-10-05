import { vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import {
  handlePromptLibraryApplyMessage,
  isPromptLibraryApplyMessage,
} from '@/features/prompt/library/promptLibraryMessages';
import { createPromptLibraryOwner } from '@/features/prompt/library/promptLibraryOwner';
import { createStarStore } from '@/features/savedLibrary/starStore';

type RuntimeRequest = { type?: string; payload?: unknown };

export function createCloudSyncChromeMock(
  sendSyncMessage: (message: RuntimeRequest) => unknown,
): typeof chrome {
  const stored: Record<string, unknown> = {
    [StorageKeys.FOLDER_DATA]: { folders: [], folderContents: {} },
    [StorageKeys.PROMPT_ITEMS]: [],
    [StorageKeys.TIMELINE_STARRED_MESSAGES]: { messages: {} },
    [StorageKeys.TIMELINE_HIERARCHY]: { conversations: {} },
  };
  const local = {
    get: vi.fn(async (keys: unknown) => {
      const names =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      const defaults =
        keys && typeof keys === 'object' && !Array.isArray(keys)
          ? (keys as Record<string, unknown>)
          : {};
      return Object.fromEntries(
        names.map((name) => [name, structuredClone(stored[name] ?? defaults[name])]),
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(stored, structuredClone(items));
    }),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const owner = createStarStore({
    get: (keys) => local.get(keys),
    set: (items) => local.set(items),
  });
  const prompts = createPromptLibraryOwner({
    area: { get: (key) => local.get(key), set: (items) => local.set(items) },
  });
  return {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      sendMessage: vi.fn((message: RuntimeRequest, reply?: (response: unknown) => void) => {
        if (message.type === 'gv.starred.mergeCloud' && reply) {
          void owner.mergeCloud(message.payload).then(
            (result) => reply({ ok: true, ...result }),
            (error: Error) => reply({ ok: false, error: error.message }),
          );
          return;
        }
        if (isPromptLibraryApplyMessage(message)) {
          return handlePromptLibraryApplyMessage(message, prompts);
        }
        return sendSyncMessage(message);
      }),
    },
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 1, url: 'https://gemini.google.com/app' }),
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://gemini.google.com/app' }]),
      sendMessage: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { folders: [], folderContents: {} } }),
    },
    storage: {
      local,
      sync: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  } as unknown as typeof chrome;
}

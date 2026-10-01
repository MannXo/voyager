import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  MAX_RUNTIME_IMAGE_BYTES,
  isAllowedRuntimeImageBody,
  parseAllowedRuntimeImageUrl,
} from '@/core/utils/runtimeImageFetch';
import {
  CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE,
  CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE,
  CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE,
} from '@/features/plugins/builtin/chatgptTemporaryHandoff/storage';
import {
  PLUGIN_CATALOG_REFRESH_MESSAGE,
  PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE,
} from '@/features/plugins/runtime/messages';

import {
  canSenderPageUseSyncPlatform,
  getSenderPageUrl,
  isAllowedSyncContentSender,
  isHandledBackgroundRuntimeMessage,
  isTrustedSyncMessageSender,
  parseSyncPlatform,
} from '../runtimeMessageRouting';

const EXTENSION_ID = 'test-extension-id';
const contentSender = (url: string): chrome.runtime.MessageSender => ({
  id: EXTENSION_ID,
  url,
  tab: { id: 7, url } as chrome.tabs.Tab,
});

describe('background runtime message routing', () => {
  it('keeps the async channel open only for exact handled message types', () => {
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.account.resolve' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.list' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.sync.upload' })).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE })).toBe(
      true,
    );
    expect(isHandledBackgroundRuntimeMessage({ type: PLUGIN_CATALOG_REFRESH_MESSAGE })).toBe(true);
    expect(
      isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_SCHEDULE_EXPIRY_MESSAGE }),
    ).toBe(true);
    expect(isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_CANCEL_EXPIRY_MESSAGE })).toBe(
      true,
    );
    expect(isHandledBackgroundRuntimeMessage({ type: CHATGPT_HANDOFF_GET_TAB_ID_MESSAGE })).toBe(
      true,
    );

    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.highlight.unknown' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.storageQuota.ready' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage({ type: 'gv.unhandled' })).toBe(false);
    expect(isHandledBackgroundRuntimeMessage(null)).toBe(false);
  });

  it('routes plugin messages through the serialized sync and the single catalog refresher', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    expect(source).toContain('handlePluginRuntimeMessage(message, {');
    expect(source).toContain('syncContentScripts: syncPluginContentScripts');
    expect(source).toContain('hostCatalogRefresher.refresh(host, { force })');
    expect(source.match(/new HostCatalogRefresher\(/g)?.length).toBe(1);
  });

  it('uploads the complete prompt union even when duplicate names remain', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const pushBranch =
      source.match(
        /case 'gv\.sync\.pushPromptsMerge': \{[\s\S]*?case 'gv\.sync\.getState': \{/,
      )?.[0] ?? '';

    expect(pushBranch).toContain('googleDriveSyncService.uploadPromptsOnly');
    expect(pushBranch).toContain('nameConflicts: getPromptNameConflictIds(localPrompts).size');
    expect(pushBranch).not.toContain('if (merged.data.nameConflicts > 0)');
    expect(pushBranch).not.toContain('skipped: true');
  });

  it('keeps privileged runtime operations behind their security boundaries', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/background/index.ts'), 'utf8');
    const captureBranch =
      source.match(
        /if \(message\?\.type === 'gv\.generatedUi\.captureVisibleTab'\) \{[\s\S]*?if \(message\?\.type === 'gv\.account\.resolve'\) \{/,
      )?.[0] ?? '';
    const uploadBranch =
      source.match(/case 'gv\.sync\.upload': \{[\s\S]*?case 'gv\.sync\.download': \{/)?.[0] ?? '';
    const imageHandler =
      source.match(/async function handleRuntimeImageMessage\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(captureBranch).toContain('chrome.tabs.query({ active: true, windowId })');
    expect(captureBranch).toContain('sender_not_active');

    expect(uploadBranch).toContain('loadAuthoritativeSyncPayload');
    expect(uploadBranch).not.toMatch(/const \{\s*folders,\s*prompts,/);

    expect(imageHandler).toContain('parseAllowedRuntimeImageUrl');
    expect(imageHandler).toContain('isAllowedRuntimeImageBody');
    expect(imageHandler).toContain('MAX_RUNTIME_IMAGE_BYTES');
  });

  it('renders AI Studio folder names as text instead of HTML', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/pages/content/folder/aistudio.ts'),
      'utf8',
    );
    const folderDropItem =
      source.match(
        /const createFolderDropItem = \(folder: Folder, isSubfolder: boolean\) => \{[\s\S]*?\/\/ Bind drop events/,
      )?.[0] ?? '';

    expect(folderDropItem).not.toContain('folderItem.innerHTML');
    expect(folderDropItem).toContain('document.createTextNode(folder.name)');
  });

  it('allows only bounded images from media hosts or the sender origin', () => {
    expect(
      parseAllowedRuntimeImageUrl(
        'https://lh3.googleusercontent.com/private/image.png',
        'https://gemini.google.com/app',
      )?.hostname,
    ).toBe('lh3.googleusercontent.com');
    expect(
      parseAllowedRuntimeImageUrl(
        'https://gemini.google.com/local/image.png',
        'https://gemini.google.com/app',
      )?.pathname,
    ).toBe('/local/image.png');

    expect(
      parseAllowedRuntimeImageUrl(
        'https://evil-googleusercontent.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();
    expect(
      parseAllowedRuntimeImageUrl(
        'http://lh3.googleusercontent.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();
    expect(
      parseAllowedRuntimeImageUrl(
        'https://accounts.google.com/private',
        'https://gemini.google.com/app',
      ),
    ).toBeNull();

    expect(isAllowedRuntimeImageBody('image/png', MAX_RUNTIME_IMAGE_BYTES)).toBe(true);
    expect(isAllowedRuntimeImageBody('text/html', 100)).toBe(false);
    expect(isAllowedRuntimeImageBody('image/png', MAX_RUNTIME_IMAGE_BYTES + 1)).toBe(false);
  });

  it('accepts sync content messages only from the matching product host', () => {
    expect(isAllowedSyncContentSender('https://gemini.google.com/app', 'gemini')).toBe(true);
    expect(isAllowedSyncContentSender('https://business.gemini.google/app', 'gemini')).toBe(true);
    expect(isAllowedSyncContentSender('https://aistudio.google.com/app', 'aistudio')).toBe(true);
    expect(isAllowedSyncContentSender('https://aistudio.google.cn/app', 'aistudio')).toBe(true);

    expect(isAllowedSyncContentSender('https://example.com/app', 'gemini')).toBe(false);
    expect(isAllowedSyncContentSender('https://gemini.google.com/app', 'aistudio')).toBe(false);
    expect(isAllowedSyncContentSender('http://gemini.google.com/app', 'gemini')).toBe(false);
    expect(isAllowedSyncContentSender('https://chatgpt.com/c/1', 'gemini')).toBe(false);
    expect(isAllowedSyncContentSender('https://claude.ai/chat/1', 'aistudio')).toBe(false);
  });

  it('rejects unknown sync platforms instead of falling back to Gemini folders', () => {
    expect(parseSyncPlatform(undefined)).toBe('gemini');
    expect(parseSyncPlatform('gemini')).toBe('gemini');
    expect(parseSyncPlatform('aistudio')).toBe('aistudio');
    expect(parseSyncPlatform('chatgpt')).toBeNull();
    expect(parseSyncPlatform('__proto__')).toBeNull();
    expect(parseSyncPlatform({ platform: 'gemini' })).toBeNull();
  });

  it('keeps ChatGPT, Claude and DeepSeek tabs away from Gemini and AI Studio folder sync', () => {
    for (const url of [
      'https://chatgpt.com/c/1',
      'https://claude.ai/chat/1',
      'https://chat.deepseek.com/a/chat/s/1',
    ]) {
      for (const platform of ['gemini', 'aistudio'] as const) {
        expect(isTrustedSyncMessageSender(contentSender(url), platform), url).toBe(false);
        expect(canSenderPageUseSyncPlatform(url, platform), url).toBe(false);
      }
    }
  });

  it('keeps folder sync available to native tabs and extension pages', () => {
    const popup: chrome.runtime.MessageSender = {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/src/pages/popup/index.html`,
    };
    expect(isTrustedSyncMessageSender(popup, 'gemini')).toBe(true);
    expect(isTrustedSyncMessageSender(popup, 'aistudio')).toBe(true);
    expect(
      isTrustedSyncMessageSender(contentSender('https://gemini.google.com/app'), 'gemini'),
    ).toBe(true);
    expect(
      isTrustedSyncMessageSender(contentSender('https://aistudio.google.com/prompts'), 'aistudio'),
    ).toBe(true);
    expect(
      isTrustedSyncMessageSender(
        { ...contentSender('https://gemini.google.com/app'), id: 'other-extension' },
        'gemini',
      ),
    ).toBe(false);

    expect(canSenderPageUseSyncPlatform(undefined, 'aistudio')).toBe(true);
    // Options-page fallback runs the popup inside an extension tab.
    expect(
      canSenderPageUseSyncPlatform(
        `chrome-extension://${EXTENSION_ID}/src/pages/options/index.html?sourceTabId=4`,
        'aistudio',
      ),
    ).toBe(true);
    expect(canSenderPageUseSyncPlatform('https://gemini.google.com/u/1/app', 'gemini')).toBe(true);
    expect(canSenderPageUseSyncPlatform('https://aistudio.google.cn/prompts', 'aistudio')).toBe(
      true,
    );
    expect(canSenderPageUseSyncPlatform('https://gemini.google.com/app', 'aistudio')).toBe(false);
  });

  it('checks the frame URL when the browser omits the tab URL', () => {
    const chatgpt = getSenderPageUrl({ tab: {}, url: 'https://chatgpt.com/c/abc' });
    expect(canSenderPageUseSyncPlatform(chatgpt, 'gemini')).toBe(false);
    const popup = getSenderPageUrl({ url: `chrome-extension://${EXTENSION_ID}/popup.html` });
    expect(canSenderPageUseSyncPlatform(popup, 'gemini')).toBe(true);
    expect(getSenderPageUrl({ tab: { url: 'https://gemini.google.com/app' }, url: 'x' })).toBe(
      'https://gemini.google.com/app',
    );
  });
});

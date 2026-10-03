import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wiring = vi.hoisted(() => {
  const order: string[] = [];
  const pending = () => new Promise<void>(() => {});
  const start = (name: string) => () => {
    order.push(name);
  };
  const startup = (name: string) => () => {
    order.push(name);
    return pending();
  };
  const siteAccess = {
    syncCustom: vi.fn(startup('site.custom')),
    syncPlugins: vi.fn(startup('site.plugins')),
    refreshPluginSiteDomains: vi.fn(startup('site.domains')),
    syncPromptNudgeIcon: vi.fn(),
    permissionAdded: vi.fn(),
    permissionRemoved: vi.fn(),
  };
  const refresher = { refresh: vi.fn(async () => ({ ok: true })) };
  return {
    order,
    start,
    startup,
    siteAccess,
    refresher,
    target: 'chrome',
    plugin: vi.fn(),
    image: vi.fn(),
    page: vi.fn(),
    highlight: vi.fn(),
    cloud: vi.fn(),
    capture: {
      cleanupLegacyGeneratedUiCapturePermission: vi.fn(startup('capture.cleanup')),
      handle: vi.fn(),
    },
    notifications: {
      connectNativeOpenConversationPort: vi.fn(start('notifications.connect')),
      registerClickListener: vi.fn(() => {
        chrome.notifications.onClicked.addListener(() => {});
      }),
      handle: vi.fn(),
    },
  };
});

vi.mock('@/core/utils/browser', () => ({ getVoyagerBuildTarget: () => wiring.target }));
vi.mock('@/features/announcements/background', () => ({
  startRemoteAnnouncementBackgroundService: () => {
    wiring.start('announcements.start')();
    return { getPendingAnnouncements: vi.fn(), acknowledgeAnnouncement: vi.fn() };
  },
  isRemoteAnnouncementRuntimeMessage: () => false,
}));
vi.mock('@/features/onboarding/welcomePage', () => ({
  registerWelcomePageOnInstall: () => wiring.start('welcome.register')(),
}));
vi.mock('../watermarkDefaultMigration', () => ({
  registerWatermarkDefaultMigrationOnInstall: () => wiring.start('watermark.register')(),
}));
vi.mock('../devAutoReload', () => ({ startDevAutoReload: () => wiring.start('dev.start')() }));
vi.mock('@/features/plugins/remote/hostCatalogRefresh', () => ({
  HostCatalogRefresher: class {
    constructor() {
      wiring.start('catalog.create')();
      return wiring.refresher;
    }
  },
}));
vi.mock('@/features/plugins/builtin/chatgptTemporaryHandoff/background', () => ({
  startChatGptTemporaryHandoffBackgroundService: () => wiring.start('handoff.start')(),
  isChatGptHandoffExpiryMessage: () => false,
  handleChatGptHandoffExpiryMessage: vi.fn(),
  chatGptHandoffTabIdResponse: vi.fn(),
}));
vi.mock('@/features/storageQuotaWarning/background', () => ({
  startStorageQuotaWarningBackgroundService: () => wiring.start('quota.start')(),
}));
vi.mock('../researchPackOwner', () => ({
  startResearchPackOwner: () => wiring.start('research.start')(),
}));
vi.mock('../queueOwners', () => ({ startQueueOwners: () => wiring.start('queue.start')() }));
vi.mock('../responseNotifications', () => ({
  createResponseNotifications: () => wiring.notifications,
}));
vi.mock('../siteAccessRegistration', () => ({
  createSiteAccessRegistration: () => wiring.siteAccess,
}));
vi.mock('../mainWorldRegistration', () => ({
  createMainWorldRegistration: () => ({
    registerFetchInterceptor: wiring.startup('main.fetch'),
    syncResponseCompleteObserverRegistration: wiring.startup('main.response'),
  }),
}));
vi.mock('../generatedUiCapture', () => ({ createGeneratedUiCapture: () => wiring.capture }));
vi.mock('../backgroundSettings', () => ({
  disableRetiredTabTitleUpdateSetting: () => wiring.startup('settings.disableRetired')(),
  migrateOptionalHighlightSetting: () => wiring.startup('settings.migrateHighlights')(),
}));
vi.mock('../starredMessages', () => ({
  createStarredMessagesOwner: () => ({
    handle: () => null,
    getAllStarredMessages: vi.fn(),
  }),
}));
vi.mock('../forkMessages', () => ({
  createForkMessagesOwner: () => ({
    handle: () => null,
    getAllForkNodes: vi.fn(),
  }),
}));
vi.mock('../cloudSyncMessages', () => ({ createCloudSyncMessageHandler: () => wiring.cloud }));
vi.mock('../pageRuntimeMessages', () => ({ handlePageRuntimeMessage: wiring.page }));
vi.mock('../highlightMessages', () => ({ handleHighlightRuntimeMessage: wiring.highlight }));
vi.mock('../pluginRuntimeMessages', () => ({ handlePluginRuntimeMessage: wiring.plugin }));
vi.mock('../runtimeImageMessages', () => ({
  isRuntimeImageMessage: (message: { type?: string }) => message.type === 'gv.fetchImage',
  handleRuntimeImageMessage: wiring.image,
}));

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;
const originalPermissions = Object.getOwnPropertyDescriptor(chrome, 'permissions');
let listener: MessageListener;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  wiring.order.length = 0;
  wiring.target = 'chrome';
  wiring.plugin.mockReturnValue(null);
  wiring.page.mockReturnValue(null);
  wiring.highlight.mockReturnValue(null);
  wiring.cloud.mockReturnValue(null);
  wiring.capture.handle.mockReturnValue(null);
  wiring.notifications.handle.mockReturnValue(null);
  vi.stubEnv('VOYAGER_DEV_AUTO_RELOAD', '');
  vi.spyOn(chrome.notifications.onClicked, 'addListener').mockImplementation(() => {
    wiring.order.push('notifications.listener');
  });
  vi.spyOn(chrome.storage.onChanged, 'addListener').mockImplementation(() => {
    wiring.order.push('storage.listener');
  });
  Object.defineProperty(chrome, 'permissions', {
    configurable: true,
    value: {
      onAdded: { addListener: wiring.start('permissions.addListener') },
      onRemoved: { addListener: wiring.start('permissions.removeListener') },
    },
  });
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((callback) => {
    listener = callback as unknown as MessageListener;
    wiring.order.push('runtime.listener');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (originalPermissions) Object.defineProperty(chrome, 'permissions', originalPermissions);
  else Reflect.deleteProperty(chrome, 'permissions');
});

describe('background owner wiring', () => {
  it('registers listeners in the original order while startup storage work is still pending', async () => {
    await import('../index');
    expect(wiring.order).toEqual([
      'announcements.start',
      'welcome.register',
      'watermark.register',
      'catalog.create',
      'handoff.start',
      'quota.start',
      'research.start',
      'queue.start',
      'notifications.listener',
      'settings.disableRetired',
      'settings.migrateHighlights',
      'capture.cleanup',
      'site.custom',
      'site.plugins',
      'site.domains',
      'main.fetch',
      'main.response',
      'storage.listener',
      'storage.listener',
      'permissions.addListener',
      'permissions.removeListener',
      'runtime.listener',
    ]);
    expect(wiring.siteAccess.syncPromptNudgeIcon).not.toHaveBeenCalled();
  });

  it('leaves unrelated channels alone and answers recognized asynchronous plugin messages exactly once', async () => {
    await import('../index');
    const reply = vi.fn();
    expect(listener({ type: 'gv.chatgptExport.open' }, {}, reply)).toBeUndefined();
    expect(wiring.plugin).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();

    let finish!: (value: unknown) => void;
    wiring.plugin.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE } =
      await import('@/features/plugins/runtime/messages');
    const message = { type: PLUGIN_CONTENT_SCRIPT_SYNC_MESSAGE };
    const sender = { id: 'test-extension-id' };
    expect(listener(message, sender, reply)).toBe(true);
    expect(reply).not.toHaveBeenCalled();
    const hooks = wiring.plugin.mock.calls[0][2] as {
      syncContentScripts: () => Promise<void>;
      refreshCatalog: (host: string, force: boolean) => Promise<unknown>;
    };
    expect(hooks.syncContentScripts).toBe(wiring.siteAccess.syncPlugins);
    await hooks.refreshCatalog('chatgpt.com', true);
    expect(wiring.refresher.refresh).toHaveBeenCalledWith('chatgpt.com', { force: true });
    expect(wiring.order.filter((event) => event === 'catalog.create')).toHaveLength(1);
    finish({ ok: true });
    await Promise.resolve();
    expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: true });
  });

  it('registers Safari native delivery and answers image rejection through the dedicated path', async () => {
    wiring.target = 'safari';
    await import('../index');
    expect(wiring.order.indexOf('notifications.connect')).toBeLessThan(
      wiring.order.indexOf('notifications.listener'),
    );
    const reply = vi.fn();
    wiring.image.mockRejectedValueOnce(new Error('image unavailable'));
    expect(
      listener({ type: 'gv.fetchImage', url: 'https://example.com/image.png' }, {}, reply),
    ).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'image unavailable' });
    expect(wiring.plugin).not.toHaveBeenCalled();
  });
});

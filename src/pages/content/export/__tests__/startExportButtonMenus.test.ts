import { describe, expect, it, vi } from 'vitest';

import type { ConversationMenuExportOptions } from '../conversationMenuExportObserver';

const mocks = vi.hoisted(() => ({
  watchConversationMenusForExport: vi.fn<(options: ConversationMenuExportOptions) => () => void>(
    () => () => {},
  ),
}));

vi.mock('../conversationMenuExportObserver', () => ({
  watchConversationMenusForExport: mocks.watchConversationMenusForExport,
}));
vi.mock('../exportLocale', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../exportLocale')>()),
  readExportLanguage: async () => 'zh',
}));
vi.mock('../responseCopyImageAction', () => ({
  startResponseCopyImageActions: () => ({ relabel: () => {} }),
}));
// Keep the Gemini path parked before the logo/toolbar entry points.
vi.mock('../exportLogoAnchor', () => ({
  resolveExportLogoAnchor: () => new Promise<never>(() => {}),
}));

const { startExportButton } = await import('../index');

describe('startExportButton on Gemini', () => {
  it('labels the conversation menu export item with the localized exportChatJson text', async () => {
    void startExportButton();

    await vi.waitFor(() => expect(mocks.watchConversationMenusForExport).toHaveBeenCalled());
    const [options] = mocks.watchConversationMenusForExport.mock.calls[0];
    expect(options.label()).toBe('导出对话记录');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportFormat } from '../../../../features/export/types/export';
import { nativeHealthReporter } from '../../nativeHealth';
import type { ChatTurn, ConversationCollector, ExportMessage } from '../conversationCollector';
import type { ExportDictionaries } from '../exportLocale';
import type { ExportSite, ExportTurnReader, ExportTurnSession } from '../exportSite';

const mocks = vi.hoisted(() => ({
  exportPendingConversation: vi.fn(),
  reportFinishedExport: vi.fn(),
}));

vi.mock('../generatedUiScreenshots', () => ({
  captureGeneratedUiScreenshots: vi.fn(async () => {}),
  ensureGeneratedUiScreenshotPermission: vi.fn(async () => {}),
  removeGeneratedUiScreenshotSections: vi.fn(),
}));
vi.mock('../pendingExportState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pendingExportState')>()),
  exportPendingConversation: mocks.exportPendingConversation,
}));
vi.mock('../../../../features/export/ui/exportResultNotice', () => ({
  reportFinishedExport: mocks.reportFinishedExport,
}));

const { createExportRunner } = await import('../exportRun');

const dict = {
  en: { pm_export: 'Export now' },
} as unknown as ExportDictionaries;

/** Advance fake time until `condition` holds (runs stay in fake time end to end). */
async function until(condition: () => boolean): Promise<void> {
  for (let elapsed = 0; elapsed < 5000 && !condition(); elapsed += 50) {
    await vi.advanceTimersByTimeAsync(50);
  }
  expect(condition()).toBe(true);
}

async function settle(running: Promise<void>): Promise<void> {
  let done = false;
  void running.then(() => {
    done = true;
  });
  await until(() => done);
}

/** A host without lazy history whose messages and turns come from `page`. */
function fakeSite(page: ConversationCollector): ExportSite {
  return {
    id: 'test',
    label: 'Test Chat',
    entryPoints: { kind: 'toolbar' },
    title: () => 'A conversation',
    page,
    turns: { scrollsWhileBuilding: false, ...pageReader(page) },
  };
}

function pageReader(page: ConversationCollector): ExportTurnReader {
  return {
    messages: () => page.collectSelectionMessages(),
    build: async (ids) => page.turnsForMessageIds(ids),
  };
}

function preparedSession(page: ConversationCollector, release: () => void): ExportTurnSession {
  return { ...pageReader(page), release };
}

function fakeCollector(messages: ExportMessage[]): ConversationCollector {
  return {
    collectChatPairs: () => [],
    collectSelectionMessages: () => messages,
    turnsForMessageIds: (ids) =>
      Array.from(ids).map(
        (id) => ({ user: `turn ${id}`, assistant: '', starred: false }) as ChatTurn,
      ),
    assistantMessageIdFor: () => null,
    topUserElement: () => null,
    conversationRoot: () => document.body,
    snapshotOpenCanvasDocs: vi.fn(),
    releaseCanvasDocs: vi.fn(),
  };
}

function renderMessages(): ExportMessage[] {
  return ['1:u', '1:a'].map((messageId) => {
    const hostElement = document.createElement('div');
    document.body.appendChild(hostElement);
    return {
      messageId,
      role: messageId.endsWith(':u') ? 'user' : 'assistant',
      hostElement,
      text: messageId,
      starred: false,
    } as ExportMessage;
  });
}

function selectionBar(): HTMLElement | null {
  return document.querySelector('[data-gv-export-select-bar="true"]');
}

function clickBarAction(action: string): void {
  document.querySelector<HTMLButtonElement>(`[data-gv-export-action="${action}"]`)!.click();
}

describe('createExportRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.body.className = '';
  });

  it('exports the selected messages and reports the finished PDF', async () => {
    const found = vi.spyOn(nativeHealthReporter, 'reportFound');
    const result = { success: true };
    mocks.exportPendingConversation.mockResolvedValue(result);
    const release = vi.fn();
    const collector = fakeCollector(renderMessages());
    const prepareConversation = vi.fn(async () => preparedSession(collector, release));
    const site = fakeSite(collector);
    const runner = createExportRunner({
      site: { ...site, turns: { ...site.turns, prepare: prepareConversation } },
    });
    const prepare = vi.fn(async () => {});

    const running = runner.run(
      { format: ExportFormat.PDF, fontSize: 14 },
      { dict, lang: 'en' },
      prepare,
    );
    await until(() => selectionBar() !== null);
    clickBarAction('selectAll');
    clickBarAction('export');
    await settle(running);

    expect(prepare).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(prepareConversation).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      expectedUrl: location.href,
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(found).toHaveBeenCalledWith('export');
    const [state, turns, metadata, includeImageSource] =
      mocks.exportPendingConversation.mock.calls[0];
    expect(state).toMatchObject({ format: ExportFormat.PDF, fontSize: 14 });
    expect(turns.map((turn: ChatTurn) => turn.user)).toEqual(['turn 1:u', 'turn 1:a']);
    expect(metadata).toMatchObject({ title: 'A conversation', platform: 'Test Chat', count: 2 });
    expect(includeImageSource).toBe(true);

    const [reported, format, t] = mocks.reportFinishedExport.mock.calls[0];
    expect(reported).toBe(result);
    expect(format).toBe('pdf');
    expect(t('pm_export')).toBe('Export now');
    expect(selectionBar()).toBeNull();
  });

  it('alerts the export error instead of reporting success', async () => {
    mocks.exportPendingConversation.mockResolvedValue({ success: false, error: 'boom' });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const runner = createExportRunner({ site: fakeSite(fakeCollector(renderMessages())) });

    const running = runner.run({ format: ExportFormat.JSON }, { dict, lang: 'en' });
    await until(() => selectionBar() !== null);
    clickBarAction('selectAll');
    clickBarAction('export');
    await settle(running);

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(mocks.reportFinishedExport).not.toHaveBeenCalled();
  });

  it('warns and reports missing turns with a fresh health recheck', async () => {
    const missing = vi.spyOn(nativeHealthReporter, 'reportMissing');
    const found = vi.spyOn(nativeHealthReporter, 'reportFound');
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const collector = fakeCollector([]);
    const runner = createExportRunner({ site: fakeSite(collector) });

    await settle(runner.run({ format: ExportFormat.MARKDOWN }, { dict, lang: 'en' }));

    expect(alertSpy).toHaveBeenCalledWith('export_dialog_warning');
    expect(found).not.toHaveBeenCalled();
    expect(missing).toHaveBeenCalledWith(
      'export',
      expect.objectContaining({ route: 'conversation' }),
    );
    const probe = missing.mock.calls[0][1];
    expect(probe.recheck()).toBe(false);
    collector.collectChatPairs = () => [
      { user: 'Loaded later', assistant: '', starred: false, turnId: '1' },
    ];
    expect(probe.recheck()).toBe(true);
    expect(selectionBar()).toBeNull();
    expect(mocks.exportPendingConversation).not.toHaveBeenCalled();
  });

  it('cancel dismisses the selection and ends the run without exporting', async () => {
    const runner = createExportRunner({ site: fakeSite(fakeCollector(renderMessages())) });

    const running = runner.run({ format: ExportFormat.JSON }, { dict, lang: 'en' });
    await until(() => selectionBar() !== null);
    runner.cancel();
    await settle(running);

    expect(selectionBar()).toBeNull();
    expect(document.querySelector('.gv-export-msg-selector')).toBeNull();
    expect(mocks.exportPendingConversation).not.toHaveBeenCalled();
  });

  it('waits for the source preparation and keeps its resources until selection is cancelled', async () => {
    const collector = fakeCollector([]);
    const release = vi.fn();
    let completePreparation: () => void = () => {};
    const site = fakeSite(collector);
    const prepare = () =>
      new Promise<ExportTurnSession>((resolve) => {
        completePreparation = () => {
          collector.collectSelectionMessages = () => renderMessages();
          resolve(preparedSession(collector, release));
        };
      });
    const runner = createExportRunner({ site: { ...site, turns: { ...site.turns, prepare } } });

    const running = runner.run({ format: ExportFormat.JSON }, { dict, lang: 'en' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(selectionBar()).toBeNull();
    completePreparation();
    await until(() => selectionBar() !== null);
    expect(release).not.toHaveBeenCalled();

    runner.cancel();
    await settle(running);
    expect(release).toHaveBeenCalledTimes(1);
    expect(selectionBar()).toBeNull();
    expect(mocks.exportPendingConversation).not.toHaveBeenCalled();
  });

  it('a new run replaces the selection of the previous one', async () => {
    mocks.exportPendingConversation.mockResolvedValue({ success: true });
    const runner = createExportRunner({ site: fakeSite(fakeCollector(renderMessages())) });

    const first = runner.run({ format: ExportFormat.JSON }, { dict, lang: 'en' });
    await until(() => selectionBar() !== null);
    const second = runner.run({ format: ExportFormat.MARKDOWN }, { dict, lang: 'en' });
    await settle(first);
    await until(() => selectionBar() !== null);
    expect(document.querySelectorAll('[data-gv-export-select-bar="true"]')).toHaveLength(1);

    clickBarAction('selectAll');
    clickBarAction('export');
    await settle(second);

    expect(mocks.exportPendingConversation).toHaveBeenCalledTimes(1);
    expect(mocks.exportPendingConversation.mock.calls[0][0]).toMatchObject({
      format: ExportFormat.MARKDOWN,
    });
  });

  it('stays silent when preparation is cancelled', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const runner = createExportRunner({ site: fakeSite(fakeCollector(renderMessages())) });

    await settle(
      runner.run({ format: ExportFormat.JSON }, { dict, lang: 'en' }, async () => {
        throw new DOMException('Export cancelled', 'AbortError');
      }),
    );

    expect(errorSpy).not.toHaveBeenCalled();
    expect(selectionBar()).toBeNull();
  });
});

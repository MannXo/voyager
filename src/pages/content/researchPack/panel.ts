/**
 * Research Pack panel: a floating launcher plus a side panel that lists the
 * pack, edits the instruction, previews the Markdown and offers the actions.
 *
 * All page-derived text (answers, titles, links) is written with
 * `textContent` / `value`, never `innerHTML`. Styles live in
 * `public/contentStyle.css` under `gv-rp-`.
 */
import { safeHttpUrl } from '@/features/researchPack/services/citations';
import { platformLabel } from '@/features/researchPack/services/markdown';
import type { ResearchPack, ResearchPackItem } from '@/features/researchPack/services/types';
import type { TranslationKey } from '@/utils/translations';

import { createPromptRowSurfaces } from '../prompt/promptRowConfirm';

export interface ResearchPackPanelActions {
  onMove: (id: string, delta: number) => void;
  onRemove: (id: string) => void;
  onInstructionChange: (instruction: string) => void;
  onCopy: () => void;
  onDownload: () => void;
  onInsert: () => void;
  onClear: () => void;
}

export interface ResearchPackPanel {
  readonly root: HTMLElement;
  render: (pack: ResearchPack, markdown: string) => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** Feedback in the panel's status line, or as a toast by the launcher while closed. */
  notify: (message: string, tone?: 'ok' | 'error') => void;
  /** Re-read every label after a language change. */
  relabel: () => void;
  destroy: () => void;
}

const INSTRUCTION_SAVE_DELAY_MS = 400;
const STATUS_CLEAR_DELAY_MS = 3500;
const SNIPPET_CHARS = 220;

type Translate = (key: TranslationKey) => string;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function snippet(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > SNIPPET_CHARS ? `${compact.slice(0, SNIPPET_CHARS)}…` : compact;
}

function format(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.split(`{${key}}`).join(String(value)),
    template,
  );
}

export function createResearchPackPanel(
  t: Translate,
  actions: ResearchPackPanelActions,
): ResearchPackPanel {
  const root = el('div', 'gv-rp-root');

  const launcher = el('button', 'gv-rp-launcher');
  launcher.type = 'button';
  launcher.hidden = true;
  const launcherLabel = el('span', 'gv-rp-launcher-label');
  const launcherCount = el('span', 'gv-rp-launcher-count');
  launcher.append(launcherLabel, launcherCount);

  const panel = el('section', 'gv-rp-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');

  const header = el('header', 'gv-rp-header');
  const title = el('h2', 'gv-rp-title');
  const count = el('span', 'gv-rp-count');
  const closeButton = el('button', 'gv-rp-icon-btn gv-rp-close', '×');
  closeButton.type = 'button';
  header.append(title, count, closeButton);

  const empty = el('p', 'gv-rp-empty');
  const list = el('ol', 'gv-rp-list');

  const instructionLabel = el('label', 'gv-rp-label');
  instructionLabel.htmlFor = 'gv-rp-instruction';
  const instruction = el('textarea', 'gv-rp-instruction');
  instruction.id = 'gv-rp-instruction';
  instruction.rows = 3;

  const preview = el('details', 'gv-rp-preview');
  const previewSummary = el('summary', 'gv-rp-preview-summary');
  const markdownView = el('pre', 'gv-rp-markdown');
  markdownView.tabIndex = 0;
  preview.append(previewSummary, markdownView);

  const status = el('p', 'gv-rp-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const footer = el('footer', 'gv-rp-actions');
  const insertButton = el('button', 'gv-rp-btn gv-rp-btn-primary');
  const copyButton = el('button', 'gv-rp-btn');
  const downloadButton = el('button', 'gv-rp-btn');
  const clearButton = el('button', 'gv-rp-btn gv-rp-btn-quiet');
  for (const button of [insertButton, copyButton, downloadButton, clearButton]) {
    button.type = 'button';
  }
  footer.append(insertButton, copyButton, downloadButton, clearButton);

  const body = el('div', 'gv-rp-body');
  body.append(empty, list, instructionLabel, instruction, preview);
  panel.append(header, body, status, footer);
  const toast = el('div', 'gv-rp-toast');
  toast.hidden = true;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  root.append(launcher, toast, panel);

  const confirmSurfaces = createPromptRowSurfaces();
  let currentPack: ResearchPack | null = null;
  let instructionTimer: ReturnType<typeof setTimeout> | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  const flushInstruction = (): void => {
    if (instructionTimer === null) return;
    clearTimeout(instructionTimer);
    instructionTimer = null;
    actions.onInstructionChange(instruction.value);
  };

  const syncLauncher = (): void => {
    const itemCount = currentPack?.items.length ?? 0;
    launcherCount.textContent = String(itemCount);
    launcher.hidden = itemCount === 0 || !panel.hidden;
  };

  const open = (): void => {
    panel.hidden = false;
    toast.hidden = true;
    syncLauncher();
    closeButton.focus({ preventScroll: true });
  };

  const close = (): void => {
    flushInstruction();
    confirmSurfaces.close();
    panel.hidden = true;
    syncLauncher();
  };

  const renderItem = (item: ResearchPackItem, position: number, total: number): HTMLLIElement => {
    const row = el('li', 'gv-rp-item');
    row.dataset.itemId = item.id;

    const head = el('div', 'gv-rp-item-head');
    head.append(el('span', 'gv-rp-item-index', `${position + 1}`));
    const sourceText = item.sourceTitle || t('researchPackUntitledSource');
    const href = safeHttpUrl(item.sourceUrl);
    if (href) {
      const source = el('a', 'gv-rp-item-source', sourceText);
      source.href = href;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.title = href;
      head.append(source);
    } else {
      head.append(el('span', 'gv-rp-item-source', sourceText));
    }
    if (item.excerpt) head.append(el('span', 'gv-rp-badge', t('researchPackExcerptBadge')));

    const text = el('p', 'gv-rp-item-snippet', snippet(item.text));
    const meta = el(
      'p',
      'gv-rp-item-meta',
      `${platformLabel(item.platform)} · ${format(t('researchPackSourceCount'), {
        count: item.citations.length,
      })}`,
    );

    const controls = el('div', 'gv-rp-item-actions');
    const up = el('button', 'gv-rp-icon-btn', '↑');
    const down = el('button', 'gv-rp-icon-btn', '↓');
    const remove = el('button', 'gv-rp-icon-btn', '×');
    for (const [button, label] of [
      [up, t('researchPackMoveUp')],
      [down, t('researchPackMoveDown')],
      [remove, t('researchPackRemove')],
    ] as const) {
      button.type = 'button';
      button.setAttribute('aria-label', label);
      button.title = label;
    }
    up.disabled = position === 0;
    down.disabled = position === total - 1;
    up.addEventListener('click', () => actions.onMove(item.id, -1));
    down.addEventListener('click', () => actions.onMove(item.id, 1));
    remove.addEventListener('click', () => actions.onRemove(item.id));
    controls.append(up, down, remove);

    row.append(head, text, meta, controls);
    return row;
  };

  const relabel = (): void => {
    launcher.setAttribute('aria-label', t('researchPackOpen'));
    launcher.title = t('researchPackOpen');
    launcherLabel.textContent = t('researchPackShortTitle');
    panel.setAttribute('aria-label', t('researchPackTitle'));
    title.textContent = t('researchPackTitle');
    closeButton.setAttribute('aria-label', t('researchPackClose'));
    closeButton.title = t('researchPackClose');
    empty.textContent = t('researchPackEmpty');
    instructionLabel.textContent = t('researchPackInstructionLabel');
    instruction.placeholder = t('researchPackInstructionPlaceholder');
    previewSummary.textContent = t('researchPackPreview');
    insertButton.textContent = t('researchPackInsert');
    insertButton.title = t('researchPackInsertHint');
    copyButton.textContent = t('researchPackCopy');
    downloadButton.textContent = t('researchPackDownload');
    clearButton.textContent = t('researchPackClear');
    if (currentPack) {
      count.textContent = format(t('researchPackItemCount'), { count: currentPack.items.length });
    }
  };

  const render = (pack: ResearchPack, markdown: string): void => {
    currentPack = pack;
    count.textContent = format(t('researchPackItemCount'), { count: pack.items.length });
    const hasItems = pack.items.length > 0;
    empty.hidden = hasItems;
    list.replaceChildren(
      ...pack.items.map((item, index) => renderItem(item, index, pack.items.length)),
    );
    if (document.activeElement !== instruction && instructionTimer === null) {
      instruction.value = pack.instruction;
    }
    markdownView.textContent = markdown;
    for (const button of [insertButton, copyButton, downloadButton, clearButton]) {
      button.disabled = !hasItems;
    }
    syncLauncher();
  };

  const notify = (message: string, tone: 'ok' | 'error' = 'ok'): void => {
    const target = panel.hidden ? toast : status;
    status.textContent = '';
    toast.hidden = true;
    target.textContent = message;
    target.dataset.tone = tone;
    if (target === toast) toast.hidden = false;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      status.textContent = '';
      toast.hidden = true;
    }, STATUS_CLEAR_DELAY_MS);
  };

  launcher.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || confirmSurfaces.isOpen()) return;
    event.stopPropagation();
    close();
    if (!launcher.hidden) launcher.focus({ preventScroll: true });
  });
  instruction.addEventListener('input', () => {
    if (instructionTimer !== null) clearTimeout(instructionTimer);
    instructionTimer = setTimeout(() => {
      instructionTimer = null;
      actions.onInstructionChange(instruction.value);
    }, INSTRUCTION_SAVE_DELAY_MS);
  });
  instruction.addEventListener('blur', flushInstruction);
  insertButton.addEventListener('click', () => {
    flushInstruction();
    actions.onInsert();
  });
  copyButton.addEventListener('click', () => {
    flushInstruction();
    actions.onCopy();
  });
  downloadButton.addEventListener('click', () => {
    flushInstruction();
    actions.onDownload();
  });
  clearButton.addEventListener('click', () => {
    confirmSurfaces.openConfirm({
      anchor: clearButton,
      message: t('researchPackClearConfirm'),
      confirmLabel: t('researchPackClear'),
      cancelLabel: t('pm_cancel'),
      onConfirm: actions.onClear,
    });
  });

  relabel();

  return {
    root,
    render,
    open,
    close,
    isOpen: () => !panel.hidden,
    notify,
    relabel,
    destroy: () => {
      flushInstruction();
      if (statusTimer !== null) clearTimeout(statusTimer);
      statusTimer = null;
      confirmSurfaces.destroy();
      root.remove();
    },
  };
}

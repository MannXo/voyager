/**
 * Voyager's one confirm: a card with the message above the actions, opened next
 * to the control that asked. It answers the question and nothing more; what
 * happened afterwards is reported through the toast.
 */
import { getTranslationSync } from '@/utils/i18n';

import confirmCss from './confirm.css?raw';
import { type Popover, type PopoverSide, openPopover } from './layer';

export type ConfirmChoice<C extends string> = {
  readonly id: C;
  readonly label: string;
  /** Default `primary`. A danger confirm paints its primary choice red. */
  readonly emphasis?: 'primary' | 'secondary';
};

export type ConfirmRequest<C extends string> = {
  readonly message: string;
  readonly anchor: HTMLElement;
  /** Default `below`; it flips when the viewport has no room. */
  readonly side?: PopoverSide;
  /** A danger confirm focuses Cancel, so Enter right after opening it never destroys. */
  readonly tone: 'danger' | 'neutral';
  /** Rendered after Cancel, in order. */
  readonly choices: readonly [ConfirmChoice<C>, ...ConfirmChoice<C>[]];
  /** Default: the shared Cancel label. */
  readonly cancelLabel?: string;
  /** The owner's lifetime: aborting answers null and removes the card. */
  readonly signal?: AbortSignal;
  /** Where focus goes afterwards when the anchor is about to disappear. */
  readonly returnFocus?: HTMLElement | null;
};

let current: { popover: Popover; settle: (answer: null) => void } | null = null;

/**
 * Ask, and resolve the chosen id, or null on Cancel, Escape, an outside press, a
 * scroll that moves the anchor, an aborted signal, or a newer confirm.
 */
export function askConfirm<C extends string = 'confirm'>(
  request: ConfirmRequest<C>,
): Promise<C | null> {
  current?.popover.close();
  current?.settle(null);
  current = null;
  if (request.signal?.aborted) return Promise.resolve(null);

  return new Promise<C | null>((resolve) => {
    let settled = false;
    const settle = (answer: C | null): void => {
      if (settled) return;
      settled = true;
      if (current?.popover === popover) current = null;
      resolve(answer);
    };

    const popover = openPopover({
      anchor: request.anchor,
      side: request.side ?? 'below',
      css: confirmCss,
      returnFocus: request.returnFocus,
      signal: request.signal,
      onDismiss: () => settle(null),
    });

    const card = document.createElement('div');
    card.className = 'gv-confirm';
    card.dataset.tone = request.tone;
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-labelledby', 'gv-confirm-message');
    const message = document.createElement('p');
    message.className = 'gv-confirm-message';
    message.id = 'gv-confirm-message';
    message.dir = 'auto';
    message.textContent = request.message;
    const actions = document.createElement('div');
    actions.className = 'gv-confirm-actions';

    const button = (
      label: string,
      emphasis: 'cancel' | 'primary' | 'secondary',
      answer: C | null,
    ) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'gv-confirm-button';
      element.dataset.emphasis = emphasis;
      element.textContent = label;
      element.addEventListener('click', () => {
        popover.close();
        settle(answer);
      });
      actions.append(element);
      return element;
    };

    const cancel = button(request.cancelLabel ?? getTranslationSync('pm_cancel'), 'cancel', null);
    const choices = request.choices.map((choice) =>
      button(choice.label, choice.emphasis ?? 'primary', choice.id),
    );
    card.append(message, actions);
    popover.root.append(card);
    popover.place();

    current = { popover, settle };
    const primary = [...choices]
      .reverse()
      .find((element) => element.dataset.emphasis === 'primary');
    const initial = request.tone === 'danger' ? cancel : (primary ?? choices[0]);
    initial.focus({ preventScroll: true });
  });
}

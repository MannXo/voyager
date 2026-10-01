/** @jsxImportSource preact */
import type { CSSProperties } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

import { eventPassedThrough } from '../shadowHost';
import { MAX_FOLDER_NAME_LENGTH, MENU_SELECTOR, cls, t } from './shared';

type IconButtonProps = {
  modifier: string;
  labelKey: string;
  text: string;
  active?: boolean;
  onClick: (e: MouseEvent) => void;
};

export function IconButton({ modifier, labelKey, text, active, onClick }: IconButtonProps) {
  const label = t(labelKey);
  const classes = [cls('icon-button'), cls(`icon-button--${modifier}`)];
  if (active) classes.push(cls('icon-button--active'));
  return (
    <button
      type="button"
      class={classes.join(' ')}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {text}
    </button>
  );
}

type InlineFormProps = {
  initialValue: string;
  extraClass?: string;
  style?: CSSProperties;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

// The panel lives in a shadow root, where a document listener sees the host as
// the target; the composed path still names the real element.
function isInsideContextMenu(e: Event): boolean {
  return e.composedPath().some((node) => node instanceof Element && node.matches(MENU_SELECTOR));
}

/**
 * Name editor for create and rename. A mousedown anywhere outside it (except the
 * context menu) cancels. The listener lives exactly as long as the form is
 * mounted, so re-rendering the tree around it keeps it working.
 */
export function InlineForm({
  initialValue,
  extraClass,
  style,
  onSubmit,
  onCancel,
}: InlineFormProps) {
  const formRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => onSubmit(inputRef.current?.value.trim() ?? '');

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const focusInput = () => {
      input.focus();
      input.select();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(focusInput);
    } else {
      focusInput();
    }
  }, []);

  // Re-registered when the handler changes, and removed on unmount.
  useLayoutEffect(() => {
    const form = formRef.current;
    if (!form) return;
    const onOutsideMouseDown = (e: MouseEvent) => {
      if (eventPassedThrough(e, form) || isInsideContextMenu(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };
    document.addEventListener('mousedown', onOutsideMouseDown, true);
    return () => document.removeEventListener('mousedown', onOutsideMouseDown, true);
  }, [onCancel]);

  const classes = extraClass ? `${cls('inline-form')} ${extraClass}` : cls('inline-form');
  return (
    <div ref={formRef} class={classes} style={style}>
      <input
        ref={inputRef}
        type="text"
        class={cls('inline-input')}
        // Uncontrolled: the initial name seeds it, and re-renders leave the draft alone.
        defaultValue={initialValue}
        placeholder={t('floatingPanelFolderNamePlaceholder')}
        maxLength={MAX_FOLDER_NAME_LENGTH}
        onClick={(e) => e.stopPropagation()}
        onDblClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <IconButton
        modifier="save"
        labelKey="floatingPanelSave"
        text="✓"
        onClick={(e) => {
          e.stopPropagation();
          submit();
        }}
      />
      <IconButton
        modifier="cancel"
        labelKey="floatingPanelCancel"
        text="×"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
      />
    </div>
  );
}

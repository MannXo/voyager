/**
 * AI Studio's inline create/rename folder editors, and keeping an unfinished
 * one alive while the folder list is rebuilt (for example after another tab's
 * write reloads the data).
 */

export type InlineFolderEditor = {
  wrapper: HTMLElement;
  input: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
};

const CREATE_DRAFT_CLASS = 'gv-folder-inline-input';
const RENAME_DRAFT_CLASS = 'gv-folder-rename-inline';
const DRAFT_SELECTOR = `.${CREATE_DRAFT_CLASS}, .${RENAME_DRAFT_CLASS}`;

export function createInlineMaterialIcon(name: string): HTMLElement {
  const icon = document.createElement('mat-icon');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-hidden', 'true');
  icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
  icon.textContent = name;
  return icon;
}

export function createInlineFolderEditor(
  t: (key: string) => string,
  wrapperTag: 'div' | 'span',
  wrapperClassName: typeof CREATE_DRAFT_CLASS | typeof RENAME_DRAFT_CLASS,
  inputClassName: string,
  inputOptions: { placeholder?: string; value?: string; folderId?: string | null } = {},
): InlineFolderEditor {
  const wrapper = document.createElement(wrapperTag);
  wrapper.className = wrapperClassName;
  // The folder renamed, or the parent of a new subfolder. Recorded, not read from
  // the DOM: a collapsed parent has no content box, so its draft sits after it.
  if (inputOptions.folderId) wrapper.dataset.draftFolderId = inputOptions.folderId;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = inputClassName;
  input.maxLength = 50;
  if (inputOptions.placeholder) input.placeholder = inputOptions.placeholder;
  if (inputOptions.value) input.value = inputOptions.value;

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'gv-folder-inline-btn gv-folder-inline-save';
  saveBtn.title = t('pm_save');
  saveBtn.appendChild(createInlineMaterialIcon('check'));

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'gv-folder-inline-btn gv-folder-inline-cancel';
  cancelBtn.title = t('pm_cancel');
  cancelBtn.appendChild(createInlineMaterialIcon('close'));

  wrapper.appendChild(input);
  wrapper.appendChild(saveBtn);
  wrapper.appendChild(cancelBtn);

  return { wrapper, input, saveBtn, cancelBtn };
}

type HeldDraft = {
  wrapper: HTMLElement;
  input: HTMLInputElement | null;
  folderId: string | null;
  focused: boolean;
  start: number | null;
  end: number | null;
};

/**
 * Keeps unfinished editors alive while the folder list is rebuilt. Whether a
 * draft survives is decided by the model: one whose folder (the renamed one, or
 * a new subfolder's parent) is gone is dropped. One whose folder still exists
 * but is not rendered, because an ancestor is collapsed, is held and put back,
 * with its text, once the folder is visible again.
 */
export class InlineDraftHolder {
  private held: HeldDraft[] = [];

  /** Take the open editors out of `list` before it is rebuilt. */
  detach(list: HTMLElement): void {
    for (const wrapper of list.querySelectorAll<HTMLElement>(DRAFT_SELECTOR)) {
      const input = wrapper.querySelector('input');
      this.held.push({
        wrapper,
        input,
        folderId: wrapper.dataset.draftFolderId ?? null,
        focused: input !== null && document.activeElement === input,
        start: input?.selectionStart ?? null,
        end: input?.selectionEnd ?? null,
      });
      wrapper.remove();
    }
  }

  /** Put held editors back beside their rendered folder, restoring focus and selection. */
  restore(list: HTMLElement, folderExists: (folderId: string) => boolean): void {
    const hidden: HeldDraft[] = [];
    for (const draft of this.held) {
      if (draft.folderId && !folderExists(draft.folderId)) continue;
      if (!placeDraft(list, draft.wrapper, draft.folderId)) {
        hidden.push({ ...draft, focused: false });
        continue;
      }
      if (!draft.focused || !draft.input) continue;
      draft.input.focus();
      if (draft.start !== null && draft.end !== null) {
        draft.input.setSelectionRange(draft.start, draft.end);
      }
    }
    this.held = hidden;
  }

  /** Discard every editor, e.g. when the account they were opened for is released. */
  discard(root: ParentNode | null | undefined): void {
    this.held = [];
    root?.querySelectorAll(DRAFT_SELECTOR).forEach((draft) => draft.remove());
  }
}

/** Place a draft beside its folder; false when that folder is not rendered. */
function placeDraft(list: HTMLElement, wrapper: HTMLElement, folderId: string | null): boolean {
  const folder = folderId ? list.querySelector(`[data-folder-id="${folderId}"]`) : null;
  if (folderId && !folder) return false;
  if (wrapper.classList.contains(RENAME_DRAFT_CLASS)) {
    const header = folder?.querySelector('.gv-folder-item-header');
    const name = folder?.querySelector('.gv-folder-name');
    if (!header || !name) return false;
    name.classList.add('gv-hidden');
    header.classList.add('gv-folder-editing');
    header.insertBefore(wrapper, name.nextSibling);
    return true;
  }
  const content = folder?.querySelector('.gv-folder-content');
  if (content) content.insertBefore(wrapper, content.firstChild);
  else if (folder) folder.insertAdjacentElement('afterend', wrapper);
  else list.insertBefore(wrapper, list.firstChild);
  return true;
}

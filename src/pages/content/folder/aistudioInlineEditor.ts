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
  inputOptions: { placeholder?: string; value?: string } = {},
): InlineFolderEditor {
  const wrapper = document.createElement(wrapperTag);
  wrapper.className = wrapperClassName;

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

/** Discard unfinished editors, e.g. when the account they were opened for is released. */
export function removeInlineDrafts(root: ParentNode | null | undefined): void {
  root?.querySelectorAll(DRAFT_SELECTOR).forEach((draft) => draft.remove());
}

/**
 * Take unfinished editors out of `list` before it is rebuilt. The returned
 * callback puts the same nodes, with their text, listeners, focus and
 * selection, back beside their folder; one whose folder is gone is dropped.
 */
export function detachInlineDrafts(list: HTMLElement): () => void {
  const drafts = Array.from(list.querySelectorAll<HTMLElement>(DRAFT_SELECTOR), (wrapper) => {
    const input = wrapper.querySelector('input');
    return {
      wrapper,
      input,
      folderId: wrapper.closest<HTMLElement>('[data-folder-id]')?.dataset.folderId ?? null,
      focused: input !== null && document.activeElement === input,
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
    };
  });
  drafts.forEach(({ wrapper }) => wrapper.remove());

  return () => {
    for (const { wrapper, input, folderId, focused, start, end } of drafts) {
      if (!placeDraft(list, wrapper, folderId) || !focused || !input) continue;
      input.focus();
      if (start !== null && end !== null) input.setSelectionRange(start, end);
    }
  };
}

function placeDraft(list: HTMLElement, wrapper: HTMLElement, folderId: string | null): boolean {
  const folder = folderId ? list.querySelector(`[data-folder-id="${folderId}"]`) : null;
  if (wrapper.classList.contains(RENAME_DRAFT_CLASS)) {
    const header = folder?.querySelector('.gv-folder-item-header');
    const name = folder?.querySelector('.gv-folder-name');
    if (!header || !name) return false;
    name.classList.add('gv-hidden');
    header.classList.add('gv-folder-editing');
    header.insertBefore(wrapper, name.nextSibling);
    return true;
  }
  if (folderId && !folder) return false; // its parent folder is gone
  const content = folder?.querySelector('.gv-folder-content');
  if (content) content.insertBefore(wrapper, content.firstChild);
  else if (folder) folder.insertAdjacentElement('afterend', wrapper);
  else list.insertBefore(wrapper, list.firstChild);
  return true;
}

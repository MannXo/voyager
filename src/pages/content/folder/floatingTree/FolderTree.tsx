/** @jsxImportSource preact */
import { render } from 'preact';

import { getFolderDepth, sortConversationsByPriority } from '@/features/folder/model/folderData';

import { getFolderColor, isDarkMode } from '../folderColors';
import type { ConversationReference, Folder } from '../types';
import { ContextMenu } from './ContextMenu';
import { IconButton, InlineForm } from './controls';
import {
  type ConversationDragData,
  type TreeProps,
  canCreateChildAtDepth,
  cls,
  getFolderChildren,
  readConversationDragData,
  t,
} from './shared';

const DROP_TARGET = cls('drop-target');
const DRAGGING = cls('conv--dragging');

function EmptyState() {
  return (
    <div class={cls('empty')}>
      <svg class={cls('empty-icon')} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.75 6.5c0-.69.56-1.25 1.25-1.25h4.16c.36 0 .69.15.93.41l1.12 1.23c.14.15.34.24.55.24H18c.69 0 1.25.56 1.25 1.25v1.12H4.75v-3Zm0 4.25h14.5v6.75c0 .69-.56 1.25-1.25 1.25H6c-.69 0-1.25-.56-1.25-1.25v-6.75Z" />
      </svg>
      <div class={cls('empty-label')}>{t('floatingPanelEmpty')}</div>
    </div>
  );
}

type CreateFormProps = {
  tree: TreeProps;
  parentId: string | null;
  extraClass?: string;
  indent?: number;
};

function CreateFolderForm({ tree, parentId, extraClass, indent }: CreateFormProps) {
  const parentDepth = parentId ? getFolderDepth(tree.data, parentId) : -1;
  return (
    <InlineForm
      initialValue=""
      extraClass={extraClass}
      style={indent === undefined ? undefined : { paddingInlineStart: `${indent}px` }}
      onSubmit={(name) =>
        tree.apply({ inlineEditor: null }, () => {
          if (name && canCreateChildAtDepth(parentDepth)) {
            tree.actions.onCreateFolder?.(name, parentId);
          }
        })
      }
      onCancel={() => tree.apply({ inlineEditor: null })}
    />
  );
}

type ConversationRowProps = {
  tree: TreeProps;
  conv: ConversationReference;
  folderId: string;
  depth: number;
};

function ConversationRow({ tree, conv, folderId, depth }: ConversationRowProps) {
  const untitled = t('floatingPanelUntitled');
  const remove = () => tree.actions.onRemoveConversation?.(folderId, conv.conversationId);
  return (
    <div
      class={cls('conv')}
      style={{ paddingInlineStart: `${24 + depth * 12}px` }}
      data-folder-id={folderId}
      data-conversation-id={conv.conversationId}
      draggable
      onDragStart={(e) => {
        const payload: ConversationDragData = {
          type: 'conversation',
          conversationId: conv.conversationId,
          sourceFolderId: folderId,
        };
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('application/json', JSON.stringify(payload));
          e.dataTransfer.setData('text/plain', conv.title || untitled);
        }
        e.currentTarget.classList.add(DRAGGING);
      }}
      onDragEnd={(e) => e.currentTarget.classList.remove(DRAGGING)}
    >
      <button
        type="button"
        class={cls('conv-title')}
        title={conv.title || ''}
        onClick={(e) => {
          e.stopPropagation();
          tree.actions.onNavigate?.(conv);
        }}
      >
        {conv.title || untitled}
      </button>
      <IconButton
        modifier="star"
        labelKey={
          conv.starred ? 'floatingPanelUnstarConversation' : 'floatingPanelStarConversation'
        }
        text={conv.starred ? '★' : '☆'}
        active={conv.starred}
        onClick={(e) => {
          e.stopPropagation();
          tree.actions.onToggleStar?.(folderId, conv.conversationId);
        }}
      />
      <IconButton
        modifier="remove"
        labelKey="floatingPanelRemoveConversation"
        text="×"
        onClick={(e) => {
          e.stopPropagation();
          const confirm = tree.actions.confirmConversationRemoval;
          if (confirm) confirm(conv.title || untitled, e.currentTarget as HTMLElement, remove);
          else remove();
        }}
      />
    </div>
  );
}

type FolderNodeProps = { tree: TreeProps; folder: Folder; depth: number };

function FolderNode({ tree, folder, depth }: FolderNodeProps) {
  const { data, inlineEditor, apply, actions } = tree;
  const expanded = tree.isExpanded(folder);
  const childConversations = data.folderContents[folder.id] ?? [];
  const childFolders = getFolderChildren(data, folder.id);
  const renaming = inlineEditor?.mode === 'rename' && inlineEditor.folderId === folder.id;
  const creatingChild = inlineEditor?.mode === 'create' && inlineEditor.parentId === folder.id;
  const toggle = () => apply({ expand: { folderId: folder.id, expanded: !expanded } });

  const onHeaderClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(`.${cls('inline-form')}`)) return;
    if (target.closest(`.${cls('icon-button')}`)) return;
    if (target.closest(`.${cls('caret')}`)) return;
    e.stopPropagation();
    toggle();
  };

  // HTML5 quirk: `dataTransfer.getData(...)` returns "" during dragover for
  // security, so we can't read the payload here — we can only inspect the
  // MIME-type list via `dataTransfer.types`. If our payload type is present
  // we accept the drop *visually*, and the drop handler re-reads and validates
  // the full payload (including rejecting same-folder drops).
  const onDragOver = (e: DragEvent & { currentTarget: HTMLElement }) => {
    const types = e.dataTransfer?.types;
    if (!types || !Array.from(types).includes('application/json')) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add(DROP_TARGET);
  };

  const onDrop = (e: DragEvent & { currentTarget: HTMLElement }) => {
    e.currentTarget.classList.remove(DROP_TARGET);
    const payload = readConversationDragData(e);
    if (!payload || payload.sourceFolderId === folder.id) return;
    e.preventDefault();
    e.stopPropagation();
    actions.onMoveConversation?.(payload.conversationId, payload.sourceFolderId, folder.id);
  };

  return (
    // Depth is exposed as a custom property so the body's ::before tree-guide
    // line can sit under this folder's caret, one level at a time.
    <div
      class={cls('folder')}
      data-depth={String(depth)}
      style={{ '--gv-folder-depth': String(depth) }}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- row click is a mouse shortcut for the caret button, which carries keyboard access */}
      <div
        class={cls('folder-header')}
        style={{ paddingInlineStart: `${8 + depth * 12}px` }}
        data-folder-id={folder.id}
        onClick={onHeaderClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          apply({
            inlineEditor: null,
            contextMenu: {
              folderId: folder.id,
              x: e.clientX,
              y: e.clientY,
              confirmingDelete: false,
            },
          });
        }}
        onDragOver={onDragOver}
        onDragLeave={(e) => e.currentTarget.classList.remove(DROP_TARGET)}
        onDrop={onDrop}
      >
        <button
          type="button"
          class={cls('caret')}
          aria-label={t(expanded ? 'floatingPanelCollapseFolder' : 'floatingPanelExpandFolder')}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span
          class={cls('folder-color')}
          style={{ backgroundColor: getFolderColor(folder.color, isDarkMode()) }}
        />
        <span class={cls('folder-name-wrap')}>
          {renaming ? (
            <InlineForm
              key={`rename:${folder.id}`}
              initialValue={folder.name}
              onSubmit={(newName) =>
                apply({ inlineEditor: null }, () => {
                  if (newName && newName !== folder.name)
                    actions.onRenameFolder?.(folder.id, newName);
                })
              }
              onCancel={() => apply({ inlineEditor: null })}
            />
          ) : (
            <span
              class={cls('folder-name')}
              title={folder.name}
              onDblClick={(e) => {
                e.stopPropagation();
                apply({ inlineEditor: { mode: 'rename', folderId: folder.id }, contextMenu: null });
              }}
            >
              {folder.name}
            </span>
          )}
        </span>
        <span class={cls('pin')} aria-hidden="true">
          {folder.pinned ? '●' : ''}
        </span>
        <span class={cls('count')}>{childConversations.length + childFolders.length}</span>
        {/* Always occupy the trailing "+ add subfolder" slot so rows at
            different depths line up; at MAX_FOLDER_DEPTH an invisible
            placeholder keeps the count badge in the same position. */}
        {canCreateChildAtDepth(depth) ? (
          <IconButton
            modifier="add-child"
            labelKey="floatingPanelCreateSubfolder"
            text="+"
            onClick={(e) => {
              e.stopPropagation();
              apply({
                expand: { folderId: folder.id, expanded: true },
                inlineEditor: { mode: 'create', parentId: folder.id },
                contextMenu: null,
              });
            }}
          />
        ) : (
          <span
            class={`${cls('icon-button')} ${cls('icon-button--placeholder')}`}
            aria-hidden="true"
          />
        )}
      </div>
      <div class={cls('folder-body')} style={expanded ? undefined : { display: 'none' }}>
        {creatingChild && (
          <CreateFolderForm
            key={`create:${folder.id}`}
            tree={tree}
            parentId={folder.id}
            indent={32 + depth * 12}
          />
        )}
        {childFolders.map((child) => (
          <FolderNode key={child.id} tree={tree} folder={child} depth={depth + 1} />
        ))}
        {sortConversationsByPriority(childConversations, tree.conversationSortMode).map((conv) => (
          <ConversationRow
            key={conv.conversationId}
            tree={tree}
            conv={conv}
            folderId={folder.id}
            depth={depth}
          />
        ))}
      </div>
    </div>
  );
}

export function FolderTree(tree: TreeProps) {
  const { data, inlineEditor, rootBucketId } = tree;
  const creatingRoot = inlineEditor?.mode === 'create' && inlineEditor.parentId === null;
  const rootConversations = data.folderContents[rootBucketId] ?? [];

  if (
    data.folders.length === 0 &&
    rootConversations.length === 0 &&
    inlineEditor?.mode !== 'create'
  ) {
    return <EmptyState />;
  }

  return (
    <>
      {creatingRoot && (
        <CreateFolderForm
          key="create:root"
          tree={tree}
          parentId={null}
          extraClass={cls('inline-form--root')}
        />
      )}
      {/* Like the sidebar: conversations filed at the root come first. */}
      {sortConversationsByPriority(rootConversations, tree.conversationSortMode).map((conv) => (
        <ConversationRow
          key={`${rootBucketId}:${conv.conversationId}`}
          tree={tree}
          conv={conv}
          folderId={rootBucketId}
          depth={-1}
        />
      ))}
      {getFolderChildren(data, null).map((folder) => (
        <FolderNode key={folder.id} tree={tree} folder={folder} depth={0} />
      ))}
      <ContextMenu {...tree} />
    </>
  );
}

/** Renders the tree into `container`, diffing against what is there; `null` unmounts it. */
export function renderFolderTree(container: HTMLElement, tree: TreeProps | null): void {
  render(tree ? <FolderTree {...tree} /> : null, container);
}

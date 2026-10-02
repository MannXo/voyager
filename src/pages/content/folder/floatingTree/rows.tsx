/** @jsxImportSource preact */
import type { ItemInstance } from '@headless-tree/core';

import { getFolderDepth } from '@/features/folder/model/folderData';

import { getFolderColor, isDarkMode } from '../folderColors';
import { IconButton, InlineForm } from './controls';
import type { ConversationNode, FolderNode } from './projection';
import {
  type ConversationDragData,
  type TreeProps,
  acceptsDrag,
  canCreateChildAtDepth,
  cls,
  readConversationDragData,
  t,
} from './shared';

const DROP_TARGET = cls('drop-target');
const DRAGGING = cls('conv--dragging');

type DropEvent = DragEvent & { currentTarget: HTMLElement };
type Ref = (element: Element | null) => void;

/** A click that opens in place: no Ctrl, Meta or Shift, which ask for something else. */
export function isPlainClick(e: MouseEvent): boolean {
  return !e.ctrlKey && !e.metaKey && !e.shiftKey;
}

/** Dragover, dragleave and drop handlers that file a conversation into `folderId`. */
export function dropHandlers(tree: TreeProps, folderId: string) {
  const { actions } = tree;
  // Nested targets: the innermost one takes the drag, and its ancestors stay unlit.
  const nested = !!tree.site?.folderBodyDrop;
  return {
    // HTML5 quirk: `dataTransfer.getData(...)` returns "" during dragover for
    // security, so we can't read the payload here — we can only inspect the
    // MIME-type list via `dataTransfer.types`. If our payload type is present
    // we accept the drop *visually*, and the drop handler re-reads and validates
    // the full payload (including rejecting same-folder drops).
    onDragOver: (e: DropEvent) => {
      const types = e.dataTransfer?.types;
      if (!types || !acceptsDrag(actions, Array.from(types))) return;
      e.preventDefault();
      if (nested) e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add(DROP_TARGET);
    },
    onDragLeave: (e: DropEvent) => {
      const into = e.relatedTarget;
      if (nested && into instanceof Node && e.currentTarget.contains(into)) return;
      e.currentTarget.classList.remove(DROP_TARGET);
    },
    onDrop: (e: DropEvent) => {
      e.currentTarget.classList.remove(DROP_TARGET);
      if (nested) e.stopPropagation();
      if (actions.onDrop) {
        e.preventDefault();
        e.stopPropagation();
        actions.onDrop(e, folderId);
        return;
      }
      const payload = readConversationDragData(e);
      if (!payload || payload.sourceFolderId === folderId) return;
      e.preventDefault();
      e.stopPropagation();
      actions.onMoveConversation?.(payload.conversationId, payload.sourceFolderId, folderId);
    },
  };
}

/**
 * The accessibility and focus props Headless Tree gives a row. Its click
 * handler is left out: rows handle clicks themselves, and a modifier click must
 * not run the primary action.
 */
function treeItemProps(item: ItemInstance<string>) {
  const meta = item.getItemMeta();
  return {
    ref: item.registerElement,
    role: 'treeitem' as const,
    'aria-level': meta.level + 1,
    'aria-setsize': meta.setSize,
    'aria-posinset': meta.posInSet + 1,
    'aria-expanded': item.isFolder() ? item.isExpanded() : undefined,
    'aria-label': item.getItemName() || undefined,
    tabIndex: item.isFocused() ? 0 : -1,
    // Focus that lands in a row by pointer or Tab makes it the tabbable row.
    onFocusIn: () => {
      if (item.getTree().getState().focusedItem !== item.getId()) item.setFocused();
    },
  };
}

/** Attributes of the shell every row renders in: indexed for the virtualizer, drawing its folders' guides. */
function rowShell(
  index: number,
  guides: number,
  options: { extraClass?: string; hidden?: boolean } = {},
) {
  const { extraClass, hidden } = options;
  return {
    class: extraClass ? `${cls('tree-row')} ${extraClass}` : cls('tree-row'),
    'data-index': String(index),
    'data-guides': guides > 0 ? '' : undefined,
    guideStyle: hidden
      ? { '--gv-tree-guides': String(guides), display: 'none' }
      : { '--gv-tree-guides': String(guides) },
  };
}

export function EmptyState() {
  return (
    <div class={cls('empty')}>
      <svg class={cls('empty-icon')} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4.75 6.5c0-.69.56-1.25 1.25-1.25h4.16c.36 0 .69.15.93.41l1.12 1.23c.14.15.34.24.55.24H18c.69 0 1.25.56 1.25 1.25v1.12H4.75v-3Zm0 4.25h14.5v6.75c0 .69-.56 1.25-1.25 1.25H6c-.69 0-1.25-.56-1.25-1.25v-6.75Z" />
      </svg>
      <div class={cls('empty-label')}>{t('floatingPanelEmpty')}</div>
    </div>
  );
}

type CreateRowProps = {
  tree: TreeProps;
  parentId: string | null;
  index: number;
  measure?: Ref;
  /** Under a collapsed folder: kept mounted so the draft survives, but not shown. */
  hidden?: boolean;
};

/** The name field for a new folder, under its parent's row or at the top for a root folder. */
export function CreateFolderRow({ tree, parentId, index, measure, hidden }: CreateRowProps) {
  const parentDepth = parentId ? getFolderDepth(tree.data, parentId) : -1;
  const shell = rowShell(index, parentDepth + 1, { hidden });
  const drops = parentId && tree.site?.folderBodyDrop ? dropHandlers(tree, parentId) : {};
  return (
    <div
      class={shell.class}
      data-index={shell['data-index']}
      data-guides={shell['data-guides']}
      ref={measure}
      style={shell.guideStyle}
      {...drops}
    >
      <InlineForm
        initialValue=""
        extraClass={parentId === null ? cls('inline-form--root') : undefined}
        style={parentId === null ? undefined : { paddingInlineStart: `${32 + parentDepth * 12}px` }}
        onSubmit={(name) =>
          tree.apply({ inlineEditor: null }, () => {
            if (name && canCreateChildAtDepth(parentDepth)) {
              tree.actions.onCreateFolder?.(name, parentId);
            }
          })
        }
        onCancel={() => tree.apply({ inlineEditor: null })}
      />
    </div>
  );
}

type ItemRowProps<N> = {
  tree: TreeProps;
  node: N;
  item: ItemInstance<string>;
  index: number;
  measure?: Ref;
  /** A folder whose rename is open under a collapsed parent: mounted, not shown. */
  hidden?: boolean;
};

export function ConversationRow({
  tree,
  node,
  item,
  index,
  measure,
}: ItemRowProps<ConversationNode>) {
  const { conversation: conv, bucketId, folderDepth } = node;
  const untitled = t('floatingPanelUntitled');
  const remove = () => tree.actions.onRemoveConversation?.(bucketId, conv.conversationId);
  const active =
    !!tree.site?.activeConversationId && tree.site.activeConversationId === conv.conversationId;
  const shell = rowShell(index, folderDepth + 1);
  // With folder-body drops, a row is part of its folder's block and takes the
  // drop for that folder. A root row has no folder block.
  const drops =
    tree.site?.folderBodyDrop && bucketId !== tree.rootBucketId ? dropHandlers(tree, bucketId) : {};
  return (
    <div
      class={shell.class}
      data-index={shell['data-index']}
      data-guides={shell['data-guides']}
      ref={measure}
      style={shell.guideStyle}
    >
      <div
        {...treeItemProps(item)}
        class={active ? `${cls('conv')} ${cls('conv--active')}` : cls('conv')}
        style={{ paddingInlineStart: `${24 + folderDepth * 12}px` }}
        data-folder-id={bucketId}
        data-conversation-id={conv.conversationId}
        draggable
        onDragStart={(e) => {
          const payload: ConversationDragData = {
            type: 'conversation',
            conversationId: conv.conversationId,
            sourceFolderId: bucketId,
          };
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('application/json', JSON.stringify(payload));
            e.dataTransfer.setData('text/plain', conv.title || untitled);
          }
          e.currentTarget.classList.add(DRAGGING);
        }}
        onDragEnd={(e) => e.currentTarget.classList.remove(DRAGGING)}
        {...drops}
      >
        <button
          type="button"
          class={cls('conv-title')}
          // Its own direction, so a name in the other script truncates at its end.
          dir="auto"
          title={conv.title || ''}
          aria-current={active ? 'page' : undefined}
          onClick={(e) => {
            e.stopPropagation();
            if (isPlainClick(e)) tree.actions.onNavigate?.(conv);
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
            tree.actions.onToggleStar?.(bucketId, conv.conversationId);
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
    </div>
  );
}

export function FolderRow({ tree, node, item, index, measure, hidden }: ItemRowProps<FolderNode>) {
  const { inlineEditor, apply, actions } = tree;
  const { folder, depth } = node;
  const expanded = tree.isExpanded(folder);
  const renaming = inlineEditor?.mode === 'rename' && inlineEditor.folderId === folder.id;
  const toggle = () => apply({ expand: { folderId: folder.id, expanded: !expanded } });
  const menuButton = tree.site?.folderMenuButton;
  const shell = rowShell(index, depth, { extraClass: cls('folder'), hidden });

  const onHeaderClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest(`.${cls('inline-form')}`)) return;
    if (target.closest(`.${cls('icon-button')}`)) return;
    if (target.closest(`.${cls('caret')}`)) return;
    e.stopPropagation();
    if (isPlainClick(e)) toggle();
  };

  return (
    // Depth is exposed as a custom property, as the panel stylesheet reads it.
    <div
      class={shell.class}
      data-index={shell['data-index']}
      data-guides={shell['data-guides']}
      ref={measure}
      data-depth={String(depth)}
      style={{ ...shell.guideStyle, '--gv-folder-depth': String(depth) }}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- a treeitem (role from Headless Tree's props): Enter and the arrow keys reach it through the tree's hotkeys */}
      <div
        {...treeItemProps(item)}
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
        {...dropHandlers(tree, folder.id)}
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
              // `folder` is the record the form opened on, maybe stale; the
              // controller compares the name with live data.
              onSubmit={(newName) =>
                apply({ inlineEditor: null }, () => {
                  if (newName) actions.onRenameFolder?.(folder.id, newName);
                })
              }
              onCancel={() => apply({ inlineEditor: null })}
            />
          ) : (
            <span
              class={cls('folder-name')}
              dir="auto"
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
        <span class={cls('count')}>{node.count}</span>
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
        {menuButton && (
          <IconButton
            modifier="menu"
            labelKey={menuButton.labelKey}
            text="⋮"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              apply({
                inlineEditor: null,
                contextMenu: {
                  folderId: folder.id,
                  x: rect.left,
                  y: rect.bottom,
                  anchor: { width: rect.width, height: rect.height },
                  confirmingDelete: false,
                  // Enter or Space on the button: a click with no pointer.
                  ...(e.detail === 0 ? { fromKeyboard: true } : {}),
                },
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

type RootDropRowProps = { tree: TreeProps; index: number; measure?: Ref };

/** AI Studio's drop strip for filing at the root, shown even with no folders. */
export function RootDropRow({ tree, index, measure }: RootDropRowProps) {
  const shell = rowShell(index, 0);
  return (
    <div class={shell.class} data-index={shell['data-index']} ref={measure}>
      <div
        class={cls('root-drop')}
        data-folder-id={tree.rootBucketId}
        {...dropHandlers(tree, tree.rootBucketId)}
      />
    </div>
  );
}

/** The heading over AI Studio's root conversations, which follow it as rows. */
export function RootTitleRow({
  tree,
  labelKey,
  index,
  measure,
}: RootDropRowProps & { labelKey: string }) {
  const shell = rowShell(index, 0);
  return (
    <div class={shell.class} data-index={shell['data-index']} ref={measure}>
      <div class={cls('root-section')}>
        <div
          class={cls('root-section-title')}
          data-folder-id={tree.rootBucketId}
          {...dropHandlers(tree, tree.rootBucketId)}
        >
          {t(labelKey)}
        </div>
      </div>
    </div>
  );
}

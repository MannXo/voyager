import { extractRouteUserIdFromPath } from '@/core/services/AccountIsolationService';
import type { ConversationSortMode } from '@/features/folder/model/folderData';
import { getTranslationSyncUnsafe as t } from '@/utils/i18n';

import type { FolderFeedback } from './FolderFeedback';
import type { FolderNavigation } from './FolderNavigation';
import type { FolderSidebarRuntime } from './FolderSidebarRuntime';
import type { FolderStore } from './FolderStore';
import type { NativeConversationMenus } from './NativeConversationMenus';
import {
  extractConversationData,
  extractConversationId,
  extractNativeDragTitle,
  getNativeConversationElements,
} from './nativeSidebarDom';
import type { ConversationReference, DragData } from './types';

interface FolderSelectionOptions {
  store: FolderStore;
  runtime: FolderSidebarRuntime;
  navigation: FolderNavigation;
  feedback: FolderFeedback;
  nativeMenus: NativeConversationMenus;
  getContext(): {
    sortMode: ConversationSortMode;
    accountIsolationEnabled: boolean;
    isDestroyed: boolean;
  };
  /** Folder chats joined or left the selection: the tree shows them again. */
  onFolderSelectionChange(): void;
}

function debug(level: 'log' | 'warn', ...args: unknown[]): void {
  try {
    if (localStorage.getItem('gvFolderDebug') === '1') console[level]('[FolderManager]', ...args);
  } catch {
    /* Debugging must not affect interaction. */
  }
}

/** Shares selection, drag state and batch actions across native and folder rows. */
export class FolderSelection {
  private selectedConversations: Set<string> = new Set();
  private isMultiSelectMode: boolean = false;
  private multiSelectSource: 'folder' | 'native' | null = null;
  private multiSelectFolderId: string | null = null;
  private longPressTimeout: number | null = null;
  private longPressThreshold: number = 500;
  /** A long press on a folder chat entered multi-select; its click must not navigate. */
  /** The folder chat whose long press entered multi-select; its own release click is swallowed. */
  private longPressRow: { conversationId: string; folderId: string } | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private readonly MAX_BATCH_DELETE_COUNT = 50;
  private batchDeleteController: AbortController | null = null;
  private readonly BATCH_DELETE_CONFIG = {
    DELAY_BETWEEN_DELETIONS: 500, // Delay between each deletion to avoid rate limiting
    PAGE_REFRESH_DELAY: 1500, // Delay before refreshing page after batch delete
  } as const;
  private multiSelectHostElement: HTMLElement | null = null;
  private readonly toolbarCleanups = new Map<HTMLElement, () => void>();
  private readonly timers = new Set<number>();
  private readonly dragImages = new Set<HTMLElement>();

  constructor(private readonly options: FolderSelectionOptions) {}

  private schedule(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer);
      if (!this.options.getContext().isDestroyed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: number): void {
    window.clearTimeout(timer);
    this.timers.delete(timer);
  }

  /** Restore retained selection after the replacement panel and its rows are mounted. */
  mount(): void {
    if (this.options.getContext().isDestroyed) return;
    if (this.options.runtime.panel?.isConnected) this.removeFloatingHost();
    this.updateConversationSelectionUI();
  }

  /** Remove listeners attached to the old toolbar during a sidebar remount. */
  unmount(): void {
    for (const cleanup of this.toolbarCleanups.values()) cleanup();
    this.toolbarCleanups.clear();
  }

  removeFloatingHost(): void {
    for (const [indicator, cleanup] of this.toolbarCleanups) {
      if (this.multiSelectHostElement?.contains(indicator)) {
        cleanup();
        this.toolbarCleanups.delete(indicator);
      }
    }
    this.multiSelectHostElement?.remove();
    this.multiSelectHostElement = null;
  }

  reset(): void {
    if (this.batchDeleteController) {
      this.batchDeleteController.abort();
      this.batchDeleteController = null;
      this.options.feedback.hideBatchDeleteProgress();
    }
    for (const timer of this.timers) window.clearTimeout(timer);
    this.timers.clear();
    for (const image of this.dragImages) image.remove();
    this.dragImages.clear();
    if (this.longPressTimeout !== null) this.clearTimer(this.longPressTimeout);
    this.longPressTimeout = null;
    this.exitMultiSelectMode();
    this.removeFloatingHost();
  }

  createMultiSelectIndicator(): HTMLElement {
    const indicator = document.createElement('div');
    indicator.className = 'gv-multi-select-indicator';
    indicator.dataset.multiSelectIndicator = 'true';

    // Apply floating styles
    Object.assign(indicator.style, {
      position: 'fixed',
      bottom: '24px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '9999', // Ensure it's above everything
      boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
      cursor: 'move', // Indicate it's draggable
      transition: 'opacity 0.2s ease, transform 0.1s ease', // Only animate non-position props for performance
      // Prevent text selection while dragging
      userSelect: 'none',
      // Ensure it has a background so IT covers content behind it
      backgroundColor: 'var(--gem-sys-color-surface-container, #f0f4f9)', // Fallback color
      borderRadius: '24px',
      padding: '8px 16px',
      alignItems: 'center',
      gap: '12px',
      border: '1px solid var(--gem-sys-color-outline-variant, rgba(0,0,0,0.1))',
    });

    // --- Draggable Logic Start ---
    let isDragging = false;
    let currentX: number;
    let currentY: number;
    let initialX: number;
    let initialY: number;
    let xOffset = 0;
    let yOffset = 0;

    // Document-level mousemove/mouseup are attached only while a drag is in
    // progress (mousedown → mouseup). Attaching them permanently leaked one
    // listener pair per floating-mode/sidebar-mode switch, because that switch
    // path rebuilds the indicator without running the cleanup task list.
    const drag = (e: MouseEvent) => {
      if (isDragging) {
        e.preventDefault();
        currentX = e.clientX - initialX;
        currentY = e.clientY - initialY;

        xOffset = currentX;
        yOffset = currentY;

        setTranslate(currentX, currentY, indicator);
      }
    };

    const dragEnd = () => {
      isDragging = false;
      indicator.style.cursor = 'move';
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    };

    const dragStart = (e: MouseEvent) => {
      // Ignore if clicking buttons inside the indicator
      if ((e.target as HTMLElement).closest('button')) return;

      initialX = e.clientX - xOffset;
      initialY = e.clientY - yOffset;

      if (e.target === indicator || indicator.contains(e.target as Node)) {
        isDragging = true;
        indicator.style.cursor = 'grabbing';
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', dragEnd);
      }
    };

    const setTranslate = (xPos: number, yPos: number, el: HTMLElement) => {
      el.style.transform = `translate3d(calc(-50% + ${xPos}px), ${yPos}px, 0)`;
    };

    indicator.addEventListener('mousedown', dragStart);

    // Belt-and-suspenders: if the indicator is torn down mid-drag, make sure
    // the document-level listeners can't outlive it. removeEventListener is
    // idempotent, so this is safe even when no drag is active.
    this.toolbarCleanups.set(indicator, () => {
      indicator.removeEventListener('mousedown', dragStart);
      document.removeEventListener('mousemove', drag);
      document.removeEventListener('mouseup', dragEnd);
    });
    // --- Draggable Logic End ---

    const content = document.createElement('div');
    content.className = 'gv-multi-select-indicator-content';
    // Ensure content (text/icon) doesn't capture drag events aggressively
    content.style.pointerEvents = 'none';

    const icon = document.createElement('mat-icon');
    icon.className = 'mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'check_circle';

    const text = document.createElement('span');
    text.className = 'gv-multi-select-indicator-text';
    text.textContent = '0 selected';
    text.dataset.selectionCount = 'true';

    content.appendChild(icon);
    content.appendChild(text);
    indicator.appendChild(content);

    // Actions container (will be populated dynamically)
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'gv-multi-select-actions';
    actionsContainer.dataset.multiSelectActions = 'true';
    // Re-enable pointer events for buttons
    actionsContainer.style.pointerEvents = 'auto';
    indicator.appendChild(actionsContainer);

    return indicator;
  }

  private getMultiSelectHost(): HTMLElement | null {
    if (this.options.runtime.panel?.isConnected) {
      return this.options.runtime.panel;
    }

    if (!this.multiSelectHostElement?.isConnected) {
      const host = document.createElement('div');
      host.className = 'gv-folder-container gv-multi-select-floating-host';
      host.dataset.multiSelectFloatingHost = 'true';
      host.appendChild(this.createMultiSelectIndicator());
      document.body.appendChild(host);
      this.multiSelectHostElement = host;
    }

    return this.multiSelectHostElement;
  }

  private getExistingMultiSelectHost(): HTMLElement | null {
    if (this.options.runtime.panel?.isConnected) {
      return this.options.runtime.panel;
    }

    return this.multiSelectHostElement?.isConnected ? this.multiSelectHostElement : null;
  }

  makeConversationDraggable(element: HTMLElement): void {
    // Idempotency guard — the method can legitimately be called more than once
    // per element (e.g. sidebar success path + document sweep on fallback,
    // MutationObserver re-entry, route change re-scans). Without this guard
    // we'd stack duplicate mousedown / dragstart listeners on every call.
    if (element.dataset.gvConvDragAttached === 'true') return;
    element.dataset.gvConvDragAttached = 'true';

    element.draggable = true;
    element.style.cursor = 'grab';

    // Long-press detection for entering multi-select mode
    let longPressTriggered = false;
    let longPressTimeoutId: number | null = null;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // Only left mouse button
      longPressTriggered = false;

      const conversationId = extractConversationId(element);

      longPressTimeoutId = this.schedule(() => {
        longPressTriggered = true;
        this.enterMultiSelectMode(conversationId, 'native');
        // Add visual feedback to this element
        element.classList.add('gv-conversation-selected');
      }, this.longPressThreshold);
    };

    const handleMouseUp = () => {
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    const handleMouseLeave = () => {
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }
    };

    // Add event listeners
    element.addEventListener('mousedown', handleMouseDown);
    element.addEventListener('mouseup', handleMouseUp);
    element.addEventListener('mouseleave', handleMouseLeave);

    // Click handler for multi-select mode
    element.addEventListener(
      'click',
      (e) => {
        // Never swallow clicks on the trailing ⋮ menu button — those need to
        // open the per-row actions menu (rename / delete / move / etc.).
        // Without this guard, our capture-phase stopPropagation below silently
        // kills the menu trigger during programmatic batch-delete (the
        // moreButton.click() never reaches Material's menu, so the menu never
        // opens and waitForDeleteButtonAndClick times out at 3s every row).
        if (
          e.target instanceof Element &&
          e.target.closest(
            '[data-test-id="actions-menu-button"], [data-test-id="conversation-actions-menu-icon-button"]',
          )
        ) {
          return;
        }

        // Programmatic batch delete drives Gemini's own menu via .click() — let
        // every click through unimpeded for the duration of the batch.
        if (this.batchDeleteController) {
          return;
        }

        // Prevent navigation if long-press was triggered
        if (longPressTriggered) {
          e.preventDefault();
          e.stopPropagation();
          longPressTriggered = false;
          return;
        }

        if (this.isMultiSelectMode) {
          // Multi-select mode: toggle selection
          e.preventDefault();
          e.stopPropagation();
          const conversationId = extractConversationId(element);
          this.toggleConversationSelection(conversationId);

          // Update visual state
          if (this.selectedConversations.has(conversationId)) {
            element.classList.add('gv-conversation-selected');
          } else {
            element.classList.remove('gv-conversation-selected');
          }

          this.updateConversationSelectionUI();
          return;
        }
      },
      true,
    ); // Use capture phase to intercept before navigation

    element.addEventListener('dragstart', (e) => {
      const conversationId = extractConversationId(element);
      const title = extractNativeDragTitle(element, conversationId);

      // Extract URL and conversation metadata together
      const conversationData = extractConversationData(
        element,
        this.options.getContext().accountIsolationEnabled,
      );

      // Restrict to move-only to prevent Chrome from triggering split-screen/tab tiling
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';

      // If this conversation is not selected, select it exclusively
      if (!this.selectedConversations.has(conversationId)) {
        this.clearSelection();
        this.selectConversation(conversationId);
        element.classList.add('gv-conversation-selected');
        this.updateConversationSelectionUI();
      }

      // Cancel long press if drag starts
      if (longPressTimeoutId) {
        this.clearTimer(longPressTimeoutId);
        longPressTimeoutId = null;
      }

      // Check if we have multiple selections
      if (this.selectedConversations.size > 1) {
        // Multi-select drag - collect all selected conversations
        const selectedConvs: ConversationReference[] = [];

        this.selectedConversations.forEach((id) => {
          const convEl = this.findConversationElement(id);
          if (convEl) {
            const convTitle = extractNativeDragTitle(convEl, id);
            const convData = extractConversationData(
              convEl,
              this.options.getContext().accountIsolationEnabled,
            );

            selectedConvs.push({
              conversationId: id,
              title: convTitle,
              url: convData.url,
              addedAt: Date.now(),
              isGem: convData.isGem,
              gemId: convData.gemId,
            });
          }
        });

        const dragData: DragData = {
          type: 'conversation',
          title: `${selectedConvs.length} conversations`,
          conversations: selectedConvs,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, `${selectedConvs.length} conversations`);

        // Apply opacity to all selected conversations
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '0.5';
        });
      } else {
        // Single conversation drag (legacy behavior)
        debug('log', 'Drag start:', {
          title,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
          url: conversationData.url,
        });

        const dragData: DragData = {
          type: 'conversation',
          conversationId,
          title,
          url: conversationData.url,
          isGem: conversationData.isGem,
          gemId: conversationData.gemId,
        };

        e.dataTransfer?.setData('application/json', JSON.stringify(dragData));
        this.setLightweightDragImage(e, title);
        element.style.opacity = '0.5';
      }
    });

    element.addEventListener('dragend', () => {
      // Restore opacity for all selected conversations
      if (this.selectedConversations.size > 1) {
        this.selectedConversations.forEach((id) => {
          const el = this.findConversationElement(id);
          if (el) el.style.opacity = '1';
        });
      } else {
        element.style.opacity = '1';
      }

      // If we are not in multi-select mode, clear the temporary selection
      if (!this.isMultiSelectMode) {
        this.clearSelection();
        this.cleanupSelectionArtifacts();
      }
    });
  }

  private findConversationElement(conversationId: string): HTMLElement | null {
    // Check in folder conversations
    const folderConv = this.options.runtime.panel?.querySelector(
      `[data-conversation-id="${conversationId}"]`,
    ) as HTMLElement;
    if (folderConv) return folderConv;

    // Check in native conversations (Recent section)
    const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
    for (const conv of Array.from(nativeConvs)) {
      const id = extractConversationId(conv as HTMLElement);
      if (id === conversationId) {
        return conv as HTMLElement;
      }
    }

    return null;
  }

  private setLightweightDragImage(event: DragEvent, label: string): void {
    const transfer = event.dataTransfer;
    if (!transfer || typeof transfer.setDragImage !== 'function') return;

    const dragImage = document.createElement('div');
    dragImage.className = 'gv-folder-drag-image';
    dragImage.textContent = label;
    document.body.appendChild(dragImage);

    try {
      transfer.setDragImage(dragImage, 12, 12);
    } catch {
      dragImage.remove();
      return;
    }

    this.dragImages.add(dragImage);
    this.schedule(() => {
      dragImage.remove();
      this.dragImages.delete(dragImage);
    }, 0);
  }

  private batchDeleteConversations(): void {
    if (!this.multiSelectFolderId || this.selectedConversations.size === 0) return;

    const count = this.selectedConversations.size;
    const confirmed = confirm(t('folder_batch_remove_confirm').replace('{count}', String(count)));

    if (!confirmed) return;

    // Remove all selected conversations from the folder
    const folderId = this.multiSelectFolderId;
    if (!this.options.store.data.folderContents[folderId]) return;

    this.options.store.removeConversationsFromFolder(folderId, this.selectedConversations);

    // Exit multi-select mode and refresh
    this.exitMultiSelectMode();
    debug('log', `Batch deleted ${count} conversations from folder ${folderId}`);
  }

  private async batchDeleteNativeConversations(): Promise<void> {
    if (this.options.getContext().isDestroyed) return;
    if (this.batchDeleteController) {
      debug('log', 'Batch delete already in progress');
      return;
    }

    const count = this.selectedConversations.size;
    if (count === 0) return;

    // Show confirmation dialog
    const confirmMessage = t('batch_delete_confirm').replace('{count}', String(count));
    const confirmed = confirm(confirmMessage);
    if (!confirmed) return;

    const controller = new AbortController();
    this.batchDeleteController = controller;
    const activation = this.options.store.activation;
    const routeUserId = extractRouteUserIdFromPath(window.location.pathname) ?? '0';
    const isCurrent = () =>
      !controller.signal.aborted &&
      !this.options.getContext().isDestroyed &&
      this.options.store.activation === activation &&
      (extractRouteUserIdFromPath(window.location.pathname) ?? '0') === routeUserId;
    const conversationIds = Array.from(this.selectedConversations);
    let successCount = 0;
    let failedCount = 0;

    try {
      // Show progress indicator
      this.options.feedback.showBatchDeleteProgress(0, count);

      for (let i = 0; i < conversationIds.length; i++) {
        if (!isCurrent()) return;
        const conversationId = conversationIds[i];
        debug('log', `Deleting conversation ${i + 1}/${count}: ${conversationId}`);

        // Update progress
        this.options.feedback.updateBatchDeleteProgress(i + 1, count);

        try {
          const success = await this.options.nativeMenus.deleteConversation(
            conversationId,
            controller.signal,
          );
          if (!isCurrent()) return;
          if (success) {
            successCount++;
          } else {
            failedCount++;
            debug('warn', `Failed to delete conversation: ${conversationId}`);
          }
        } catch (error) {
          failedCount++;
          console.error(`[FolderManager] Error deleting conversation ${conversationId}:`, error);
        }

        // Add delay between deletions to avoid rate limiting
        if (i < conversationIds.length - 1) {
          await this.delay(this.BATCH_DELETE_CONFIG.DELAY_BETWEEN_DELETIONS, controller.signal);
        }
      }

      if (!isCurrent()) return;

      // Show result summary
      if (failedCount === 0) {
        const successMessage = t('batch_delete_success').replace('{count}', String(successCount));
        this.options.feedback.showNotification(successMessage, 'success');
      } else {
        const partialMessage = t('batch_delete_partial')
          .replace('{success}', String(successCount))
          .replace('{failed}', String(failedCount));
        this.options.feedback.showNotification(partialMessage, 'info');
      }

      // Exit multi-select mode
      this.exitMultiSelectMode();

      // Refresh page after deletion
      if (successCount > 0) {
        debug('log', 'Refreshing page after batch delete');
        this.schedule(() => {
          if (isCurrent()) window.location.reload();
        }, this.BATCH_DELETE_CONFIG.PAGE_REFRESH_DELAY);
      }
    } finally {
      if (this.batchDeleteController === controller) {
        this.batchDeleteController = null;
        this.options.feedback.hideBatchDeleteProgress();
      }
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const finish = () => {
        window.clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  private clearSelection(): void {
    this.selectedConversations.clear();
  }

  private selectConversation(conversationId: string): void {
    this.selectedConversations.add(conversationId);
  }

  private toggleConversationSelection(conversationId: string): void {
    if (this.selectedConversations.has(conversationId)) {
      this.selectedConversations.delete(conversationId);

      // Auto-exit multi-select mode when all selections are cleared
      if (this.selectedConversations.size === 0 && this.isMultiSelectMode) {
        this.exitMultiSelectMode();
        return;
      }
    } else {
      // Check if we've reached the maximum selection limit
      if (this.selectedConversations.size >= this.MAX_BATCH_DELETE_COUNT) {
        const message = t('batch_delete_limit_reached').replace(
          '{max}',
          String(this.MAX_BATCH_DELETE_COUNT),
        );
        this.options.feedback.showNotification(message, 'info');
        return;
      }
      this.selectedConversations.add(conversationId);
    }
  }

  private updateConversationSelectionUI(): void {
    // Only update UI for the source where multi-select was initiated
    if (this.multiSelectSource === 'folder') {
      this.options.onFolderSelectionChange();
    } else if (this.multiSelectSource === 'native') {
      // Only update native conversation elements (Recent section)
      const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
      nativeConvs.forEach((el) => {
        const convId = extractConversationId(el as HTMLElement);
        if (convId) {
          if (this.selectedConversations.has(convId)) {
            el.classList.add('gv-conversation-selected');
          } else {
            el.classList.remove('gv-conversation-selected');
          }
        }
      });
    }

    // Update the selection count
    this.updateMultiSelectModeUI();
  }

  private enterMultiSelectMode(
    initialConversationId?: string,
    source: 'folder' | 'native' = 'native',
    folderId?: string,
  ): void {
    debug('log', 'Entering multi-select mode', { source, folderId });
    this.isMultiSelectMode = true;
    this.multiSelectSource = source;
    this.multiSelectFolderId = folderId || null;

    // Select the conversation that triggered the long-press
    if (initialConversationId) {
      this.selectConversation(initialConversationId);
    }

    this.updateMultiSelectModeUI();
    this.updateConversationSelectionUI();

    // Add visual feedback (vibration on mobile)
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    // Add click-outside listener to exit multi-select mode
    this.setupOutsideClickHandler();
  }

  private exitMultiSelectMode(): void {
    debug('log', 'Exiting multi-select mode');
    this.isMultiSelectMode = false;
    this.multiSelectSource = null;
    this.multiSelectFolderId = null;

    // Remove click-outside listener
    this.removeOutsideClickHandler();

    // First update UI to remove selection styles
    this.updateConversationSelectionUI();

    // Then clear the selection set
    this.clearSelection();

    // Update mode UI
    this.updateMultiSelectModeUI();

    // Force cleanup of any remaining visual artifacts
    this.cleanupSelectionArtifacts();
  }

  private setupOutsideClickHandler(): void {
    // Remove any existing handler first
    this.removeOutsideClickHandler();

    this.outsideClickHandler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Check if click is inside the sidebar or folder container
      const isInsideSidebar =
        this.options.runtime.sidebar?.contains(target) ||
        !!target.closest('[data-test-id="overflow-container"]');
      const isInsideFolderContainer = this.options.runtime.panel?.contains(target);
      const isInsideMultiSelectHost = this.multiSelectHostElement?.contains(target);

      // Check if click is on an overlay (menus, dialogs, etc.)
      const isOnOverlay = target.closest('.cdk-overlay-container, .mat-mdc-dialog-container');

      // If click is outside all relevant areas, exit multi-select mode
      if (
        !isInsideSidebar &&
        !isInsideFolderContainer &&
        !isInsideMultiSelectHost &&
        !isOnOverlay
      ) {
        debug('log', 'Click outside sidebar detected, exiting multi-select mode');
        this.exitMultiSelectMode();
      }
    };

    // Use setTimeout to avoid the current click event from triggering the handler
    this.schedule(() => {
      document.addEventListener('click', this.outsideClickHandler!, true);
    }, 0);
  }

  private removeOutsideClickHandler(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
  }

  private cleanupSelectionArtifacts(): void {
    // Remove selection classes from all native conversations
    const nativeConvs = getNativeConversationElements(this.options.runtime.sidebar);
    nativeConvs.forEach((el) => {
      (el as HTMLElement).classList.remove('gv-conversation-selected');
      (el as HTMLElement).style.opacity = '1';
    });
    // Folder chats render from the selection; show them unselected.
    this.options.onFolderSelectionChange();

    // Restore active conversation highlight in folders
    // This ensures that the currently active conversation remains highlighted
    // after drag-and-drop or multi-select operations
    this.options.navigation.highlightActiveConversation();
  }

  private showInvalidSelectionFeedback(element: HTMLElement): void {
    // Remove existing class (if any) to allow animation restart on rapid clicks
    element.classList.remove('gv-invalid-selection');

    // Force reflow to ensure animation restarts (see: CSS Triggers)
    void element.offsetWidth;

    // Add invalid selection class to trigger animation
    element.classList.add('gv-invalid-selection');

    // Listen for animation end to clean up the class automatically
    // Using { once: true } ensures the listener is removed after first invocation
    element.addEventListener(
      'animationend',
      () => {
        element.classList.remove('gv-invalid-selection');
      },
      { once: true },
    );

    // Optional: Haptic feedback on mobile devices
    if ('vibrate' in navigator) {
      navigator.vibrate([30, 20, 30]); // Two short vibrations
    }
  }

  private updateMultiSelectModeUI(): void {
    const multiSelectHost = this.isMultiSelectMode
      ? this.getMultiSelectHost()
      : this.getExistingMultiSelectHost();

    // Add or remove multi-select mode class from container
    if (this.isMultiSelectMode) {
      multiSelectHost?.classList.add('gv-multi-select-mode');
    } else {
      multiSelectHost?.classList.remove('gv-multi-select-mode');
    }

    // Update selection count in indicator
    const countElement = multiSelectHost?.querySelector('[data-selection-count="true"]');
    if (countElement) {
      const count = this.selectedConversations.size;
      countElement.textContent = t('folder_multi_select_count').replace('{count}', String(count));
    }

    // Update action buttons based on source
    const actionsContainer = multiSelectHost?.querySelector('[data-multi-select-actions="true"]');
    if (actionsContainer && this.isMultiSelectMode) {
      actionsContainer.innerHTML = ''; // Clear existing buttons

      if (this.multiSelectSource === 'folder') {
        // Delete button for folder multi-select (removes from folder only)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteConversations());
        actionsContainer.appendChild(deleteBtn);
      } else if (this.multiSelectSource === 'native') {
        // Delete button for native multi-select (deletes from Gemini)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'gv-multi-select-action-btn gv-multi-select-delete-btn';
        deleteBtn.innerHTML =
          '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">delete</mat-icon>';
        deleteBtn.title = t('batch_delete_button');
        deleteBtn.addEventListener('click', () => this.batchDeleteNativeConversations());
        actionsContainer.appendChild(deleteBtn);
      }

      // Exit button (always present)
      const exitBtn = document.createElement('button');
      exitBtn.className = 'gv-multi-select-action-btn gv-multi-select-exit-btn';
      exitBtn.innerHTML =
        '<mat-icon role="img" class="mat-icon notranslate google-symbols mat-ligature-font mat-icon-no-color" aria-hidden="true">close</mat-icon>';
      exitBtn.title = t('folder_multi_select_exit');
      exitBtn.addEventListener('click', () => this.exitMultiSelectMode());
      actionsContainer.appendChild(exitBtn);
    } else if (actionsContainer) {
      actionsContainer.innerHTML = ''; // Clear buttons when exiting
    }
  }

  private getSelectedConversationsData(): ConversationReference[] {
    const result: ConversationReference[] = [];
    const seen = new Set<string>();

    // Collect from all folders since selection can span folders
    for (const fId in this.options.store.data.folderContents) {
      const conversations = this.options.store.data.folderContents[fId];
      conversations.forEach((conv) => {
        if (this.selectedConversations.has(conv.conversationId) && !seen.has(conv.conversationId)) {
          seen.add(conv.conversationId);
          result.push(conv);
        }
      });
    }

    return result;
  }

  /** Whether a folder chat shows as selected: in folder multi-select, in its scoped folder. */
  isFolderConversationSelected(conversationId: string, folderId: string): boolean {
    return (
      this.multiSelectSource === 'folder' &&
      (!this.multiSelectFolderId || this.multiSelectFolderId === folderId) &&
      this.selectedConversations.has(conversationId)
    );
  }

  /** Mouse down on a folder chat starts the long press into multi-select; `null` ends it. */
  pressFolderConversation(e: MouseEvent | null, conversationId: string, folderId: string): void {
    if (this.longPressTimeout) {
      this.clearTimer(this.longPressTimeout);
      this.longPressTimeout = null;
    }
    if (!e || e.button !== 0) return;
    this.longPressRow = null;
    this.longPressTimeout = this.schedule(() => {
      this.longPressTimeout = null;
      this.longPressRow = { conversationId, folderId };
      this.enterMultiSelectMode(conversationId, 'folder', folderId);
    }, this.longPressThreshold);
  }

  /**
   * A click on a folder chat: the click that ends a long press, or one in
   * multi-select, which toggles the chat or refuses one from another folder.
   * Returns whether the selection took it; otherwise it navigates.
   */
  clickFolderConversation(conversationId: string, folderId: string, row: HTMLElement): boolean {
    const pressed = this.longPressRow;
    this.longPressRow = null;
    if (pressed?.conversationId === conversationId && pressed.folderId === folderId) return true;
    if (!this.isMultiSelectMode) return false;
    if (
      this.multiSelectSource === 'folder' &&
      this.multiSelectFolderId &&
      this.multiSelectFolderId !== folderId
    ) {
      this.showInvalidSelectionFeedback(row);
      return true;
    }
    this.toggleConversationSelection(conversationId);
    this.updateConversationSelectionUI();
    return true;
  }

  /** A folder chat drag carries every selected chat, or only itself when it is not selected. */
  startFolderConversationDrag(
    e: DragEvent,
    conversationId: string,
    folderId: string,
    title: string,
  ): void {
    e.stopPropagation();
    if (this.longPressTimeout) {
      this.clearTimer(this.longPressTimeout);
      this.longPressTimeout = null;
    }
    if (!this.selectedConversations.has(conversationId)) {
      this.clearSelection();
      this.selectConversation(conversationId);
      this.updateConversationSelectionUI();
    }
    const conversations = this.getSelectedConversationsData();
    e.dataTransfer?.setData(
      'application/json',
      JSON.stringify({ type: 'conversation', conversations, sourceFolderId: folderId }),
    );
    this.setLightweightDragImage(
      e,
      conversations.length > 1 ? `${conversations.length} conversations` : title,
    );
  }

  endFolderConversationDrag(): void {
    if (this.isMultiSelectMode) return;
    this.clearSelection();
    this.cleanupSelectionArtifacts();
  }

  /** A drop used the dragged selection. */
  finishDrop(): void {
    this.exitMultiSelectMode();
  }
}

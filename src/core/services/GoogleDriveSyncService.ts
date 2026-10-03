/** Coordinates cloud sync state and account-scoped payload transfers. */
import type { FolderData } from '@/core/types/folder';
import { isHighlightExportPayloadV1 } from '@/core/types/highlight';
import type {
  FolderExportPayload,
  ForkExportPayload,
  ForkNodesDataSync,
  HighlightExportPayload,
  PluginStateExportPayload,
  PromptExportPayload,
  PromptItem,
  SettingsExportPayload,
  StarredExportPayload,
  StarredMessagesDataSync,
  SyncAccountScope,
  SyncMode,
  SyncPlatform,
  SyncProvider,
  SyncState,
  TimelineHierarchyDataSync,
  TimelineHierarchyExportPayload,
} from '@/core/types/sync';
import { DEFAULT_SYNC_STATE } from '@/core/types/sync';
import { hashString } from '@/core/utils/hash';
import { EXTENSION_VERSION } from '@/core/utils/version';
import { FOLDER_PLATFORMS, FOLDER_PLATFORM_IDS } from '@/features/folder/platforms';
import type { PluginStateMap } from '@/features/plugins/storage/pluginState';

import { GoogleDriveAuth, isSafariRuntime } from './GoogleDriveAuth';
import { GoogleDriveBackupFolder } from './GoogleDriveBackupFolder';
import { GoogleDriveFiles } from './GoogleDriveFiles';
import { logger } from './LoggerService';

const PROMPTS_FILE_NAME = 'gemini-voyager-prompts.json';
const SETTINGS_FILE_NAME = 'gemini-voyager-settings.json';
const PLUGINS_FILE_NAME = 'gemini-voyager-plugins.json';
const STARRED_FILE_NAME = 'gemini-voyager-starred.json';
const FORKS_FILE_NAME = 'gemini-voyager-forks.json';
const TIMELINE_HIERARCHY_FILE_NAME = 'gemini-voyager-timeline-hierarchy.json';
const HIGHLIGHTS_FILE_NAME = 'gemini-voyager-highlights.json';
const BACKUP_FOLDER_RECOVERY_FILE_NAMES = [
  ...FOLDER_PLATFORM_IDS.map((platform) => FOLDER_PLATFORMS[platform].driveFoldersFileName),
  PROMPTS_FILE_NAME,
  SETTINGS_FILE_NAME,
  PLUGINS_FILE_NAME,
  STARRED_FILE_NAME,
] as const;

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function getNumberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export class GoogleDriveSyncService {
  private state: SyncState = { ...DEFAULT_SYNC_STATE };
  private stateChangeCallback: ((state: SyncState) => void) | null = null;
  private stateLoadPromise: Promise<void> | null = null;

  private readonly auth = new GoogleDriveAuth(() => this.state.provider);
  private readonly files = new GoogleDriveFiles(
    new GoogleDriveBackupFolder(BACKUP_FOLDER_RECOVERY_FILE_NAMES),
    {
      getProvider: () => this.state.provider,
      onAuthLost: () => this.updateState({ isAuthenticated: false }),
    },
  );

  constructor() {
    this.stateLoadPromise = this.loadState();
  }

  onStateChange(callback: (state: SyncState) => void): void {
    this.stateChangeCallback = callback;
  }

  /**
   * Ensure state is loaded before returning
   */
  async getState(): Promise<SyncState> {
    if (this.stateLoadPromise) {
      await this.stateLoadPromise;
    }
    return { ...this.state };
  }

  async setMode(mode: SyncMode): Promise<void> {
    this.state.mode = mode;
    await this.saveState();
    this.notifyStateChange();
  }

  async setProvider(provider: SyncProvider): Promise<void> {
    if (provider === 'icloud' && !isSafariRuntime()) {
      throw new Error('iCloud sync is available only in Safari');
    }
    if (provider === this.state.provider) return;

    await this.auth.clear();
    this.state.provider = provider;
    this.state.isAuthenticated = false;
    this.state.error = null;
    this.files.reset();
    await this.saveState();
    this.notifyStateChange();
  }

  async authenticate(interactive: boolean = true): Promise<boolean> {
    try {
      this.updateState({ isSyncing: true, error: null });
      const token = await this.auth.getToken(interactive);
      if (!token) {
        // If not interactive and no token, just return false silently
        if (!interactive) {
          this.updateState({ isAuthenticated: false, isSyncing: false });
          return false;
        }
        throw new Error('Failed to obtain auth token');
      }
      this.updateState({ isAuthenticated: true, isSyncing: false });
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
      console.error('[GoogleDriveSyncService] Authentication failed:', error);
      this.updateState({ isAuthenticated: false, isSyncing: false, error: errorMessage });
      return false;
    }
  }

  async signOut(): Promise<void> {
    if (this.state.provider === 'icloud') {
      this.updateState({ isAuthenticated: false, error: null });
      await this.saveState();
      return;
    }

    await this.auth.signOutGoogle();
    await this.auth.clear();
    this.files.reset();
    this.updateState({ isAuthenticated: false, lastSyncTime: null, error: null });
    await this.saveState();
  }

  /**
   * Upload folders, prompts, and timeline data as separate files to Google Drive
   * @param folders Folder data to upload
   * @param prompts Prompt items (only for Gemini platform)
   * @param starred Starred messages (only for Gemini platform)
   * @param interactive Whether to show auth prompt if needed
   * @param platform Platform to upload for ('gemini' | 'aistudio')
   */
  async upload(
    folders: FolderData,
    prompts: PromptItem[],
    starred: StarredMessagesDataSync | null = null,
    interactive: boolean = true,
    platform: SyncPlatform = 'gemini',
    forks: ForkNodesDataSync | null = null,
    timelineHierarchy: TimelineHierarchyDataSync | null = null,
    accountScope: SyncAccountScope | null = null,
    timelineHierarchyAccountScope: SyncAccountScope | null = null,
    settings: Record<string, unknown> | null = null,
    plugins: PluginStateMap | null = null,
  ): Promise<boolean> {
    try {
      this.updateState({ isSyncing: true, error: null });

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          logger.info(
            '[GoogleDriveSyncService] Upload skipped: Not authenticated (non-interactive)',
          );
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return false;
        }
        throw new Error('Not authenticated');
      }

      const now = new Date();

      // Create folder payload
      const folderPayload: FolderExportPayload = {
        format: 'gemini-voyager.folders.v1',
        exportedAt: now.toISOString(),
        version: EXTENSION_VERSION,
        data: folders,
      };

      // Create prompt payload
      const promptPayload: PromptExportPayload = {
        format: 'gemini-voyager.prompts.v1',
        exportedAt: now.toISOString(),
        version: EXTENSION_VERSION,
        items: prompts,
      };

      const settingsPayload: SettingsExportPayload | null = settings
        ? {
            format: 'gemini-voyager.settings.v1',
            exportedAt: now.toISOString(),
            version: EXTENSION_VERSION,
            data: settings,
          }
        : null;

      const pluginsPayload: PluginStateExportPayload | null = plugins
        ? {
            format: 'gemini-voyager.plugins.v1',
            exportedAt: now.toISOString(),
            version: EXTENSION_VERSION,
            data: plugins,
          }
        : null;

      // Upload folders file (platform-specific)
      const { driveFoldersFileName } = FOLDER_PLATFORMS[platform];
      const foldersFileName = this.getFileNameForScope(driveFoldersFileName, accountScope);
      const foldersFileIdToUse = await this.files.ensure(token, foldersFileName);
      await this.files.upload(token, foldersFileIdToUse, folderPayload);
      logger.info(`[GoogleDriveSyncService] ${platform} folders uploaded successfully`);

      // Upload prompts file (shared between Gemini and AI Studio)
      if (prompts.length > 0) {
        const promptsFileName = this.getFileNameForScope(PROMPTS_FILE_NAME, accountScope);
        const promptsFileId = await this.files.ensure(token, promptsFileName);
        await this.files.upload(token, promptsFileId, promptPayload);
        logger.info('[GoogleDriveSyncService] Prompts uploaded successfully');
      }

      if (settingsPayload) {
        const settingsFileId = await this.files.ensure(token, SETTINGS_FILE_NAME);
        await this.files.upload(token, settingsFileId, settingsPayload);
        logger.info('[GoogleDriveSyncService] Settings uploaded successfully');
      }

      if (pluginsPayload) {
        const pluginsFileId = await this.files.ensure(token, PLUGINS_FILE_NAME);
        await this.files.upload(token, pluginsFileId, pluginsPayload);
      }

      // Upload starred messages file (only for Gemini platform)
      if (platform === 'gemini' && starred) {
        // Truncate content in starred messages to save storage space
        const MAX_CONTENT_LENGTH = 60;
        const truncatedStarred: StarredMessagesDataSync = {
          messages: Object.fromEntries(
            Object.entries(starred.messages).map(([convId, messages]) => [
              convId,
              messages.map((msg) => ({
                ...msg,
                content:
                  msg.content.length > MAX_CONTENT_LENGTH
                    ? msg.content.slice(0, MAX_CONTENT_LENGTH) + '...'
                    : msg.content,
              })),
            ]),
          ),
        };

        const starredPayload: StarredExportPayload = {
          format: 'gemini-voyager.starred.v1',
          exportedAt: now.toISOString(),
          version: EXTENSION_VERSION,
          data: truncatedStarred,
        };
        const starredFileName = this.getFileNameForScope(STARRED_FILE_NAME, accountScope);
        const starredFileId = await this.files.ensure(token, starredFileName);
        await this.files.upload(token, starredFileId, starredPayload);
        logger.info('[GoogleDriveSyncService] Starred messages uploaded successfully');
      }

      // Upload fork nodes file (only for Gemini platform)
      if (platform === 'gemini' && forks) {
        const forksPayload: ForkExportPayload = {
          format: 'gemini-voyager.forks.v1',
          exportedAt: now.toISOString(),
          version: EXTENSION_VERSION,
          data: forks,
        };
        const forksFileName = this.getFileNameForScope(FORKS_FILE_NAME, accountScope);
        const forksFileId = await this.files.ensure(token, forksFileName);
        await this.files.upload(token, forksFileId, forksPayload);
        logger.info('[GoogleDriveSyncService] Fork nodes uploaded successfully');
      }

      // Upload timeline hierarchy file (only for Gemini platform)
      if (platform === 'gemini' && timelineHierarchy) {
        const timelineHierarchyScope = timelineHierarchyAccountScope ?? accountScope;
        const timelineHierarchyPayload: TimelineHierarchyExportPayload = {
          format: 'gemini-voyager.timeline-hierarchy.v1',
          exportedAt: now.toISOString(),
          version: EXTENSION_VERSION,
          data: timelineHierarchy,
        };
        const timelineHierarchyFileName = this.getFileNameForScope(
          TIMELINE_HIERARCHY_FILE_NAME,
          timelineHierarchyScope,
        );
        const timelineHierarchyFileId = await this.files.ensure(token, timelineHierarchyFileName);
        await this.files.upload(token, timelineHierarchyFileId, timelineHierarchyPayload);
        logger.info('[GoogleDriveSyncService] Timeline hierarchy uploaded successfully');
      }

      const uploadTime = Date.now();
      // Update platform-specific upload time
      const uploadTimePatch: Partial<SyncState> = { isSyncing: false, error: null };
      uploadTimePatch[FOLDER_PLATFORMS[platform].lastUploadTimeField] = uploadTime;
      this.updateState(uploadTimePatch);
      await this.saveState();

      const fileCount =
        1 +
        (prompts.length > 0 ? 1 : 0) +
        (settingsPayload ? 1 : 0) +
        (pluginsPayload ? 1 : 0) +
        (platform === 'gemini' && starred ? 1 : 0) +
        (platform === 'gemini' && forks ? 1 : 0) +
        (platform === 'gemini' && timelineHierarchy ? 1 : 0);
      logger.info(
        `[GoogleDriveSyncService] Upload successful - ${fileCount} file(s) for ${platform}`,
      );
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      console.error('[GoogleDriveSyncService] Upload failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return false;
    }
  }

  /**
   * Upload ONLY the account-scoped prompts file, leaving folders / settings /
   * starred untouched. Used by the popup "cloud merge" buttons, which merge
   * cloud + local locally first and upload the union so both sides converge
   * without data loss.
   */
  async uploadPromptsOnly(
    prompts: PromptItem[],
    accountScope: SyncAccountScope | null = null,
    interactive: boolean = true,
  ): Promise<boolean> {
    try {
      this.updateState({ isSyncing: true, error: null });

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return false;
        }
        throw new Error('Not authenticated');
      }

      const promptPayload: PromptExportPayload = {
        format: 'gemini-voyager.prompts.v1',
        exportedAt: new Date().toISOString(),
        version: EXTENSION_VERSION,
        items: prompts,
      };
      const promptsFileName = this.getFileNameForScope(PROMPTS_FILE_NAME, accountScope);
      const promptsFileId = await this.files.ensure(token, promptsFileName);
      await this.files.upload(token, promptsFileId, promptPayload);

      this.updateState({ isSyncing: false, error: null });
      await this.saveState();
      logger.info('[GoogleDriveSyncService] Prompts-only upload successful');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      console.error('[GoogleDriveSyncService] Prompts-only upload failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return false;
    }
  }

  /**
   * Download ONLY the account-scoped prompts file. Returns the payload, or null
   * when no file exists or the user is not authenticated. The caller is
   * responsible for merging the result into local data.
   */
  async downloadPromptsOnly(
    accountScope: SyncAccountScope | null = null,
    interactive: boolean = true,
  ): Promise<PromptExportPayload | null> {
    try {
      this.updateState({ isSyncing: true, error: null });

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return null;
        }
        throw new Error('Not authenticated');
      }

      await this.files.prepareDownload(token);

      const promptsFileId = await this.findFileForScope(token, PROMPTS_FILE_NAME, accountScope);
      const prompts = promptsFileId
        ? await this.files.download<PromptExportPayload>(token, promptsFileId)
        : null;

      this.updateState({ isSyncing: false, error: null });
      return prompts;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Download failed';
      console.error('[GoogleDriveSyncService] Prompts-only download failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return null;
    }
  }

  /**
   * Upload only the account-scoped highlight payload. Highlights intentionally
   * live in their own file and are never added to the legacy SyncData aggregate.
   *
   * This primitive is last-write-wins. Drive v3's documented media-update API
   * does not expose a reliable compare-and-swap revision contract here, so
   * callers must download/merge before uploading when concurrent edits matter.
   */
  async uploadHighlightsOnly(
    payload: HighlightExportPayload,
    accountScope: SyncAccountScope,
    interactive: boolean = true,
  ): Promise<boolean> {
    try {
      this.updateState({ isSyncing: true, error: null });
      this.assertHighlightPayloadForScope(payload, accountScope);

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return false;
        }
        throw new Error('Not authenticated');
      }

      const fileName = this.getFileNameForScope(HIGHLIGHTS_FILE_NAME, accountScope);
      const fileId = await this.files.ensure(token, fileName);
      // Upload the canonical payload verbatim. In particular, quote.exact must
      // never be shortened as the exact text is required for anchor recovery.
      await this.files.upload(token, fileId, payload);

      this.updateState({ isSyncing: false, error: null });
      await this.saveState();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Upload failed';
      console.error('[GoogleDriveSyncService] Highlights-only upload failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return false;
    }
  }

  /**
   * Download only the exact account-scoped highlight file. Unlike older sync
   * payloads, there is deliberately no fallback to an unscoped legacy file:
   * highlights have been account-isolated since their first Drive format.
   */
  async downloadHighlightsOnly(
    accountScope: SyncAccountScope,
    interactive: boolean = true,
  ): Promise<HighlightExportPayload | null> {
    try {
      this.updateState({ isSyncing: true, error: null });

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return null;
        }
        throw new Error('Not authenticated');
      }

      await this.files.prepareDownload(token);

      const fileName = this.getFileNameForScope(HIGHLIGHTS_FILE_NAME, accountScope);
      const fileId = await this.files.find(token, fileName);
      if (!fileId) {
        this.updateState({ isSyncing: false, error: null });
        return null;
      }

      const downloaded = await this.files.download<unknown>(token, fileId);
      if (downloaded === null) {
        this.updateState({ isSyncing: false, error: null });
        return null;
      }
      this.assertHighlightPayloadForScope(downloaded, accountScope);
      this.updateState({ isSyncing: false, error: null });
      return downloaded;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Download failed';
      console.error('[GoogleDriveSyncService] Highlights-only download failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return null;
    }
  }

  /**
   * Download folders, prompts, and timeline data from separate files in Google Drive
   * Returns all available payloads or null if no files exist
   * @param interactive Whether to show auth prompt if needed
   * @param platform Platform to download for ('gemini' | 'aistudio')
   */
  async download(
    interactive: boolean = true,
    platform: SyncPlatform = 'gemini',
    accountScope: SyncAccountScope | null = null,
    timelineHierarchyAccountScope: SyncAccountScope | null = null,
  ): Promise<{
    folders: FolderExportPayload | null;
    prompts: PromptExportPayload | null;
    settings: SettingsExportPayload | null;
    plugins: PluginStateExportPayload | null;
    starred: StarredExportPayload | null;
    forks: ForkExportPayload | null;
    timelineHierarchy: TimelineHierarchyExportPayload | null;
  } | null> {
    try {
      this.updateState({ isSyncing: true, error: null });

      const token = await this.auth.getToken(interactive);
      if (!token) {
        if (!interactive) {
          logger.info(
            '[GoogleDriveSyncService] Download skipped: Not authenticated (non-interactive)',
          );
          this.updateState({ isSyncing: false, isAuthenticated: false });
          return null;
        }
        throw new Error('Not authenticated');
      }

      await this.files.prepareDownload(token);

      // Download folders file (platform-specific)
      const { driveFoldersFileName } = FOLDER_PLATFORMS[platform];
      const foldersFileId = await this.findFileForScope(token, driveFoldersFileName, accountScope);
      let folders: FolderExportPayload | null = null;
      if (foldersFileId) {
        folders = await this.files.download(token, foldersFileId);
        logger.info(`[GoogleDriveSyncService] ${platform} folders downloaded`);
      }

      // Download prompts file (shared between Gemini and AI Studio)
      let prompts: PromptExportPayload | null = null;
      const promptsFileId = await this.findFileForScope(token, PROMPTS_FILE_NAME, accountScope);
      if (promptsFileId) {
        prompts = await this.files.download(token, promptsFileId);
        logger.info('[GoogleDriveSyncService] Prompts downloaded');
      }

      let settings: SettingsExportPayload | null = null;
      const settingsFileId = await this.files.find(token, SETTINGS_FILE_NAME);
      if (settingsFileId) {
        settings = await this.files.download(token, settingsFileId);
        logger.info('[GoogleDriveSyncService] Settings downloaded');
      }

      let plugins: PluginStateExportPayload | null = null;
      const pluginsFileId = await this.files.find(token, PLUGINS_FILE_NAME);
      if (pluginsFileId) {
        plugins = await this.files.download(token, pluginsFileId);
      }

      // Download starred messages file (only for Gemini platform)
      let starred: StarredExportPayload | null = null;
      if (platform === 'gemini') {
        const starredFileId = await this.findFileForScope(token, STARRED_FILE_NAME, accountScope);
        if (starredFileId) {
          starred = await this.files.download(token, starredFileId);
          logger.info('[GoogleDriveSyncService] Starred messages downloaded');
        }
      }

      // Download fork nodes file (only for Gemini platform)
      let forks: ForkExportPayload | null = null;
      if (platform === 'gemini') {
        const forksFileId = await this.findFileForScope(token, FORKS_FILE_NAME, accountScope);
        if (forksFileId) {
          forks = await this.files.download(token, forksFileId);
          logger.info('[GoogleDriveSyncService] Fork nodes downloaded');
        }
      }

      // Download timeline hierarchy file (only for Gemini platform)
      let timelineHierarchy: TimelineHierarchyExportPayload | null = null;
      if (platform === 'gemini') {
        const timelineHierarchyScope = timelineHierarchyAccountScope ?? accountScope;
        const timelineHierarchyFileId = await this.findFileForScope(
          token,
          TIMELINE_HIERARCHY_FILE_NAME,
          timelineHierarchyScope,
        );
        if (timelineHierarchyFileId) {
          timelineHierarchy = await this.files.download(token, timelineHierarchyFileId);
          logger.info('[GoogleDriveSyncService] Timeline hierarchy downloaded');
        }
      }

      if (
        !folders &&
        !prompts &&
        !settings &&
        !plugins &&
        !starred &&
        !forks &&
        !timelineHierarchy
      ) {
        logger.info(`[GoogleDriveSyncService] No sync files found for ${platform}`);
        this.updateState({ isSyncing: false });
        return null;
      }

      const syncTime = Date.now();
      // Update platform-specific sync time
      const syncTimePatch: Partial<SyncState> = { isSyncing: false, error: null };
      syncTimePatch[FOLDER_PLATFORMS[platform].lastSyncTimeField] = syncTime;
      this.updateState(syncTimePatch);
      await this.saveState();

      return { folders, prompts, settings, plugins, starred, forks, timelineHierarchy };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Download failed';
      console.error('[GoogleDriveSyncService] Download failed:', error);
      this.updateState({ isSyncing: false, error: errorMessage });
      return null;
    }
  }

  private getFileNameForScope(baseFileName: string, accountScope: SyncAccountScope | null): string {
    if (!accountScope) return baseFileName;

    const suffix = `acct-${hashString(accountScope.accountKey)}`;
    const dotIndex = baseFileName.lastIndexOf('.');
    if (dotIndex <= 0) {
      return `${baseFileName}.${suffix}`;
    }
    return `${baseFileName.slice(0, dotIndex)}.${suffix}${baseFileName.slice(dotIndex)}`;
  }

  private assertHighlightPayloadForScope(
    value: unknown,
    accountScope: SyncAccountScope,
  ): asserts value is HighlightExportPayload {
    if (!isHighlightExportPayloadV1(value)) {
      throw new Error('Invalid highlight sync payload');
    }

    const expectedAccountHash = hashString(accountScope.accountKey);
    if (
      value.accountScope.accountHash !== expectedAccountHash ||
      value.items.some(
        (item) =>
          item.accountHash !== expectedAccountHash || item.platform !== value.accountScope.platform,
      )
    ) {
      throw new Error('Highlight sync payload does not match the requested account scope');
    }
  }

  private async findFileForScope(
    token: string,
    baseFileName: string,
    accountScope: SyncAccountScope | null,
  ): Promise<string | null> {
    if (!accountScope) {
      return this.files.find(token, baseFileName);
    }

    const scopedFileName = this.getFileNameForScope(baseFileName, accountScope);
    const scopedFileId = await this.files.find(token, scopedFileName);
    if (scopedFileId) return scopedFileId;

    // Backward compatibility: allow reading legacy shared file before user uploads scoped data.
    return this.files.find(token, baseFileName);
  }

  private async loadState(): Promise<void> {
    try {
      const result = await chrome.storage.local.get([
        'gvSyncMode',
        'gvSyncProvider',
        'gvLastSyncTime',
        'gvLastUploadTime',
        'gvLastSyncTimeAIStudio',
        'gvLastUploadTimeAIStudio',
        'gvSyncError',
      ]);
      this.state = {
        provider:
          result.gvSyncProvider === 'icloud' && isSafariRuntime() ? 'icloud' : 'googleDrive',
        mode: (result.gvSyncMode as SyncMode) || 'disabled',
        lastSyncTime: getNumberValue(result.gvLastSyncTime),
        lastUploadTime: getNumberValue(result.gvLastUploadTime),
        lastSyncTimeAIStudio: getNumberValue(result.gvLastSyncTimeAIStudio),
        lastUploadTimeAIStudio: getNumberValue(result.gvLastUploadTimeAIStudio),
        error: getStringValue(result.gvSyncError),
        isSyncing: false,
        isAuthenticated: false,
      };
      if (this.state.mode !== 'disabled') {
        const token = await this.auth.getToken(false);
        this.state.isAuthenticated = !!token;
      }
    } catch (error) {
      console.error('[GoogleDriveSyncService] Failed to load state:', error);
    }
  }

  private async saveState(): Promise<void> {
    try {
      await chrome.storage.local.set({
        gvSyncMode: this.state.mode,
        gvSyncProvider: this.state.provider,
        gvLastSyncTime: this.state.lastSyncTime,
        gvLastUploadTime: this.state.lastUploadTime,
        gvLastSyncTimeAIStudio: this.state.lastSyncTimeAIStudio,
        gvLastUploadTimeAIStudio: this.state.lastUploadTimeAIStudio,
        gvSyncError: this.state.error,
      });
    } catch (error) {
      console.error('[GoogleDriveSyncService] Failed to save state:', error);
    }
  }

  private updateState(partial: Partial<SyncState>): void {
    this.state = { ...this.state, ...partial };
    this.notifyStateChange();
  }

  private notifyStateChange(): void {
    if (this.stateChangeCallback) {
      this.stateChangeCallback({ ...this.state });
    }
  }
}

export const googleDriveSyncService = new GoogleDriveSyncService();

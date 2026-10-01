import { cloneFolderData } from '@/features/folder/model/folderData';
import { FolderImportExportService } from '@/features/folder/services/FolderImportExportService';
import type { ImportResult } from '@/features/folder/types/import-export';

import type { FolderData } from './types';

/**
 * Merge an imported AI Studio file into a copy of the current data: imported
 * folders are appended, and only their buckets are read, so the file's
 * Uncategorized and orphan buckets are ignored. A new folder's bucket replaces
 * any orphan bucket left under its id; an existing folder gains the prompts it
 * lacks. The stats count what the merge added.
 */
export function mergeAIStudioImport(
  current: FolderData,
  file: FolderData,
): { data: FolderData; stats: ImportResult } {
  const existing = cloneFolderData(current);
  const existingIds = new Set(existing.folders.map((folder) => folder.id));
  const imported: FolderData = { folders: file.folders, folderContents: {} };
  for (const folder of file.folders) {
    if (!existingIds.has(folder.id)) delete existing.folderContents[folder.id];
    imported.folderContents[folder.id] = file.folderContents[folder.id] || [];
  }
  const { merged, stats } = FolderImportExportService.mergeData(existing, imported);
  return { data: merged, stats };
}

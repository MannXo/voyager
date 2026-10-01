/**
 * How the prompts import merges a file (or a Drive copy) into the library.
 * The background owner applies it inside its queue; nothing else calls it.
 */
import { getPromptNameConflictIds } from '@/core/utils/promptName';
import type { PromptItem } from '@/features/backup/types/backup';

export interface PromptImportStats {
  imported: number;
  duplicates: number;
  nameConflicts: number;
  total: number;
}

/**
 * Merge imported prompts into a library, as the prompts import always has:
 * a prompt matching a stored one by id (or else by text) merges tags into it,
 * and a same-id copy that is newer replaces its text and name; anything else
 * is added. `stored` is the freshly read library; its prompts are updated in place.
 */
export function mergeImportedPrompts(
  stored: PromptItem[],
  incoming: PromptItem[],
  now: number,
): PromptImportStats & { items: PromptItem[] } {
  const mergedItems = [...stored];
  const importItems = incoming;

  // Index one merge target per body without using the map as the final
  // collection. Historical stores may themselves contain duplicates and
  // must never be collapsed by a later import.
  const existingByText = new Map<string, PromptItem>();
  const existingById = new Map<string, PromptItem>();
  for (const item of mergedItems) {
    const key = item.text.toLowerCase();
    if (!existingByText.has(key)) existingByText.set(key, item);
    if (!existingById.has(item.id)) existingById.set(item.id, item);
  }

  let imported = 0;
  let duplicates = 0;

  for (const item of importItems) {
    const key = item.text.toLowerCase();
    const existingWithId = existingById.get(item.id);
    const existing = existingWithId ?? existingByText.get(key);
    if (existing) {
      // Merge tags if duplicate
      const mergedTags = Array.from(new Set([...(existing.tags || []), ...(item.tags || [])]));
      existing.tags = mergedTags;
      const incomingTime = item.updatedAt || item.createdAt || 0;
      const existingTime = existing.updatedAt || existing.createdAt || 0;
      const shouldApplySameIdUpdate = existingWithId === existing && incomingTime > existingTime;

      if (item.name && (shouldApplySameIdUpdate || !existing.name)) {
        existing.name = item.name;
      }

      if (shouldApplySameIdUpdate) {
        existing.text = item.text;
        existingByText.clear();
        for (const mergedItem of mergedItems) {
          const mergedKey = mergedItem.text.toLowerCase();
          if (!existingByText.has(mergedKey)) {
            existingByText.set(mergedKey, mergedItem);
          }
        }
      }
      existing.updatedAt = now;
      duplicates++;
    } else {
      const importedItem = {
        ...item,
        createdAt: now,
      };
      existingByText.set(key, importedItem);
      existingById.set(importedItem.id, importedItem);
      mergedItems.push(importedItem);
      imported++;
    }
  }

  // Save merged results
  mergedItems.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const nameConflicts = getPromptNameConflictIds(mergedItems).size;
  return {
    items: mergedItems,
    imported,
    duplicates,
    nameConflicts,
    total: mergedItems.length,
  };
}

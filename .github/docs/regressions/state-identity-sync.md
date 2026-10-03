# State, identity, and sync regression notes

Read this file when changing account or route identity, extension message lifetimes, storage
mirrors, clear markers, or Drive sync.

## Non-native sites must not fall back to Gemini folder buckets

- **Trap:** `detectAccountPlatformFromUrl` returned `'gemini'` for every host except AI Studio, and
  folder routing used `platform === 'aistudio' ? <AI Studio> : <Gemini>` branches. On ChatGPT,
  Claude and DeepSeek, where Prompt Manager and plugins run, popup isolation, Prompt Manager folder
  backup and Drive sync routing therefore resolved Gemini's `gvFolderData`, isolation switch, Drive
  file and sync timestamps. Adding a platform to the union would also have compiled and silently
  used the Gemini branch.
- **Rule:** Folder storage keys, isolation keys, Drive file names and types, sync timestamps and
  hosts come from `FOLDER_PLATFORMS` in `src/features/folder/platforms.ts`, whose `Record` type
  requires an entry for every platform. `detectAccountPlatformFromUrl` returns `null` for every other
  http(s) site, and callers skip folder storage, backup, isolation and sync on `null`; only pages
  without a web URL (new tab, extension pages) keep the Gemini default. The background rejects
  unknown sync platforms and web-page senders whose host does not own the requested platform. Do
  not add `=== 'aistudio' ? … : <Gemini>` or `!== 'aistudio'` branches for folder data: use the map
  or a positive `=== 'gemini'` check.
- **Guard:** `src/features/folder/__tests__/platforms.test.ts`,
  `src/core/services/__tests__/AccountIsolationService.test.ts` (`never resolves a non-Gemini site
to a Gemini or AI Studio folder platform`),
  `src/pages/background/__tests__/runtimeMessageRouting.test.ts`,
  `src/core/services/__tests__/GoogleDriveSyncPlatform.test.ts`,
  `src/pages/popup/components/__tests__/CloudSyncSettingsPlatform.test.tsx`,
  `src/pages/popup/hooks/__tests__/useFolderPopupSettings.test.tsx` and
  `src/pages/popup/__tests__/Popup.test.tsx` (`keeps Gemini folder data, isolation and Cloud Sync
off a ChatGPT tab`).

## Highlight cleanup must preserve account clear markers

- **Trap:** After a user cleared all highlights from Storage Manager, a later Google Drive pull
  could restore the deleted highlights. Deleting every `gvAnnotation:*` key also deleted the bounded
  account/platform clear marker. Without that marker, an older remote record looked newer than an
  empty local store and was imported again.
- **Rule:** Highlight cleanup must go through `HighlightAnnotationService.clearAllAccounts()`. It
  removes annotation buckets in one serialized commit while retaining small versioned clear markers.
  Quota classification counts only `gvAnnotation:bucket:*` as highlight content;
  `gvAnnotation:index:*` and the device id are protected metadata/settings. Do not replace this path
  with `storage.remove()` over the whole annotation namespace.
- **Guard:** `src/core/services/__tests__/HighlightAnnotationService.test.ts` (`clearAllAccounts`
  cases) and `src/core/services/__tests__/StorageQuotaService.test.ts`
  (`clears the narrowly matched highlights category`).

## Backup quota failures must retain a recoverable copy

- **Trap:** A large Gemini library fits alongside its primary backup but an emergency or unload
  snapshot exceeds page localStorage's quota. `setItem` retains the older slot atomically, but the
  write failure used to skip Safari's durable mirror too; recovery could only read page slots, so
  a missing or unusable primary left no fresh emergency copy. Moving those copies into extension
  storage carelessly trades one failure for others: copies of a multi-MB library can crowd out the
  live folder mirror, prompts and highlights (Voyager's soft cap, or Safari's 5/10 MiB quota), and
  awaiting them inside the save chain lets one hung write stall every later save.
- **Rule:** Try localStorage first without deleting an older slot for space, then send the same
  serialized slot to the background (`gv.storageBudget.writeCopy`). Its storage budget measures
  fresh, admits the copy only if it leaves the backup reserve free, and writes it in the same step,
  so tabs never decide from a shared or stale measurement; a skipped copy or an unreachable
  background reports `false`. Never remove an extension copy because a page write landed: another
  tab may have just written a newer one there, and recovery already takes the newest valid copy of
  each slot. Keep backups out of the save chain (never await them before a save settles) while the
  backup service orders its own writes per slot; send the unload copy's message synchronously from
  the event. Recovery reads validated copies from both stores, with a bounded wait for writes in
  flight, preserving slot priority and account namespaces. Highlight commits check and write inside
  the same budget, and every writer reads one quota from `resolveEffectiveLocalQuota`.
- **Guard:** `src/core/services/__tests__/DataBackupService.test.ts` (quota fallback cases, T25a,
  T26e), `src/features/storage/__tests__/storageBudget.test.ts`,
  `src/features/storage/__tests__/budgetHighlights.test.ts`,
  `src/core/services/__tests__/effectiveLocalQuota.test.ts` and
  `src/pages/content/folder/__tests__/folderBackupQuota.test.ts` (1k folders / 10k refs recovery,
  saves while a backup write hangs, and the live mirror's room near the quota).

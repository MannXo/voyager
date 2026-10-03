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

## A per-tab write queue does not serialize writes across tabs

- **Trap:** Two Gemini tabs adding to the Research Pack at the same moment kept only one item. Each
  tab serialized its own read-modify-write of the whole pack, but `chrome.storage` has no
  compare-and-set, so tab B wrote back the pack it read before tab A's write landed.
- **Rule:** Shared, user-edited storage values that several tabs change go through one writer.
  Research Pack tabs send ops (`gv.researchPack.apply`) to the background owner in
  `src/pages/background/researchPackOwner.ts`, which applies them in order against the freshly read
  pack. A queue inside a content script only orders that tab's own writes.
- **Guard:** `src/features/researchPack/services/__tests__/packStore.test.ts`
  (`keeps both items when two tabs add at the same time`).

## Prompt library writes go through its background owner

- **Trap:** `gvPromptItems` had many writers that each read the whole list, changed it and wrote
  it back. A research pack template saved on one tab, a Prompt Manager edit on another, a popup
  import and a Drive prompts merge could each roll back a prompt another had just written, or drop
  the other's new prompts.
- **Rule:** Writers send ops (`gv.promptLibrary.apply`: add, update, delete, reorder, import, seed)
  to `src/pages/background/promptLibraryOwner.ts`, which applies them in order against the library
  as stored at that moment and never overwrites a value that is not a list. The background's Drive
  merges (`promptDriveMerge.ts`) join the same queue in-process. Prompt Manager
  (`src/pages/content/prompt/promptLibraryState.ts`), the template panel, the popup import and both
  prompts-only Drive merges are routed; Prompt Manager's legacy localStorage library is a `seed`
  op that only fills an empty library. The stored format is unchanged.
  Prompt Manager shows a base plus pending ops: the base is the newest library seen from
  `storage.onChanged` (events arrive in write order), and its unanswered ops are reapplied on top
  with the owner's own `applyPromptLibraryOp`. A reply only removes its op; the reply's list is
  never shown, since it can be older than the base. A failed op is removed too, which is the
  rollback, with the `pm_save_failed` notice; "Deleted" waits for the owner's reply. Earlier
  attempts that held echoes back and re-read storage after a settle kept losing a change under
  some reply/echo/read interleaving; do not reintroduce them. The panel subscribes before its
  first read and drops that read if a change arrived during it. A removed library (a change with
  no `newValue`) is an empty one. Until a read succeeds or storage reports the library, the panel
  cannot tell an empty library from an unread one: an op on it can be a silent no-op at the owner
  (a re-add the owner dedupes writes nothing and sends no echo), so edits are refused with
  `pm_library_load_failed` and the library is read again on that refusal and on each panel open.
  `readPromptLibrary` returns `[]` only when nothing is stored. Teardown calls `dispose()`, after
  which late replies and the watchdog report nothing. A tab sends its next op only after the previous reply, so the owner applies one tab's
  ops in the order the user made them without trusting the transport's delivery order. A reply
  overdue by 15 s marks the library unavailable (`pm_library_unavailable`): new edits are
  refused, queued ops stay queued and are never sent ahead of it, and it recovers when the reply
  comes. An edit whose prompt another tab deleted keeps its draft open and saves again as a new
  prompt.
  The queue lives in the service worker's memory. If the worker restarts, queued ops are dropped,
  and an op that was written but whose reply was lost reads as failed in the tab, while the
  echo still shows the write. There is no exactly-once guarantee: do not retry an op on failure
  without checking the stored library first.
  These whole-key writers stay on purpose; do not route them through the owner without a plan
  for what replaces their atomicity: the popup cloud restore (`applyCloudRestore` in
  `src/pages/popup/components/cloudRestore.ts`) and the AI Studio Drive merge (`replaceData` in
  `src/pages/content/folder/aistudio.ts`, whose prompts ride in the folder write as
  `AIStudioFolderStorageAdapter` companions) write prompts in one `chrome.storage.local.set`
  together with folders. Gemini's Drive merge in
  `src/pages/content/folder/folderCloudSync.ts` (`syncFolders`, behind
  `FolderTransferController.sync`) is two writes: folders through
  `replaceData`, then prompts, starred messages and the timeline hierarchy in one `set`, so a
  failure between them lands the folders alone. They are rare bulk operations, and keeping those keys consistent with each other is worth more
  than the lock. Splitting prompts into an owner op would let the other keys land without them.
- **Guard:** `src/features/prompt/library/__tests__/promptLibraryOwner.test.ts`,
  `src/pages/content/prompt/__tests__/promptLibraryInterleaving.test.ts` (`keeps a Prompt Manager
edit and a template saved in another tab`, `keeps edits that two Prompt Manager tabs make to
different prompts`), `src/pages/content/prompt/__tests__/promptLibraryState.test.ts` (`shows the
newest library when a reply comes after another writer changed it`, `sends a tab's ops one at a
time, so a late message cannot reorder them`, `marks the library unavailable while a reply is
overdue, refusing edits until it comes`, `refuses edits until the library has loaded, and shows it
once a retry reads it`),
  `src/pages/content/prompt/__tests__/promptManagerWriteNotices.test.ts`,
  `src/features/researchPack/services/__tests__/templates.test.ts` (`keeps both templates when two
tabs save at the same moment`), `src/pages/background/__tests__/promptDriveMerge.test.ts` and
  `src/pages/popup/hooks/__tests__/usePromptDataTransfer.test.tsx` (`keeps a template saved on a
Gemini tab while the popup import is writing`).

## A prompt merge must not stamp the time it ran

- **Trap:** The prompts import set `updatedAt = now` on every matched prompt and `createdAt = now`
  on every added one. A copy that was only synced then looked freshly edited, so a real but
  earlier edit from another device lost to it: after a no-op merge at 100, an edit made at 20
  elsewhere was rejected, and when two devices edited one prompt, whichever pushed last won rather
  than the later edit. The import also copied only text and name from a newer same-id copy, so
  pins and unpins never travelled through the popup import or the prompts-only Drive merges.
  The file parser also filled a missing `createdAt` with the time of the import, so a timeless
  copy from an old backup beat a newer local edit.
- **Rule:** A prompt's edit time is its own `updatedAt`, else `createdAt`; no merge reads the
  clock, and `applyPromptLibraryOp` takes no time argument. `isNewerPromptCopy`
  (`src/core/utils/promptRevision.ts`) decides the winner for the import and for the full restore
  (`mergePromptsWithStats`): the later edit wins, and a tie goes to the greater
  `[text, name, pinnedAt]` so devices normally keep the same copy, with a missing name sorting low.
  The winning copy brings its text, name (when it has one), `pinnedAt` (when it has the key) and
  edit time; tags still union. Every unpin writes `pinnedAt: null`, and a winner's `null` unpins.
  An absent `pinnedAt` means "no pin information" and keeps the local pin: 1.9.0 and earlier drop
  the field on every unpinned prompt and stamp their merge time as `updatedAt`, so treating
  absence as an unpin let one pull from an older device unpin everything. Those versions show
  `null` as unpinned and keep the prompt (`isPinned` checks for a number; their library
  validators do not read the field), but their file parser drops `null` and their merge still
  stamps its run time as `updatedAt`. So until an old device updates, its pushed copy can revive
  a pin removed elsewhere or overwrite a newer edit. Do not strip `null` in a parser or
  serializer. Pinning must keep bumping `updatedAt`, or a pin loses
  to the older copy. An added prompt keeps the times it came with. A copy without `createdAt`
  gets 0 from the file parser, the oldest edit time, so it never beats a timestamped copy; the
  field stays a number because every prompt validator, old and new, requires one. Known limit:
  copies edited in the same millisecond may not settle alike on every device, and a missing,
  `null` or `0` pin share one tie key; both are left as too unlikely to handle.
- **Guard:** `src/pages/background/__tests__/promptDriveMergeEdits.test.ts` (`keeps an edit made
elsewhere after this device merged an unchanged copy`, `changes nothing when the same Drive file
is merged again`, the pin and unpin round trips), `src/utils/mergePrompts.test.ts` and
  `src/features/prompt/library/__tests__/promptImportBoundaries.test.ts`.

## Backup quota failures must retain a recoverable copy

- **Trap:** A large Gemini library fits alongside its primary backup but an emergency or unload
  snapshot exceeds page localStorage's quota. `setItem` retains the older slot atomically, but the
  write failure used to skip Safari's durable mirror too; recovery could only read page slots, so
  a missing or unusable primary left no fresh emergency copy. Moving those copies into extension
  storage carelessly trades one failure for others: copies of a multi-MB library can crowd out the
  live folder mirror, prompts and highlights (Voyager's soft cap, or Safari's 5/10 MiB quota), and
  awaiting them inside the save chain lets one hung write stall every later save.
- **Rule:** Try localStorage first without deleting an older slot for space, then use the same
  serialized slot in extension storage on failure, but only when `getLocalHeadroom` shows the copy
  still leaves the backup reserve free; otherwise skip it and report `false`. Never remove an extension
  copy because a page write landed: another tab may have just written a newer one there, and
  recovery already takes the newest valid copy of each slot. Keep backups out of the save chain (never
  await them before a save settles) while the backup service orders its own writes per slot; send
  the unload copy synchronously from the event. Recovery reads validated copies from both stores,
  with a bounded wait for writes in flight, preserving slot priority and account namespaces.
- **Guard:** `src/core/services/__tests__/DataBackupService.test.ts` (quota fallback cases),
  `src/core/services/__tests__/StorageQuotaService.test.ts` (headroom limits) and
  `src/pages/content/folder/__tests__/folderBackupQuota.test.ts` (1k folders / 10k refs recovery,
  saves while a backup write hangs, and the live mirror's room near the quota).

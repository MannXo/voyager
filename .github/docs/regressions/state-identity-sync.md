# State, identity, and sync regression notes

Read this file when changing account or route identity, extension message lifetimes, storage
mirrors, clear markers, or Drive sync.

## Route indexes are not durable account identities

- **Trap:** Prompt History could show one Google account's prompts after another account reused the
  same Gemini `/u/<index>` route. Prompt History persisted the route index directly, and the shared
  account resolver also preferred a stale route alias when it observed a new email on that route.
- **Rule:** Resolve Prompt History storage through `AccountIsolationService`, require an explicit
  stable scope for every write, and let an observed email override a route alias owned by a
  different email.
- **Guard:** `src/core/services/__tests__/AccountIsolationService.test.ts`
  (`does not reuse a route alias after that route switches to another email`) and
  `src/pages/content/promptHistory/__tests__/promptHistory.test.ts`
  (`keeps captures separate when the same route switches to another account`).

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

## ChatGPT folders keep their own unscoped bucket

- **Trap:** ChatGPT folders run on the shared `FolderRepository`, which reads an isolation switch
  for `config.platform` and, for an account-scoped bucket with no data, runs `migrateLegacyData`.
  A config borrowed from Gemini (`platform: 'gemini'`, or `FOLDER_DATA`) would follow Gemini's
  isolation switch on chatgpt.com and read or write Gemini's folders. A Gemini or AI Studio export
  imported on ChatGPT would file conversations that can never open there.
- **Rule:** `CHATGPT_FOLDER_CONFIG` uses `platform: null` (isolation off, no fallback to the legacy
  switch), its own `gvFolderDataChatGPT` key and `chatgpt-folders` backup namespace, and a
  `migrateLegacyData` that returns empty data. A ChatGPT folder entry is keyed by its bare id
  (`chatgpt:conv:<id>`) across `/c/`, `/g/g-p-*/c/` and `/g/g-*/c/`. Import is merge-only and
  rejects the whole file if it is marked for another site or any entry, root bucket included, is
  not a ChatGPT conversation whose id matches its URL. ChatGPT marks its export with `platform`,
  and the Gemini and AI Studio importers refuse any marked file. `FolderPlatform` stays Gemini/AI
  Studio until ChatGPT gets Drive sync.
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/ChatGptFolderStore.test.ts`
  (`writes only the ChatGPT bucket, whatever Gemini and the legacy switch hold`),
  `src/features/plugins/builtin/chatgptFolders/__tests__/activate.test.ts`
  (`files the open conversation and writes only its own keys`),
  `src/features/plugins/builtin/chatgptFolders/__tests__/transfer.test.ts`,
  `src/features/plugins/builtin/chatgptFolders/chatgptIdentity.test.ts`,
  `src/pages/content/folder/__tests__/FolderTransferController.test.ts`
  (`refuses to %s a folder file ChatGPT exported`) and
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts`
  (`refuses a folder file ChatGPT exported`).

## onMessage listeners must not return true unconditionally

- **Trap:** Background broadcasts (e.g. `gv.remoteAnnouncement.show` via `chrome.tabs.sendMessage`)
  hung forever on tabs running the folder content scripts; `await Promise.all` over the broadcast
  never settled. Per-tab `catch` did not help because the promise neither resolved nor rejected.
  Both folder `runtime.onMessage` listeners (Gemini `manager.ts` and `aistudio.ts`) ended with an
  unconditional `return true`, telling Chrome "I will respond asynchronously" for every message,
  including types they never answer. A message with no responder anywhere on the page then keeps the
  channel open forever. `return true` is only safe on branches that actually call `sendResponse`.
- **Rule:** Return `true` only from branches that respond; fall through to `return undefined` for
  unknown messages so the sender's promise settles immediately. Any new content-script onMessage
  listener must follow this.
- **Guard:** `src/pages/content/folder/__tests__/folderRuntimeMessages.test.ts` ("returns undefined for unknown
  messages so the sender promise settles")
  `src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`

## Folder storage mirror writes echo back through storage.onChanged

- **Trap:** Every local folder save (star, drag, expand/collapse) triggered a redundant full
  `loadData` + `renderAllFolders`, and rapid consecutive edits could briefly flash the UI back to a
  stale state. `FolderStorageAdapter.saveData` mirrors folder data into `chrome.storage.local`, and
  `chrome.storage.onChanged` fires in the SAME context that performed the write (unlike the window
  `storage` event). The manager's onChanged handler treated its own mirror write as an external
  change and reloaded.
- **Trap 2:** A bare echo counter swallowed genuine external updates. chrome.storage emits no
  onChanged event for an unchanged value or a rejected write, so dropping a prompt onto its own
  folder (or a quota failure) left suppression armed; another tab's update within 2s was ignored and
  this stale tab's next save overwrote it. Echoes also come back with object keys sorted, so
  insertion-order JSON never equals the written snapshot. Skipping the token for a no-op write
  broke Firefox, which does report unchanged writes, and tokens were pruned only on events.
- **Rule:** `FolderRepository.persistDataSession` arms a `StorageEchoTracker` token holding the
  key-sorted serialization of the snapshot it writes, for the active session only, and disarms it
  when that attempt fails or throws. The handler suppresses only an event whose `newValue` equals an
  armed token; any other event for the key reloads and clears that key's tokens, because a later
  external write could restore their value. Every write attempt arms, even a no-op, and arming
  prunes expired tokens. Suppression is only an optimisation over the deferred reconcile below:
  each misjudgment must degrade to a redundant reload, never a swallowed update. Reset the
  tracker when switching accounts; delayed writes for a previous session must not arm the new
  session because the listener ignores events for their old storage key.
- **Guard:** `src/pages/content/folder/FolderStore.test.ts` ("consumes one mirror echo per write and then applies an external update" and "applies an external update when no local write has armed echo suppression"), `src/pages/content/folder/__tests__/folderStorePersistenceCharacterization.test.ts` ("storage echo and cross-tab reload"), `src/pages/content/folder/__tests__/aistudioFolderSync.test.ts` (Chrome-like storage mock: no event for unchanged or rejected writes, sorted keys; a Firefox-like case reports unchanged writes), `src/pages/content/folder/storage/__tests__/StorageEchoTracker.test.ts`

## External folder writes reconcile only after local work settles

- **Trap:** The storage listener reloaded immediately. During a pending write or draft
  replacement `loadData` returned early, so another tab's write was dropped and this tab's next
  save overwrote it. With a 300ms debounced edit pending, the reload replaced memory with disk and
  the timer then persisted the reverted state. Flushing the debounce before reloading instead let
  an automatic edit (last-opened on navigation, activity timestamps) overwrite another tab's folder.
- **Rule:** An unsuppressed event only flags the `FolderDataSession` that owns the written bucket
  (`reconcilePending`), including a session retained for its pending write while another account
  is active and the session a scope refresh is releasing; the flag never moves to another session
  and survives scope changes. It clears only when a load applies a read that started after every
  observed external write (`externalWrites`), never when a reload is merely requested, so a read
  discarded by a scope refresh, a save or a newer load leaves it set. `tryReconcile()` calls the
  owner's reload hook for the active session once no write, replacement or read is in flight;
  persist, `replaceData`, `loadData` and rebinding call it again. A read that fails applies
  nothing and runs no recovery ("A failed folder read is not an absent bucket"); the flag stays
  for its retry. A load that ran backup recovery (absent or invalid data) is not a discarded read: if the recovery write landed, memory equals storage and the flag clears;
  if it failed, the flag stays but waits for the next storage event or settled local write, since
  rereading would rewrite the same failing snapshot in an unbounded loop. A failed local write
  proves nothing about storage, so it reconciles only for an external write observed since the
  last reload request (`reconcileAttemptedAt`). While memory holds an edit whose write failed
  (`failedEditGen`), recovery repairs storage from live memory instead of the older primary
  backup, which would roll back the edit and then overwrite the emergency backup holding it.
  Each write attempt takes the next `writeGen`; a failed write that carried a local edit (not a legacy
  migration, a draft replacement or a recovered backup) records its generation, and only an operation that
  started at or after it clears it: a successful write, or an applied load whose read started
  after that write. Two orderings keep this sound: no load applies while one of the session's
  writes is in flight (`loadData` returns early for a ready session that is saving, and a save
  bumps `loadVersion`), and `persistDataSession` settles its own generation before it starts the
  queued write, so writes complete in generation order even when one throws synchronously. Do
  not reset a boolean at each site instead: a recovery continuation that
  resumes after a newer queued save failed would clear that newer failure, and a stale flag would
  keep old memory over a newer primary backup another tab of the same account wrote. Every load merges edits still
  waiting on the debounce onto the fresh data with `mergeDebouncedEdits`, against
  `session.baseline` (what this tab last read or wrote), so debounced edits may only touch
  expand/collapse and conversation timestamps. Timestamps raised here are matched by conversation identity (normalized id or URL route id, as `FolderStore.isSameConversation` does) across folders, because another tab may have moved or copied the conversation; fresh
  membership wins, so a removed reference is not brought back. A debounce that falls due while a
  load is in flight re-arms instead of saving, so it cannot supersede that read. Echo suppression
  is only an optimisation: a wrongly unsuppressed echo costs one reload of this tab's own data.
  Limit: an immediate save issued while the reload read is in flight, or a snapshot already queued
  behind an in-flight write, is still whole-snapshot last-writer-wins.
- **Guard:** `src/pages/content/folder/__tests__/folderStoreReconcile.test.ts`, `src/pages/content/folder/__tests__/aistudioFolderSync.test.ts` ("applies another tab write that lands while its own write is pending")

## AI Studio external folder reloads must reapply library archive classes

- **Trap:** A cross-tab folder reload repainted the AI Studio sidebar, but `render()` does not
  touch the `/library` table, so rows moved into or out of folders in another tab kept a stale
  `gv-conversation-archived` class until the next local mutation.
- **Rule:** The repository's `onExternalChange` hook in `aistudio.ts` runs
  `applyHideArchivedToLibraryTable()` after the reload settles, alongside `onPersistSettled` for
  local writes.
- **Guard:** `src/pages/content/folder/__tests__/aistudioFolderSync.test.ts` ("archives and unarchives existing rows when another tab moves prompts")

## AI Studio inline folder drafts must survive external reloads

- **Trap:** `render()` cleared the whole folder list, so a cross-tab reload (or an unsuppressed
  echo) destroyed an unfinished new-folder or rename editor. The rename editor also captured the
  folder object and header when opened, so after a reload its save mutated a detached object and
  the rename was silently lost.
- **Rule:** `render()` takes every open editor out with `InlineDraftHolder` and puts the same
  nodes back beside their folders with text, focus and selection. The model decides whether a
  draft survives, never the rendered DOM: a rename whose folder, or a new-subfolder draft whose
  parent, no longer exists in the data is dropped (the save re-checks the parent too). A draft
  whose folder exists but is hidden under a collapsed ancestor is held, not dropped, and returns
  when the folder is visible again; reloads never expand folders to show it. `releaseAccountUi`
  discards held and open drafts. Drafts record their folder id when opened, because a collapsed
  parent has no content box. Editors resolve their folder and header when saving or cancelling,
  and remove themselves before re-rendering. Gemini's `FolderTreeView.render()` still closes
  inline editors on every rebuild.
- **Guard:** `src/pages/content/folder/__tests__/aistudioFolderSync.test.ts` ("AI Studio inline folder drafts across reloads")

## Folder recovery and pending writes belong to an account session

- **Trap:** Live folder storage used stable account keys, but both managers shared platform-wide
  recovery backups. AI Studio could recover account A into a new account B; Gemini could do so
  when B's live value was corrupt. Keeping the previous in-memory data on load failure also crossed
  accounts. A delayed load, save, import or sync completion could use the manager's newly selected
  account instead of the account where the operation began.
- **Rule:** Bind data, backup namespace and pending saves to one `FolderDataSession`. Capture its
  key and data snapshot before asynchronous writes, reject stale reads/import/sync completions,
  and detach its unload handler on account changes. Returning to an account with pending writes
  must reuse its writer and retain unsaved memory; leaving the account still invalidates earlier
  import/sync operations. Clear the old account's visible rows and transient editors while resolving
  the next account. Resolution failure must not fall back to global storage. Keep ownerless legacy
  backups intact and readable only with isolation off; never adopt them into an isolated account.
  Arm storage-echo suppression only for the session currently observed by the manager.
  Accept user mutations only after the current session is ready; disable the sidebar/floating
  editing controls during both account resolution and initial loading, including global data after
  disabling isolation and AI Studio's library drop targets. Floating mode, including
  its closed FAB state, must observe account route changes without waiting for a sidebar mount.
  A queued save must await its coalesced snapshot's actual storage result. Import, sync and
  instructions editors report
  success only after persistence succeeds; failed saves retain editable input for retry.
- **Guard:** `src/pages/content/folder/__tests__/accountScopedBackup.test.ts` covers same-account
  recovery, legacy compatibility, new/empty accounts, same-instance switching, unload ownership,
  deferred loads/writes, account revisits and failed resolution. `src/pages/content/folder/FolderStore.test.ts`
  preserves the per-write echo and trailing-save behavior; `src/pages/content/folder/floatingPanel.test.ts`
  guards reset during inline editing.
  `src/pages/content/folder/FolderStorePersistence.test.ts` covers pending resolution/load and queued
  save results. `src/pages/content/folder/__tests__/folderAccountRouting.test.ts` covers disabled
  controls and real manager route wiring in sidebar, floating and FAB modes and its teardown.
  `src/pages/content/folder/__tests__/FolderTransferController.test.ts`
  and `src/pages/content/folder/folderDialogs.test.ts` cover save failures and stale completions.
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts` covers AI Studio's pending
  global/scoped loads, coalesced save results, library drops and import/sync completion feedback.

## Failed folder drafts must not become later ordinary saves

- **Trap:** Import, cloud sync and instructions editors changed live folder data before saving. A failed save
  kept the dialog open, but cancelling it left the draft in memory and recovery backups; the next
  ordinary edit could persist the cancelled import, including an overwrite of existing folders.
- **Rule:** Persist drafts through `FolderStore.replaceData` (backed by `FolderRepository`) or AI Studio's `replaceData`, then
  publish them only on success. AI Studio writes merged folders and prompts in the same storage call.
  Track migration writes as well as ordinary saves, and finish accepted writes first; keep the current account's editing controls
  disabled during replacement so old live snapshots cannot overwrite the draft. Keep drafts out of
  emergency/unload backups, retain the account owner while replacing, and submit an issued write's
  successful result only to that owner. A draft still waiting for ordinary writes is abandoned when
  its account activation ends.
- **Guard:** `src/pages/content/folder/__tests__/folderImportPersistence.test.ts` exercises the real
  manager UI through failed merge/overwrite, cancellation, a later ordinary save and successful retry.
  `src/pages/content/folder/FolderStorePersistence.test.ts` covers failed instructions, queued writes,
  debounce/unload backups and account changes while a draft is pending.
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts` covers failed import/sync drafts,
  recovery slots, later ordinary edits and account changes before/after issuing the draft write.

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

## Google Drive backup folders need a stable identity beyond their display name

- **Trap:** Drive folder discovery used only the exact display name, while its stable file ID lived
  in memory and the folder had no app-owned marker. A rename, product-name migration, lost cache, or
  concurrent first resolution could therefore create duplicate root backup folders.
- **Rule:** Tag `Voyager Data` with private `appProperties` marker `voyagerDataFolder=1` and resolve
  marked folders first. Recover pre-marker renames from known sync-file parents, rename only an
  unambiguous legacy folder in place, serialize first resolution, and preserve custom names after
  marking. If canonical and legacy folders coexist, never delete or rename either automatically.
  Search inside the resolved folder before global fallback.
- **Guard:** `src/core/services/__tests__/GoogleDriveSyncService.test.ts` and
  `Voyager/Tests/NativeSupportTests.swift` cover identity and unambiguous migration. A live Drive
  check must preserve folder ID, parent, and JSON while changing only the legacy display name.

## Gemini turn identity must not come from the mounted DOM index

- **Trap:** Gemini virtualizes long conversations, so the first mounted node after reload might be
  turn 60 but receive DOM index `u-0`. Using that index moved stars to wrong turns and could delete
  the original bookmark when unstarred. Prompt text is not identity because it can repeat, change,
  truncate, or render differently.
- **Rule:** Use response `rid` as canonical `s-<rid>` identity. Cache the bounded complete ordered
  ID list from `hNvQHb`, including unmounted turns, and use it to map legacy `u-N` records. Never
  infer aliases from the mounted DOM or prompt text. Without the complete map, retain the legacy
  record but do not show, migrate, or delete it. Timeline, hierarchy, timestamps, forks, highlights,
  and exports share this resolver.
- **Guard:** `src/pages/content/timeline/__tests__/starredResolution.test.ts`,
  `src/pages/content/timeline/__tests__/TimelineStateStars.test.ts`,
  `src/pages/content/timeline/__tests__/TimelineStateIdentity.test.ts`, and
  `src/pages/content/timestamp/__tests__/historyTimestamps.test.ts` cover complete-map identity and
  safe legacy handling.

## A failed account-scope resolution must retry, not leave the folder store unbound

- **Trap:** `FolderStore.refreshAccountScope()` (now `FolderRepository.refreshAccountScope()`) clears `dataSession` before resolving, and its catch
  only logged. One failed round trip therefore left the store unbound for the rest of the page load:
  the panel rendered empty even though the account bucket held folders, and every later edit was
  applied in memory and repainted while `saveData()` dropped it at the `!session` guard — a folder
  the user created looked saved and was gone on reload. Firefox is the only target that resolves the
  scope through the background page (`AccountIsolationService.shouldResolveScopeInBackground`), so
  it alone can fail this way. `aistudio.ts` recovered through its 1200 ms account poller and now
  also shares the repository retry. Nothing self-healed until the next SPA account-route change.
- **Rule:** Retry a failed resolution a bounded number of times with growing gaps, then stop. Never
  fall back to the global `gvFolderData` bucket — an ownerless bucket can belong to another account.
  Clear the pending retry in `destroy()` and let a newer `accountScopeRequest` supersede it.
- **Guard:** `src/pages/content/folder/FolderStore.test.ts`
  (`retries a failed account-scope resolution instead of staying unbound`,
  `gives up after a bounded number of account-scope retries`).

## AI Studio folders must not inherit Gemini's load-time repairs

- **Trap:** `FolderRepository` was extracted from Gemini's `FolderStore`, whose load repairs data
  before anyone sees it. On AI Studio data those repairs are destructive. The orphan cleanup keeps
  only folder ids plus `rootBucketId`, so with Gemini's `__root_conversations__` it deletes AI
  Studio's `__uncategorized__` bucket, which holds every root-level prompt, and the next save
  writes that loss. `normalizeFolderData` seeds a missing `sortIndex` by name and dedupes refs, but
  AI Studio data has no `sortIndex` and renders folders by `createdAt`, so the seed fixes an order
  users never chose. The default content adapter would also mirror the bucket into page
  localStorage, which AI Studio never wrote.
- **Rule:** Platform behavior lives in `PlatformFolderConfig`. `AISTUDIO_FOLDER_CONFIG` keeps
  `rootBucketId: '__uncategorized__'`, `normalize: keepFolderData`, `pruneOrphanBuckets: false`, a
  whole-bucket legacy copy, backup recovery for a missing bucket and no write retry, and uses
  `AIStudioFolderStorageAdapter` (chrome.storage.local only). To normalize AI Studio data later,
  first seed `sortIndex` from the order users see (pinned, then `createdAt`), and only then
  normalize. Keys and the `aistudio-folders` backup namespace are frozen.
- **Guard:** `src/pages/content/folder/__tests__/aistudioPersistenceCharacterization.test.ts`
  (`loads stored data raw, without normalizing, pruning or writing back`,
  `saves exactly the loaded content, keeping orphan, root and duplicate buckets`) and
  `src/pages/content/folder/__tests__/aistudioFolderSync.test.ts`.

## AI Studio must consume legacy sync folders only once per target key

- **Trap:** AI Studio init merged the legacy `chrome.storage.sync` folder bucket into the global
  local key on every page load, before account binding. Its union merge restored folders and
  prompts the user had deleted, and a later global-to-scoped seed copied those resurrected items.
- **Trap 2:** `validateFolderData` accepted `folderContents: null` because `typeof null` is
  `'object'`, so a local `{ folders: [], folderContents: null }` counted as authoritative: the
  import was skipped and marked done for good, and the shared tree threw on `Object.hasOwn(null)`.
- **Rule:** `migrateAIStudioLegacySync` records `${targetKey}:legacySyncImported` in
  `chrome.storage.local`. An existing valid local bucket, including an empty one, is authoritative:
  mark it without merging, because missing legacy items may be intentional deletions. Otherwise
  copy validated legacy bytes unchanged, then record completion only after the data write succeeds.
  Never delete or rewrite the sync source. Retry failed reads/writes without recording completion;
  a saved copy with a failed marker write is authoritative on retry. Keep the manager's global
  migration before account binding and its scoped seed policy unchanged. Use the native per-key
  lock when available and re-read the local target after reading sync to preserve intervening saves.
  A valid bucket has an array `folders` and a non-null object `folderContents`; anything else is
  replaced by the legacy copy before the marker is written.
- **Guard:** `src/pages/content/folder/__tests__/aistudioPersistenceCharacterization.test.ts`
  (`sync to local migration`), including real-manager deletion/re-init/scoped-seed coverage,
  delayed and failed writes, durable independent markers, untouched legacy sources and `replaces a
local bucket with null contents by the legacy copy before marking it`.

## A native feature's stop must remove everything its start registered

- **Trap:** `initI18n()` added a fresh anonymous `storage.onChanged` listener on every call and
  never removed one, and Usage Status calls it again on its own start, so each start stacked another
  listener. Gems Hider returned a cleanup that `index.tsx` never registered, so its observer and
  injected style outlived page teardown. Neither showed up in a feature test: each module's own
  tests exercise its behavior, not what it leaves on the page.
- **Rule:** A Gemini / AI Studio native module that returns a stop is registered in
  `src/pages/content/nativeFeatures.ts` and started only through that entry; its stop removes every
  listener, observer, timer, storage subscription and injected node the start created, and shared
  infrastructure such as i18n registers its page-wide listener once. Popup toggles mount and stop the
  feature through `createNativeFeatureToggle`, never by unmounting on a sidebar remount or an
  account change, which keep their own lifetimes. Use `inertReason` only for a start that
  legitimately does nothing under the Gemini fixture, never to hide a leak.
- **Guard:** `src/pages/content/__tests__/nativeFeatureLifecycle.test.ts` (every registered
  feature: `start → stop leaves the page as it found it`) and
  `src/pages/content/__tests__/featureLifecycle.test.ts` (toggle ordering).

## Google OAuth redirects must stay on domains we can verify

- **Trap:** Google brand verification requires every authorized domain to be verified in Search
  Console. Registering `https://<id>.chromiumapp.org/` or `https://<hash>.extensions.allizom.org/`
  as redirect URIs adds `chromiumapp.org` and `allizom.org`, which we cannot verify. A relay on our
  own domain works for Chromium, which only watches the final hop, but Firefox rejects any
  `redirect_uri` other than `getRedirectURL()` or `http://127.0.0.1/mozoauth2/<hash>` with
  `redirect_uri not allowed`, before Google is ever contacted.
- **Rule:** Chromium sends `redirect_uri=https://voyager.nagi.fun/oauth/callback/` with
  `state=<extension id>.<nonce>`; the relay forwards only to allowlisted ids, and the extension
  rejects a mismatched state. Firefox uses the loopback with a Desktop client and PKCE. A new Chrome
  or Edge listing id goes into the allowlist in `docs/public/oauth/callback/relay.js`; the Cloud
  Console keeps the single relay URI.
- **Guard:** `src/core/services/__tests__/googleOAuthWebFlow.test.ts`.

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
  `src/pages/content/folder/FolderTransferController.ts` is two writes: folders through
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

## A prompt import or Drive merge must not re-sort the library

- **Trap:** `mergeImportedPrompts` ended by sorting the whole library newest-first by
  `createdAt`. It backs the owner's `import` op, so every popup file import and both prompts-only
  Drive merges (pull, and push, which merges before it uploads) silently threw away the manual
  order the Prompt Manager stores as array position. Existing tests either used prompts that were
  already newest-first or shared one `createdAt`, which a stable sort leaves alone, or asserted
  the newest-first order outright.
- **Rule:** Array position is the manual order; there is no order field or library-level reorder
  time, and the stored and Drive formats stay that way. Stored prompts keep their positions
  whatever order the incoming list uses. An added prompt goes right after the nearest earlier
  incoming prompt that matched a stored one, or to the front when none did; prompts sharing a
  place keep their incoming order. Only a stored prompt anchors: grouping under a prompt the same
  import added would drop it from the output. Pins (`pinnedAt`) are never changed by placement.
  So a pull never reorders local prompts and a push gives Drive the pushing device's order; a
  reorder made on another device does not arrive through a merge. Order tests must store prompts
  whose array order is not newest-first and assert exact id order.
- **Guard:** `src/features/prompt/library/__tests__/promptImportOrder.test.ts` and
  `src/pages/background/__tests__/promptDriveMergeOrder.test.ts` (`round-trips between two
devices: the pusher sets Drive, a puller keeps its own order`).

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

## Bind account-scoped writes to the scope at action time

- **Trap:** Research Pack resolved its storage key when a queued op finally ran, so an answer added
  under one account could be written to another after an account or isolation switch, and the panel
  kept exporting the old global pack after isolation turned on. `isIsolationEnabled` also reads a
  storage failure as "off", which falls back to the shared global pack.
- **Rule:** Resolve an account-scoped key from a context snapshot taken when the user acts, hide the
  old scope's content on a switch, drop async results for a scope that is no longer shown, and fail
  closed (no read, no write) when the isolation setting cannot be read.
- **Guard:** `src/pages/content/researchPack/__tests__/researchPackScope.test.ts` and
  `src/pages/content/researchPack/__tests__/scope.test.ts`
  (`fails closed when the isolation setting cannot be read`).

## Any context change that maps to another key is one scope switch

- **Trap:** Research Pack special-cased each way a page changes account (route change, a late
  email, isolation toggle), and every round of patches left another race. At startup a reused
  `/u/0/` route can still alias the account that last used it, so the pack bound account A while
  the page belonged to B. A pending A→B check was then reused when the email became C, and the
  new pack's first load overwrote what the user typed while it was pending.
- **Rule:** Derive one identity from everything the key depends on (platform, route, email,
  isolation setting). Resolve each new identity in a check tagged with it, and drop the check if
  the identity moves on. Only a different resolved key switches the pack. On a switch, save
  pending typing to the old key, then clear and lock the panel until the new pack's first
  snapshot. Add uses the key for the page at click time and waits for its check if one is running.
- **Guard:** `src/pages/content/researchPack/__tests__/researchPackScope.test.ts`
  (`when the account email shows up after the scope was bound`).

## Order snapshots of shared state by a revision from its writer

- **Trap:** Research Pack tabs ordered results by when their own requests started. That does not
  order the data: a load started by one write's storage event could read before a second write
  landed, then render after it and bring back the older pack, which Copy and Insert then exported.
- **Rule:** The single writer sets every write's `revision` to one past the stored one; a tab
  renders a snapshot of the pack on screen only if its revision is at least the displayed one.
  Storage events carry the written value, so they need no reload. A removal restarts revisions at 1,
  so revisions only order snapshots within one generation: a tab starts a new generation when the
  pack on screen is removed or another pack is put on screen, and drops every load or apply answer
  asked for in an earlier one. Storage events arrive in order, so the first write after a removal is
  accepted at any revision. Floors or clock-stamped revisions cannot do this: a clock behind the old
  revision, or a removal the tab never saw, still lets a stale snapshot win.
- **Guard:** `src/pages/content/researchPack/__tests__/researchPackScope.test.ts`
  (`never puts an older snapshot back after a newer add has rendered`),
  `src/pages/content/researchPack/__tests__/researchPackRecovery.test.ts`
  (`when the pack is removed`) and
  `src/features/researchPack/services/__tests__/packStore.test.ts`
  (`bumps the revision on every write it makes, and only then`).

## A failed scope or load must stay retryable

- **Trap:** Research Pack cached a scope that failed to resolve as settled, so after storage
  recovered no scan or Add tried again, and a failed first load left the panel locked with no way
  out. Retry then sat in a closed panel whose launcher hid itself for an empty pack.
- **Rule:** Fail closed, but not for good. A user action (Add, Retry) resolves a failed scope
  again; a failed load shows an error with Retry, and editing stays blocked until a snapshot
  renders. The launcher stays on screen with an error badge while that lasts, so Retry is always
  reachable. Scans do not retry, so a broken setting is not hammered on every DOM change. Tests
  click through the visible path, because jsdom clicks hidden buttons too.
- **Guard:** `src/pages/content/researchPack/__tests__/researchPackRecovery.test.ts`.

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

## A failed folder read is not an absent bucket

- **Trap:** The folder adapters caught a failed storage read (an invalidated extension context, a
  transient storage error, Safari's `browser.storage` read falling back to an empty page copy) and
  returned `null`, the same answer as "nothing stored". Gemini then started empty and editable, so
  the next edit wrote a near-empty bucket over the real one; a scoped account bound an empty bucket
  and never ran its legacy migration; a rejected read went through backup recovery, which wrote an
  older backup over newer data. A full page localStorage turned a good read into a failed one
  through the page-mirror `setItem`, and a rejected `chrome.storage.local` write still reported
  success although loads read that store first.
- **Rule:** `IFolderStorageAdapter.loadData` rejects when storage cannot be read, resolves `null`
  only when nothing is stored, and returns the stored value unvalidated (unparseable JSON comes
  back as is, so validation sends it to corrupt-data recovery). Safari reads have no page fallback.
  A failed page-mirror `setItem` after a good read still returns the data; a failed
  `chrome.storage.local` write fails the save. `FolderRepository.loadData` classifies a rejection
  of the bucket read or the legacy read: no migration, recovery, empty state or write. A session
  that never loaded stays not ready (`canEdit` false) and reports `unreadable`; a loaded one keeps
  memory and reports `kept`, once per outage. The owner's reload hook retries with backoff
  (1 s → 30 s, repeating) until a read lands, except for an invalidated extension context; the
  timer is cleared on account switch, suspend and destroy.
- **Guard:** `src/pages/content/folder/__tests__/folderStorePersistenceCharacterization.test.ts`
  (`stays read-only and writes nothing when the first read fails, until a retry reads`, `leaves
newer stored data alone when a reload cannot read it, and reads it on retry`),
  `src/pages/content/folder/storage/__tests__/FolderStorageAdapter.test.ts` and
  `src/pages/content/folder/storage/__tests__/FolderStorageAdapter.safari.test.ts` (`rejects a
failed read instead of answering from the page copy or as absent`).

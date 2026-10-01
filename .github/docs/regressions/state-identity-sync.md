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
- **Rule:** An unsuppressed event for the active bucket only marks `FolderRepository` as needing a
  reconcile. `tryReconcile()` waits while a write or replacement is in flight (persist and
  `replaceData` resume it), then calls the owner's reload hook. Every load merges edits still
  waiting on the debounce onto the fresh data with `mergeDebouncedEdits`, against
  `session.baseline` (what this tab last read or wrote), so debounced edits may only touch
  expand/collapse and conversation timestamps. Echo suppression is only an optimisation: a wrongly
  unsuppressed echo costs one reload of this tab's own data. Limit: an immediate save issued while
  the reload read is in flight, or a snapshot already queued behind an in-flight write, is still
  whole-snapshot last-writer-wins.
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
- **Rule:** `render()` detaches the open editor with `detachInlineDraft` and puts the same node
  back beside its folder with its text, focus and selection; a rename whose folder is gone is
  dropped, and `releaseAccountUi` discards drafts. Editors resolve their folder and header when
  saving or cancelling, and remove themselves before re-rendering. Gemini's
  `FolderTreeView.render()` still closes inline editors on every rebuild.
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

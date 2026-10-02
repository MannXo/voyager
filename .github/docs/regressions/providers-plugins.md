# Providers and plugins regression notes

Read this file when changing ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff,
or prompt commands.

## A plugin's shadow panel gets the key guard from its own document_start registration

- **Trap:** The plugin host is registered at document_idle, after the page's own capture-phase key
  listeners, so a guard installed by the plugin can never run first. Folding the guard into the
  host's `registerContentScripts` call, or importing it from the background, would tie a guard
  failure to the plugin host or turn the guard into a module that loads too late.
- **Rule:** A plugin whose pages host a shadow-root panel with text fields is listed in
  `SHADOW_KEY_GUARD_PLUGIN_IDS` (`src/pages/background/shadowKeyGuardRegistration.ts`). The
  background registers the manifest's self-contained guard file at document_start for that
  plugin's granted top-frame origins, under `gv-shadow-key-guard` and in its own call, and removes
  it when the plugin is off. Tabs open before the plugin is turned on rely on the panel's bubble
  interception until they reload.
- **Guard:** `src/pages/background/__tests__/shadowKeyGuardRegistration.test.ts` and
  `src/pages/content/shadowKeyGuard/__tests__/shadowKeyGuardEntry.test.ts`
  (`is the only source that imports the guard`).

## ChatGPT virtual shells must be repositioned after height reconciliation

- **Trap:** Exporting a cold, long ChatGPT conversation could fail with
  `chatgpt_export_message_unavailable:<turn-id>` even though the selected message was present and
  became exportable after manually scrolling to it. The materializer called `scrollIntoView()` only
  once. Mounting nearby turns made ChatGPT replace estimated virtual-shell heights with measured
  heights, which could move the requested shell several viewports away before it mounted. The
  remaining timeout loop only polled the offscreen shell and never corrected its position.
- **Rule:** While a requested shell remains unmounted, re-anchor it at a throttled interval only
  when height reconciliation has moved it outside the viewport.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`repositions a virtual shell that moves offscreen after height reconciliation`).

## ChatGPT bookkeeping roots and message-less turns must not abort the export

- **Trap:** Exporting a ChatGPT conversation opened from history failed with
  `chatgpt_export_message_unavailable:paginated-root:<conversation-id>`, surfaced to the user as the
  generic "refresh and retry" alert, and select mode showed a phantom checkbox above the first
  message. ChatGPT stores its virtual-list roots in the same `data-turn-id-container` attribute as
  turns: `client-created-root` for a conversation started in the tab and `paginated-root:<id>` for
  one opened from history; only the first was excluded. A turn whose response rendered nothing
  (`section[data-turn="assistant"]` without any `[data-message-author-role]`) then hit the same
  timeout because it looked like an unmounted virtual shell.
- **Rule:** Skip every `*-root` container. Resolve the role from `[data-turn]` when no message root
  exists, and once a mounted frame stays message-less through the settle window treat the turn as
  empty: count it as handled, export nothing for it, and keep pairing sequence-based so the
  preceding prompt becomes a user-only turn. A frame-less shell must still time out.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`ignores the paginated history root the same way`,
  `resolves the role from the turn frame when ChatGPT renders a turn without a message`,
  `skips a rendered turn without a message instead of failing the export`,
  `fails when a selected virtual shell never mounts`).

## ChatGPT export reads the live thread whole or not at all

- **Trap:** ChatGPT's current thread is a virtual list of `[data-turn-key]` items that mount and
  unmount whole (5–7 in the DOM), inside a `column-reverse` scroller, with older history paged in
  only while the scroller sits at the top. The export still targeted `[data-turn-id-container]`,
  so full and selection export found nothing, and walking whatever was mounted would have
  exported the last few turns silently. ChatGPT also keeps earlier conversations in hidden
  (`display: none`) pages whose `main` comes first in the DOM, so `querySelector('main')` read
  the wrong conversation.
- **Rule:** Resolve the root as the first rendered `main`. Before selection mode, the adapter's
  `prepareConversation` loads history until the spinner inside
  `[data-chatgpt-conversation-selection-target]` is gone and the top holds still, then walks
  down keeping the last recorded item mounted in every window and extracts each item while it is
  mounted (`<turn key>:u` / `:a`). Any unproven start, gap, or missing bottom, or a reply still
  generating, fails the crawl: the selection list is then empty and the existing warning shows.
  The reader's scroll position is restored either way. The scroller is the nearest ancestor
  styled to scroll, whether or not it overflows yet: a first page that fits the viewport made the
  crawl scroll the window and silently start at the first loaded turn. An uncrawled live thread
  also lists nothing. The two entries above cover only the earlier `[data-turn-id-container]` DOM, which
  keeps its own path.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`reads every turn of a virtualized thread that unmounts items while scrolling`,
  `loads paginated history before reading, so the first turn is the conversation start`,
  `keeps scrolling the thread when it overflows only once older history loads`,
  `reads the visible page, not a cached conversation ChatGPT keeps hidden before it`,
  `fails when every scroll skips past the recorded turns, rather than leaving a gap`,
  `fails instead of starting mid-thread when older history never finishes loading`,
  `offers nothing to select when the crawl cannot prove the thread complete`,
  `restores the scroll position when the crawl fails`).

## ChatGPT crawl reads only windows rendered for its scroll position

- **Trap:** Stable keys and scroll range do not prove the virtual list rendered for the current
  position. A remount slower than the settle interval left the reader's window mounted after the
  scroll to the top, and the walk read it as the start; a list that stopped rendering exported a
  suffix as the whole thread.
- **Rule:** A window counts only once its items cover the visible part of the box ChatGPT sizes to
  the whole list (the item's ancestor directly under the selection target) and hold still; a
  timeout throws `chatgpt_export_thread_unsettled`. The start also needs the spinner gone and the
  first item at the box's top, the end the last item at its bottom.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`fails instead of reading a stale window that never moves to the scroll position`,
  `waits for a window that renders later than it would otherwise count as settled`).

## ChatGPT crawl never mixes conversation branches

- **Trap:** A regenerated reply or a branch switch keeps the turn key (the prompt's message id), so
  skipping keys already read could keep one branch's answer and append another branch's later
  turns, and a snapshot read before the switch stayed exportable.
- **Rule:** Record each item's message ids (`data-chatgpt-search-message-ids` and the reply's
  `data-chatgpt-selection-message-id`). An item seen again with other ids fails the crawl with
  `chatgpt_export_thread_changed`, and a mounted item that differs from the snapshot drops it.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`fails when a branch switch changes a turn it already read, rather than mixing branches`,
  `drops the crawl once a mounted turn switches branch after it was read`).

## ChatGPT snapshot treats an unread mounted turn as a change

- **Trap:** Switching to an edited prompt's branch gives that prompt and every later turn new
  keys. Validation that compared only keys it had read ignored the new turns, so the old branch's
  snapshot stayed exportable on the same URL.
- **Rule:** A mounted turn whose key the crawl did not read drops the snapshot, as a changed
  fingerprint does; both go through `mountedTurnChanged` in `chatgptThreadWatch.ts`.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`drops the crawl once the reader switches to an edited prompt's branch of the same length`).

## ChatGPT snapshot watches for branch switches on turns that later unmount

- **Trap:** Checking only mounted turns missed a branch switch on a turn that unmounted before the
  check: scrolled away later, never revisited by the crawl, or gone in the same task as the
  switch, so the export mixed branches.
- **Rule:** `watchThreadVersions` observes the list from the start of the crawl and reads each
  mutation record's own nodes (the changed element's item, added items and items inside added
  subtrees, detached or not), and drains pending records whenever the snapshot is read. Live, 92
  remounts of 49 turns and 10 history pages loading under the watch kept every turn's message ids
  and the same `main`, so remounting or pagination alone never trips it.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`drops the crawl when a turn switches branch and scrolls out of view before the export`,
  `drops the crawl when a turn re-renders as another branch and unmounts in the same task`,
  `drops the crawl when a turn's ids change in place and it unmounts in the same task`,
  `keeps the crawl when turns mount and unmount in the same task without changing`).

## ChatGPT thread watch ends with the export session

- **Trap:** A successful preparation kept its thread watch after the selection was exported,
  cancelled or torn down, so every later mutation in the conversation rescanned turns.
- **Rule:** `runPreparedExport` (`src/pages/content/export/preparedExport.ts`) calls `release()` on
  what the adapter's `prepareConversation` returned once the selection session settles, however it
  ends; ChatGPT's release forgets the crawl and stops the watch.
- **Guard:** `src/pages/content/export/__tests__/preparedExport.test.ts`
  (`watches the ChatGPT thread during selection and stops once the session ends`,
  `stops watching the ChatGPT thread when the session fails`).

## A late ChatGPT export cleanup leaves the newer export intact

- **Trap:** The crawl's scroll restore cannot be cancelled, so a new export could start preparing
  while the cancelled one was still restoring; the old export's cleanup then cleared the global
  snapshot and watch the new one had just made, and the new export listed an empty conversation.
- **Rule:** `prepareConversation` resolves a `ConversationPreparation` whose `release()` is bound to
  that preparation's generation and does nothing once a newer preparation has started;
  `runPreparedExport` releases only what its own preparation returned.
- **Guard:** `src/pages/content/export/__tests__/preparedExport.test.ts`
  (`leaves the export that replaced one cancelled during its scroll restore intact`,
  `ignores a release from a preparation that a newer one replaced`).

## ChatGPT export publishes only its latest, uncancelled crawl

- **Trap:** Restoring the scroll position cannot be cancelled, so a preparation cancelled meanwhile,
  or superseded by a newer one on the same route, could publish its crawl over the newer attempt
  and leave stale content exportable after the newer one failed.
- **Rule:** The crawl rechecks cancellation after restoring, and only the latest preparation
  publishes. The crawl's progress pill (`gv-export-crawl-progress`) aborts only the crawl, so
  Cancel restores the scroll and the export ends quietly with no file and no warning.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts`
  (`does not let a superseded preparation publish over a newer one that failed`,
  `does not publish a preparation cancelled while it restores the scroll position`);
  `src/pages/content/export/__tests__/chatgptCrawlProgress.test.ts`
  (`cancels from its button: restores the scroll, keeps nothing and rejects quietly`).

## ChatGPT export entry point only where a conversation can exist

- **Trap:** The ChatGPT export plugin matches the whole origin, and the persistent toolbar was
  mounted as soon as the plugin started, so it also appeared on Codex, settings and library pages
  where nothing can be exported, and stayed there as the SPA moved between such pages and chats.
- **Rule:** Platforms whose chat UI shares an origin with unrelated pages implement
  `isConversationPage(doc, url)` on their export adapter; `startExportEntryGate` mounts the entry
  point only while it returns true and re-checks on route changes and settled DOM mutations. For
  ChatGPT that is a `/c/<id>` route (optionally under `/u/<n>/` or `/g/<gpt>/`) or a rendered
  turn, because a temporary chat keeps `/?temporary-chat=true`.
- **Guard:** `src/pages/content/export/adapter/__tests__/chatgpt.test.ts`
  (`chatgptIsConversationPage`),
  `src/pages/content/export/adapter/__tests__/chatgptThreadExport.test.ts` (`accepts a rendered
turn on a route without a conversation id`),
  `src/pages/content/export/__tests__/exportEntryGate.test.ts`.

## ChatGPT export toolbar must avoid the native header cluster

- **Trap:** The ChatGPT persistent export button sat at `top: 50px` / `right: 84px` and covered
  Share, the more menu, or the conversation title. Avoidance only knew Gemini top-bar selectors, so
  ChatGPT header actions never pushed the toolbar left.
- **Rule:** Keep the ChatGPT toolbar on the header row and include `#conversation-header-actions`
  plus Share / conversation-options in the top-right avoidance list.
- **Guard:** `src/pages/content/export/__tests__/persistentExportToolbar.test.ts`
  (`moves left to avoid ChatGPT header share actions`).

## Export toolbar avoidance must not re-measure on unrelated page mutations

- **Trap:** The persistent export toolbar (on by default on lr26 Gemini and ChatGPT) observes all
  of `body` for child and `class`/`style`/`hidden`/`aria-hidden` changes. Each frame with any
  mutation re-ran a document-wide query with substring selectors such as `[aria-label*="pro" i]`,
  which can match any label containing "prompt" or "project", and read every match's rect, so
  sidebar loading and response streaming forced layout per frame (#1040). It also rewrote its own
  offset each time; same-value `style.setProperty` queues no mutation record in Chromium 151,
  Firefox or jsdom, so this was one extra pass after each change, not an endless loop. Filtering
  records only by the avoided controls missed lr26's full-width `top-bar-actions`: a non-matching
  button inserted there pushes the controls left without touching them. Dropping zero-size matches
  from the watch set also dropped their ancestors, so a header revealed by a parent `class`,
  `style` or `hidden` change left the toolbar overlapping it until the next resize.
- **Rule:** Skip records inside the toolbar. Re-measure only when an added node is or contains an
  avoided control, a removed node or attribute target is a watched element or its ancestor, a
  change lands inside a watched element, or an attribute target itself matches the selectors.
  Watched elements are the measured controls plus visible top-band matches that span past the
  right-side cluster; the latter never enter the offset. Track zero-size matches of the specific
  top-bar selectors and their ancestors separately: an attribute change there re-measures, but
  they never enter the offset. Never track hidden matches of the broad substring selectors; hidden
  per-message buttons such as "Copy prompt" would put every chat turn's ancestry under watch. Read each
  rect once and write the offset only when it changes.
- **Guard:** `src/pages/content/export/__tests__/persistentExportToolbar.test.ts`
  (`does not query or measure while unrelated content streams into the page`,
  `settles after one measurement instead of re-triggering itself`,
  `follows controls pushed left inside a full-width top-bar host`,
  `follows a top-right control that grows or hides`,
  `moves aside when an ancestor class change reveals it, and back when it hides`,
  `does not measure for attribute churn outside its ancestry`,
  `does not measure when turns with hidden per-message buttons change class`).

## ChatGPT export UI must belong to the active plugin lifecycle

- **Trap:** Rapidly disabling and re-enabling the ChatGPT exporter could let a stale startup remove
  the replacement toolbar. Disabling while export preferences were still loading could also show a
  dialog after the plugin was already off. Asynchronous startup and dialog loading were not tied to
  an abortable plugin lifecycle, while repeated toolbar mounts shared one DOM root without
  ownership.
- **Rule:** Pass the plugin lifecycle signal through startup and dialog loading, replace the shared
  toolbar's click handler on remount, and allow only the current owner to remove the shared root.
- **Guard:** `src/features/plugins/builtin/chatgptExport/runtime.test.ts`
  (`aborts the stale lifecycle before starting a replacement`) and
  `src/pages/content/export/__tests__/persistentExportToolbar.test.ts`
  (`does not duplicate-mount; second call updates text on existing instance`).

## Temporary-chat handoff state must stay private and tab-scoped

- **Trap:** ChatGPT can reuse its composer, expose unrelated textboxes, replace the accepted
  composer later, or render multiline text differently from `textContent`. Page `sessionStorage`,
  node-replacement assumptions, and broad async guards let payloads leak across editors, vanish
  during hard navigation, replay after cancellation, or restore a late attachment after the user
  edited the composer.
- **Rule:** Resolve ChatGPT composers in selector-priority order and accept a usable same-node
  composer. Keep transcripts in extension storage behind expiring tab-scoped tokens. Bind delivered
  recovery to the exact chat route and cancel it on route mismatch, edit, send, native New Chat,
  plugin disposal, or expiry. Carry a synchronous cancellation revision across async storage,
  insertion, and preview work. Mark hard navigation before root teardown, keep progress mounted
  through departure bookkeeping, sweep expired keys, and suppress cancellation only around the
  plugin's synchronous navigation clicks. Fail closed during generation, an incomplete final user
  turn, or a turn-identity change during collection.
- **Guard:** `src/features/plugins/builtin/chatgptTemporaryHandoff/handoff.test.ts` and
  `src/features/plugins/builtin/chatgptTemporaryHandoff/index.test.ts` cover composer reuse and
  isolation, multiline verification, route-bound recovery, cancellation at every async boundary,
  hard navigation, expiry, generation and turn guards, and attachment preview races.

## Temporary-chat handoff reads the current thread and composer

- **Trap:** The handoff collected turns through the earlier `[data-turn-id-container]` DOM, so on
  ChatGPT's current virtualized thread it found nothing and reported an empty conversation. Its
  composer lookup needed `#prompt-textarea` or a `data-testid` send button; the current composer is
  a ProseMirror textbox in `form[data-chatgpt-composer]` whose submit button has only a localized
  aria-label, so no composer was found to deliver into.
- **Rule:** On the current DOM, read the whole thread with the export's crawl
  (`readChatGptThreadTurns`), which refuses a reply still pending or a thread that changed while it
  was read. Match the composer by `form[data-chatgpt-composer]` and its `button[type="submit"]`. The
  earlier DOM keeps its own collection path.
- **Guard:** `src/features/plugins/builtin/chatgptTemporaryHandoff/collectTurns.test.ts`
  (`reads every turn of the virtualized temporary chat`);
  `src/features/plugins/builtin/chatgptTemporaryHandoff/composer.test.ts`
  (`reads the draft and hands off through a composer whose send button has no test id`).

## Duplicate prompt names are a slash eligibility conflict, not invalid data

- **Trap:** Import or sync dropped Prompt records when names collided, while slash completion
  accepted every non-empty name and made historical duplicates ambiguous. Parallel Drive timestamp
  merges could also let a newer legacy record without `name` erase the local name.
- **Rule:** Preserve every Prompt record. Group names by one shared trimmed, NFKC-normalized,
  case-insensitive key; exclude the whole duplicate group from slash completion and show a
  non-blocking Prompt Manager badge until resolved. Route every Drive merge through the shared
  helper, which retains a local name when the newer cloud record predates prompt names.
- **Guard:** `src/features/backup/services/__tests__/PromptImportExportService.test.ts`
  `src/utils/merge.test.ts` `src/pages/content/folder/__tests__/FolderTransferController.test.ts`
  `src/pages/content/folder/__tests__/aistudioAuditFixes.test.ts`
  `src/pages/content/prompt/__tests__/promptName.test.ts`
  `src/pages/content/prompt/__tests__/slashMatch.test.ts`
  `src/pages/background/__tests__/runtimeMessageRouting.test.ts`

## Prompt Manager coverage on plugin platforms listens before it mounts

- **Trap:** The content script mounted the Prompt Manager from the startup coverage read and only
  then registered the storage listener. A user switching the site off while that read or the
  first mount was in flight was missed, and the Prompt Manager stayed mounted until a reload.
- **Rule:** Create the reconciler, register `handleChange`, then feed the startup read through
  `applyInitial()`; it is queued behind any change already handled and ignored when the listener
  has already seen a newer value.
- **Guard:** `src/pages/content/prompt/__tests__/customSiteCoverage.test.ts`
  (`queues a toggle-off that lands while the startup mount is in flight`,
  `ignores a startup read that is older than a change already handled`).

## Plugin content-script registration must unregister only registered ids

- **Trap:** The plugin sync batched the plugin, embedded-frame and Claude-usage script ids into
  one `unregisterContentScripts` call. Chrome rejects the whole call when any id is unknown, and
  the following `registerContentScripts` then failed on the duplicate id, so the registration
  froze on the first result of a session: enabling DeepSeek plugins after ChatGPT/Claude were
  already registered changed nothing until the extension restarted, and the popup showed the
  toggles on with no site injected.
- **Rule:** Before unregistering, list the registered scripts and unregister only the ids that
  exist (`src/pages/background/contentScriptRegistration.ts`). Never batch a possibly-absent
  companion id into an unregister call.
- **Guard:** `src/pages/background/__tests__/contentScriptRegistration.test.ts`
  (`drops only the ids that exist so a never-registered companion cannot block the batch`).

## Every plugin-state writer shares the local-plugin import's lock

- **Trap:** Import wrote the new version with `enabled: false` under the `gv-local-plugins` lock,
  but setting toggles, enable toggles and Drive restore were unlocked whole-map writes: one that
  read the old `enabled: true` before the import and wrote after it switched the new, unreviewed
  version back on. A content script (the turn navigator's style guide) wrote the map too, and its
  `navigator.locks` belongs to the page origin, so it can never share an extension-page lock. A
  plain restore of an older Drive copy also enabled the new version with no race at all.
- **Rule:** Every `PLUGINS_STATE` and `PLUGIN_LOCAL_MANIFESTS` write runs under
  `withPluginStorageLock` (`storage/pluginStorageLock.ts`); removing a local plugin drops its
  record and state in one write. Content scripts never write plugin state: they send
  `PLUGIN_SET_SETTING_MESSAGE` (`requestPluginSetting`) and the background writes under the lock;
  the request carries one setting value and cannot enable a plugin. Drive restore may switch a
  `local.*` plugin off, never on.
- **Guard:** `src/features/plugins/local/localPluginMutations.test.ts`
  (`a plugin-state write racing a re-import`, `restoring plugin state from Drive`),
  `src/pages/background/__tests__/pluginRuntimeMessages.test.ts`.

## A content-script setting write must be ours, declared and reported

- **Trap:** `gv.plugins.setSetting` stored any id/key/value from any sender, and the shared state
  writer swallowed storage errors, so the handler answered `ok: true` for a write that never
  happened and accepted keys no plugin declares.
- **Rule:** The background stores a setting only from our extension's content script in a tab the
  plugin's `matches` cover, only for a key in the plugin's `contributes.settings` with a value of
  that field's type (range/options included), and answers `untrusted_sender`, `invalid_payload` or
  `write_failed` otherwise. `setPluginSetting` resolves false when nothing was stored.
- **Guard:** `src/pages/background/__tests__/pluginRuntimeMessages.test.ts`
  (`refuses a sender that is …`, `rejects a setting the plugin does not declare that way`,
  `reports a failed storage write instead of ok`).

## A background plugin lookup must list with the page's catalog host

- **Trap:** The `gv.plugins.setSetting` check listed plugins with only `{ url }`. `HostCatalogSource`
  reads its cache by `context.host`, so a remote-only plugin was missing (its write answered
  `invalid_payload`) and a remote-updated settings schema was ignored.
- **Rule:** List with `{ url, host: catalogHostFromUrl(url) }`, the same context the page's
  `PluginHost` uses. `catalogHostFromUrl` is undefined on Gemini / AI Studio, so native surfaces
  still never read a catalog.
- **Guard:** `src/pages/background/__tests__/pluginRuntimeMessages.test.ts`
  (`plugin setting writes checked against the real plugin listing`).

## Research pack handoff picks its path inside the click

- **Trap:** "Continue in ChatGPT / Claude" can only copy to the clipboard inside the click: Safari
  requires the user gesture, and Chrome refuses the write once the new tab takes focus. A host
  permission alone does not mean Voyager runs on the target either, because the content script is
  registered only for origins of enabled plugins (or Prompt Manager sites). Deciding after asking
  the background, or from the permission alone, leaves the pack in a record nobody claims, or tries
  a copy after the gesture is gone.
- **Rule:** The Gemini tab picks the branch synchronously from a status cached when the panel
  opens; an unknown status means "cannot run there". The fallback calls `clipboard.writeText` first
  and asks the background to open the chat only after the copy succeeds. Readiness is the host
  permission plus a registered content script whose matches cover the new-chat URL, in a browser
  with `storage.session`. When the background finds the target no longer ready, it opens nothing
  and the user clicks again. A click in flight ignores further clicks, so a double click opens one
  tab. No URL carries the pack.
- **Guard:** `src/pages/content/researchPack/__tests__/continueIn.test.ts`,
  `src/features/researchPack/services/__tests__/handoff.test.ts` and
  `src/pages/background/__tests__/researchPackHandoff.test.ts`.

## Opening the Research Pack from the keyboard must close the Prompt Manager

- **Trap:** With the Prompt Manager open, activating the Research Pack launcher with Enter or Space
  opened the pack under it: the Prompt Manager panel (z-index 2147483200) outranks the pack
  (2147483100), so "Continue in Claude" landed on the prompt list and did nothing. The Prompt
  Manager closes only on an outside `pointerdown`, and a keyboard or scripted `click` sends none.
- **Rule:** A floating panel that opens over a light-dismiss panel announces it
  (`announceSurfaceOpened` in `src/pages/content/floatingSurfaces.ts`), and the Prompt Manager
  closes on that as it does on an outside click. A Prompt Manager opened over the pack is already
  on top, and the pack keeps not closing on outside clicks.
- **Guard:** `src/pages/content/__tests__/floatingSurfaceStacking.test.ts` and the Research Pack
  case in `src/pages/content/prompt/__tests__/stackingOrder.test.ts`.

## A handed-off research pack goes only into an empty main composer on the new chat

- **Trap:** The first receiver accepted any page on the target host and the adapter's composer
  selector, which on ChatGPT includes every `contenteditable`. A tab that had moved to another chat
  could still claim the pack, and the insert could land in a canvas or an edit-message box, or
  replace a draft or a selection, since `insertTextIntoChatInput` keeps a selection inside the
  input. The `storage.local` fallback could leave the plaintext on disk past its expiry when an
  alarm failed, and across a browser restart.
- **Rule:** Peek and claim only on the exact new-chat path (ChatGPT `/`, Claude `/new`; a query or
  hash is tolerated), and check the route, the document and the composer again after the claim.
  From the peek on, watch the Navigation API's `navigate` and `currententrychange`: any departure
  cancels the receiver for good, even if the tab comes back, because an SPA round trip such as `/`
  → `/c/A` → `/` keeps the document and may leave the old conversation's composer on screen. Only
  the Navigation API reports every same-document navigation as it happens, including the page's
  own `pushState`; a polling route watcher can miss a quick round trip, and an empty, unique
  composer on the right URL does not prove it belongs to the new chat. So a browser without the
  Navigation API cannot run the handoff: the Gemini click takes the clipboard path, and the
  receiver refuses to peek. Use each site's main composer selector, require exactly one, and
  require it to be empty: blank text and only the empty-editor skeleton (`<p>`, `<br>`,
  and ProseMirror's separator in its exact rendered shape, `<img class="ProseMirror-separator"
alt="">` with at most `mark-placeholder`, never a source or alt text), since an image or a
  mention chip has no text but is content.
  Collapse the selection to its end before inserting. Any failed check inserts nothing and points
  the user back to Gemini's Copy. Keep the record in `storage.session` only; without it, report
  every target unready.
- **Guard:** `src/pages/content/researchPack/__tests__/receiver.test.ts`,
  `src/pages/content/researchPack/__tests__/continueIn.test.ts` (`copies instead of handing off in
a browser without the Navigation API`),
  `src/features/researchPack/services/__tests__/handoff.test.ts` (`cannot be taken once its tab
has left the new-chat page`, `stores nothing and reports every target unready without
storage.session`) and `src/pages/background/__tests__/researchPackHandoffWiring.test.ts`.

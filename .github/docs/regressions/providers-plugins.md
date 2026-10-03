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

# Folders, timeline, and layout regression notes

Read this file when changing folders, timeline navigation, sidebar behavior, chat width, drag and
drop, or hover layout.

## Active folder rows must use the navigation route ID

- **Trap:** The active folder chat lost its background and accent even though the route and CSS were
  valid. Normalizing `c_<route-id>` and bare IDs fixed only one storage shape: legacy native
  fallbacks and imports can retain a synthetic ID such as `conv_*` while their saved URL still
  contains the real `/app/<route-id>`.
- **Rule:** Treat the saved navigation URL (or rendered row `href`) as the canonical route identity,
  with the stored ID only as a fallback. Keep the row's raw stored ID only for distinguishing the
  same conversation across multiple folders. Reuse that URL-first identity for account-scoped links
  and navigation; never migrate or rewrite user data just to repair highlighting.
- **Guard:** `src/pages/content/folder/__tests__/folderNavigation.test.ts`
  (`highlights an initially active legacy row from its stored conversation URL` and
  `uses the URL route id for legacy conversations in account-isolated links and navigation`).

## A folder id must never be a key every object inherits

- **Trap:** An imported folder with id `__proto__` and empty `folderContents` passed validation.
  `normalizeFolderData` tested `!folderContents[folder.id]`, which reads `Object.prototype` and is
  truthy, so the folder was saved with no array bucket and the floating tree's sorter threw on every
  load. Once such a folder is stored, any rebuild that assigns `contents[id] = list` into a fresh
  object (the Drive merge did) sets the prototype instead, drops the bucket, and sync saves the loss.
  Repairing a malformed bucket a folder does own to `[]` is no fix either: the load then succeeds and
  overwrites the primary backup that could have restored its conversations.
- **Rule:** Imports refuse a folder id or bucket key that is an inherited object key
  (`findInheritedFolderKey` in `src/features/folder/model/folderData.ts`), in the shared validator
  (Gemini, ChatGPT) and in `readAIStudioImportFile`. Every write that rebuilds `folderContents` by
  id goes through `setBucket` (an own-property `defineProperty`), and reads by id use `ownBucket`.
  The normalizer repairs only a missing, inherited or empty bucket; a non-array bucket that is owned
  throws, so the repository recovers from backup as before.
- **Guard:** `src/features/folder/model/__tests__/folderData.test.ts`
  (`gives folders named after inherited object keys real buckets of their own`,
  `refuses a malformed bucket a folder owns, so the load recovers a backup`),
  `src/utils/merge.test.ts` (`mergeFolderData with a folder stored as __proto__`),
  `src/pages/content/folder/__tests__/folderBucketRebuilds.test.ts` (the AI Studio legacy sync
  merge and the account route filter, which run before the load normalizes),
  `src/features/folder/model/__tests__/placeConversations.test.ts`
  (`placeConversations into a folder stored as __proto__`),
  `src/features/plugins/builtin/chatgptFolders/__tests__/ChatGptFolderStore.test.ts`
  (`recovers a backup when a folder owns a malformed bucket`),
  `src/features/folder/services/__tests__/FolderImportExportService.test.ts`
  (`rejects %s that every object inherits`),
  `src/features/plugins/builtin/chatgptFolders/__tests__/activate.test.ts`
  (`opens over stored folders named after inherited object keys`),
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts`
  (`loads stored folders named after inherited object keys`), and the
  `refuses a folder whose id every object inherits` cases in
  `src/pages/content/folder/__tests__/FolderTransferController.test.ts` and
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts`.

## Explicit native deletion must resolve identity at action time and wait for Gemini to settle

- **Trap:** Deleting the currently open conversation from Gemini's top menu left a dead folder
  entry. The lr26 trigger no longer exposes Voyager's expected test ID, and the menu can contain both
  strong conversation actions and Export to Docs. Even when deletion was captured, a single 300ms
  check permanently gave up while the old route or sidebar row was still mounted. Gemini can also
  rebuild the sidebar between Delete and confirmation; treating that transient reinitialization as a
  full teardown clears the pending conversation identity before confirmation arrives. The lr26
  virtual list can also retain a hidden native conversation row after the visible entry and route are
  gone, so raw DOM presence can block cleanup even after Gemini completes the deletion.
- **Rule:** Identify a Delete action from its live conversation menu, resolve its conversation from
  that menu context at click time, and only arm cleanup after native confirmation. Poll for a bounded
  window until both the route has left and the native row is absent; on timeout, preserve folder data.
  Preserve the document-level delete tracker, candidate identity, and candidate timeout across
  sidebar-only reinitialization. If Gemini's confirmation control is not recognizable, require an
  explicit native confirmation before scheduling cleanup or ignoring any hidden row. The
  rows hidden by Voyager's `.gv-conversation-archived` or
  `.gv-conversation-archived-actions` markers remain valid native conversations during ordinary
  checks. After an explicitly confirmed current-conversation deletion reaches its completion route,
  however, those markers may remain on Gemini's stale hidden row and must not override the rendered
  row check. The
  current-conversation transition to `/app?pageId=none` is only settlement evidence after that
  confirmation; it can never arm deletion by itself. A hidden stale native row may be ignored only
  for a tracked current-conversation deletion that was explicitly confirmed and reached that
  completion route; otherwise preserve it as deletion-rejection evidence. Bind the candidate and
  every delayed check to the storage key and `/u/<index>` route active when deletion began; treat
  bare `/app` and `/u/0/app` as the same default account, and discard the check if either account
  scope otherwise changes. Clear candidate state on explicit confirmation,
  cancellation (including Escape or overlay dismissal), full runtime teardown, or timeout. Strong
  pin/rename/delete markers take precedence over overlapping report/export markers.
- **Guard:** `src/pages/content/export/__tests__/conversationMenuInjection.test.ts`
  (`keeps current top conversation menus distinct when they also export to Docs`) and
  `src/pages/content/folder/NativeConversationMenus.test.ts`
  (`requires native confirmation, then waits for the current route and row to leave`,
  `checks the row itself after a confirmed current deletion with a %s`,
  `preserves a conversation after %s even when Gemini reaches pageId=none`,
  `preserves a hidden row when the current deletion never reaches its completion route`,
  `expires rejected deletion checks instead of deleting after a later unrelated navigation`, and
  `keeps an explicit deletion check across a transient native-row re-add`). Manager integration
  remains in `src/pages/content/folder/__tests__/observerBatching.test.ts`
  (`removes only the confirmed current conversation after sidebar reinitialization and settlement at %s`,
  `discards a pending native deletion after the %s changes`,
  `preserves folder entries when native deletion is cancelled after sidebar reinitialization`,
  and `clears native deletion on destroy after remount (confirmed: %s)`).

## Batch deletion cancellation must reach native menu waits

- **Trap:** Clearing the batch flag or its outer timers left a pending native-menu promise alive.
  It could click the next account's Delete control or continue the remaining batch after disable.
- **Rule:** Bind the batch to its account activation and route; pass cancellation through row,
  menu, confirmation and inter-item waits. Reset, disable and destroy abort that work immediately.
  Sidebar-only remounts retain the batch. Cancelled work must not report success or schedule reload.
- **Guard:** `src/pages/content/folder/FolderNativeBatchDelete.test.ts` covers each wait, remount,
  account changes and a replacement batch while the old one is unwinding.

## Retained selection must be restored into replacement sidebar UI

- **Trap:** Sidebar recovery kept selected conversation IDs but replaced the toolbar and rows,
  hiding the active selection mode, count and actions while later clicks still selected items.
- **Rule:** After mounting the replacement tree, restore selected rows and toolbar state from the
  selection owner; remove a temporary floating selection host when the sidebar takes over.
- **Guard:** `src/pages/content/folder/FolderSelection.test.ts` covers native/folder selections
  through remount and floating-to-sidebar toolbar handover.

## Native move menus must resolve ownership when clicked

- **Trap:** Gemini can mount a conversation menu before updating the trigger's `aria-expanded`
  and `aria-controls`. Capturing menu context during injection binds the button to a missing or
  incorrect trigger. A sidebar move then does nothing on the new-chat page, or saves the currently
  open conversation instead of the selected sidebar conversation. Injection retries only update
  the existing button's label, so they cannot repair its captured callback context.
- **Rule:** Read the live menu context when the injected Move to folder action is clicked. Resolve
  the sidebar conversation from that trigger; never use the current page to replace an unresolved
  sidebar identity.
- **Guard:** `src/pages/content/folder/__tests__/topMenuInjection.test.ts`
  (`resolves a sidebar trigger linked after menu injection when %s`, with and without another
  conversation open).

## Unchecking hide-outer-container must restore a findable rail

- **Trap:** Unchecking "Hide outer container" only removed `.timeline-no-container`. Ruler and
  compact styles independently forced `::before { opacity: 0 }`, so the rail never returned in those
  styles. In Nodes style the restored film was 4px at 0.08 / 0.12 alpha — findable as a 24px pill,
  invisible as a hairline — so hide-off still looked like hide-on.
- **Rule:** `.timeline-no-container` is the only hide for the rail `::before`. A shown rail at the
  4px default width must use a hairline-visible film, not a slab-opacity leftover.
- **Guard:** `src/pages/content/timeline/__tests__/timelineSurfaceStyle.test.ts`
  (`hides the rail only through timeline-no-container, so unchecking restore works`,
  `paints a hairline-visible film when the outer container is shown`),
  `src/pages/content/timeline/__tests__/TimelineView.test.ts`
  (`shows the rail background again after hide is turned off`), and
  `src/pages/content/timeline/__tests__/TimelineManagerLifecycle.test.ts`
  (`removes the rail hide class when the popup turns hide-container off`).

## Timeline navigation must validate the live scroll viewport

- **Trap:** Timeline dots, preview-list items, and `j`/`k` shortcuts could all appear inert after
  Gemini rebuilt its chat viewport. The navigation fast path treated connected marker and container
  nodes as current. Gemini can insert a new scroll viewport inside the old connected container, so
  Voyager wrote `scrollTop` to the stale ancestor.
- **Rule:** Before navigation, validate the target's nearest scroll container against the cached
  viewport. Rebind and recalculate markers when it changed, including preview-panel navigation.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts`
  (`rebinds a connected nested viewport before %s navigation`, covering dots and preview items) and
  `src/pages/content/timeline/__tests__/TimelineManagerNavigationRefresh.test.ts`
  (`rebinds a connected stale viewport before shortcut navigation`).

## Timeline state changes must preserve rail browsing position

- **Trap:** Calling the full view render after a star or hierarchy change also synchronized the rail
  to the native chat viewport. A user browsing a long rail with its slider was pulled back to the
  current chat position when editing a marker.
- **Rule:** State changes update geometry, virtual dots, slider and preview without synchronizing
  the rail to the chat. Keep that synchronization in native scrolling and navigation paths.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineManagerFlowClickActiveReset.test.ts`
  (`preserves the manually scrolled rail when a marker level changes`).

## Timeline surfaces must cancel work that has not become visible

- **Trap:** Clearing tooltip DOM without cancelling a queued animation frame could revive it after
  an immediate hide; an old hide timer could close a newer tooltip. A pending long press could also
  star a turn after its interaction owner was destroyed.
- **Rule:** Tooltip visibility and marker interactions own their complete timer/animation/listener
  lifetimes. Hide cancels pending visibility work; destroy cancels pending input actions as well.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineTooltip.test.ts` and
  `src/pages/content/timeline/__tests__/TimelineMarkerInteractions.test.ts` cover queued frames,
  overlapping hide/show and teardown during long press.

## Timestamp opt-in changes can arrive during initialization

- **Trap:** Moving the timestamp setting listener to the end of manager initialization lost changes
  made while history or keyboard settings were loading, leaving timestamps enabled after opt-out.
- **Rule:** The timestamp owner subscribes before its first asynchronous read and preserves settings
  changes received while that read is pending. Unsubscribe when the owner is destroyed.
- **Guard:** `src/pages/content/timeline/__tests__/TimelineTimestamps.test.ts` covers setting changes
  during pending initialization and shared history-store lifetime.

## Folder recovery must remove untracked sidebar clones

- **Trap:** Gemini's sidebar showed two complete Voyager folder panels, which displaced the native
  conversation history and could make it appear unable to scroll. Gemini can clone its virtualized
  sidebar subtree after Voyager mounts the folder panel. The cloned `.gv-folder-container` is not
  referenced by `FolderManager.containerElement`, so the old instance-only cleanup left that orphan
  in place when recovery injected a replacement.
- **Rule:** Before mounting, remove both the tracked panel and untracked direct folder-panel
  siblings from the current sidebar section host. Keep AI Studio and floating multi-select
  containers out of this cleanup.
- **Guard:** `src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
  (`removes an untracked folder clone before recovery mounts a replacement`).

## Automatic folder fallback must not become a sticky floating mode

- **Trap:** Folders briefly disappeared, then returned as a floating panel even though the
  floating-mode setting was off. Closing that panel could leave a FAB that the already-off popup
  toggle could not remove. The recovery watchdog applied its grace period only when the sidebar
  container existed. A transiently missing sidebar opened the fallback immediately, and the shared
  panel-close callback always restored the explicit-mode FAB.
- **Rule:** Apply the same grace period to a missing sidebar, restore the FAB only for explicit
  floating mode, and clear all fallback entry points when the sidebar recovers.
- **Guard:** `src/pages/content/folder/__tests__/folderPositionEnforcer.test.ts`
  (`waits before opening the floating fallback when the whole sidebar is temporarily missing`,
  `does not leave a FAB or immediately reopen after closing an automatic fallback`, and
  `clears every floating fallback entry point when the sidebar recovers`).

## The floating folder button and panel must open clear of the Prompt Manager ball

- **Trap:** In floating folder mode the closed-panel button defaulted to 24px in from the
  bottom-right corner and the ball to 18px, so the button (z-index 2147483645) sat on the ball at
  every window size and the ball could not be clicked. The open panel's default spot covered it
  too. Both features own that corner independently, and the ChatGPT folder plugin mounts the same
  button and panel.
- **Rule:** Default spots in `floatingModeFab.ts` and `floatingPanel.ts` go through
  `clearOfPromptTrigger` (`src/pages/content/prompt/triggerClearance.ts`): the ball's live box
  when it is on screen, else its default slot mirrored for RTL; beside it towards the page first,
  since the Research Pack launcher sits above it. A default button follows the corner on resize,
  and `watchPromptTrigger` re-places it when the ball mounts or moves: Prompt Manager moves the
  ball next to Gemini's composer up to 350ms after load, after the button may already be placed.
  A position the user saved by dragging is never moved.
- **Guard:** `src/pages/content/folder/__tests__/promptTriggerClearance.test.ts`.

## A pending floating mount must preserve the latest requested mode

- **Trap:** Stopping and restarting the folder runtime during an asynchronous floating mount could
  reuse the old mount promise and silently discard the new request. A request for the panel could
  finish as a FAB, or a stopped instance could remove its replacement.
- **Rule:** Track the requested panel/FAB intent along with the in-flight mount. Coalesce identical
  requests within one lifetime; after stop or an intent change, wait for the old mount to settle and
  clean it up before mounting the current request. The mount promise must include asynchronous FAB
  setup, so cleanup cannot race a detached continuation.
  Switching a completed automatic fallback to explicit closed floating mode must close the old
  panel before showing the FAB, even when there is no pending mount promise.
- **Guard:** `src/pages/content/folder/FolderSidebarRuntime.test.ts` covers stop/restart while a
  floating mount is pending with panel-to-panel, panel-to-FAB and FAB-to-panel requests.

## Imported activity timestamps must stay within browser timer limits

- **Trap:** A valid future `lastTurnAt` more than 24.8 days away overflowed the browser timeout
  range, refreshing Activity on a 1 ms loop instead of waiting for its Priority expiry.
- **Rule:** Clamp the scheduled delay to the signed 32-bit timeout limit, then recompute expiry
  when it fires. Preserve the imported timestamp.
- **Guard:** `src/pages/content/folder/__tests__/folderActivityView.test.ts` covers future data
  without a refresh loop and ordinary Priority expiry.

## Folder conversation navigation must not hard-refresh Gemini

- **Trap:** Clicking a folder conversation sometimes forced a full Gemini page refresh instead of
  switching sessions inside the existing SPA. The folder navigator tried to preserve Gemini's native
  SPA behavior by clicking the corresponding native sidebar link, but its fallback used
  `location.assign`. That fallback fired when the native sidebar row was virtualized/not rendered,
  or when Gemini's own route change was slower than the confirmation timeout. The floating folder
  panel had an even more direct `location.assign` path.
- **Rule:** Route folder and floating-panel conversation clicks through the shared conversation
  navigator. If the native link is missing or does not navigate, fall back to `history.pushState`
  plus `popstate`, not a hard page load.
- **Guard:** `src/pages/content/folder/__tests__/folderNavigation.test.ts`
  `src/pages/content/folder/__tests__/folderDisabledRuntime.test.ts`

## Sidebar scroll exception must stay scoped away from chat scroll blocking

- **Trap:** The prevent-auto-scroll feature blocked the Gemini sidebar history list from scrolling
  after a submit. The original blocking logic applied to any scrollable ancestor while the submit
  block window was active. Sidebar scroll containers were treated like the chat transcript.
- **Rule:** Classify sidebar elements separately from chat scroll elements before blocking
  `scrollTo`, `scrollBy`, `scrollTop`, or `scrollIntoView`.
- **Guard:** `src/pages/content/preventAutoScroll/__tests__/preventAutoScrollScript.test.ts`

## Claude timeline must treat the DOM as a sliding virtualized window

- **Trap:** Claude mounts only about 6 to 9 turns and can briefly expose sparse, non-contiguous
  windows during long jumps. Rebuilding from the mounted DOM made dots twitch or disappear;
  mount-index IDs changed as the window slid, and pruning missing turns deleted valid markers.
  Remembered absolute offsets also drift while Claude remeasures newly mounted content.
- **Rule:** Keep a grow-only registry stitched across overlapping windows by content hash:
  `c-<textHash>`, with `~n` for duplicates and hash-segment matching for legacy stars. Navigate to
  unmounted turns iteratively with instant probing and direction-aware bisection, then fine-aim
  after mount. Every jump passes `behavior: 'instant'` (`'auto'` follows the page's CSS
  `scroll-behavior`, so it can still animate): smooth scrolling drifts while Claude re-measures, and mixing
  smooth short hops with instant long ones reads as erratic. Reuse this virtual-window model for
  future Claude DOM features.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts` covers sparse-window
  stability, durable IDs, and marker retention during virtualization.

## Turn navigator blocks are filed by scroll position between anchors

- **Trap:** Claude now mounts about four turns plus the latest turn, which stays mounted while the
  reader sits at the top. Stitching a freshly mounted block "right before its first anchor" filed the
  conversation's opening turns behind the bottom window, so the preview list, the rail order and
  the active marker were all wrong after one scroll to the top.
- **Rule:** Anchors (hash matches) fix the relative order; a block of unknown turns is inserted by
  its scroll position among the known turns between its two bounding anchors, comparing known
  centres after the nearest anchor's re-measure drift. Never assume a mounted window is contiguous.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts`
  (`keeps the opening turns ahead of the bottom window when Claude leaves the latest turn mounted`,
  `files a bottom window behind the known opening turns when the first turn stays mounted`).

## Compact turn-navigator ticks spread over the track and stay clickable

- **Trap:** Compact ticks were squeezed into a fixed 240px cluster, so a long conversation rendered
  as an unreadable barcode on a 1100px track, and `pointer-events: none` on the ticks meant a click
  only toggled the preview panel instead of jumping.
- **Rule:** Keep a fixed tick pitch and let the cluster use the whole track (minus end padding);
  shrink the pitch only when the conversation outgrows the track, and re-space on resize. On
  `[data-gv-turn-navigator]` rails a tick click navigates (stop propagation so the rail's panel
  toggle does not fire) while hover still opens the preview; compact ticks show no tooltip.
- **Guard:** `src/features/plugins/builtin/claudeTimeline/index.test.ts`
  (`spreads compact ticks over the whole track instead of a fixed cluster`,
  `jumps from a compact tick without toggling the preview panel or a tooltip`).

## The chat width sparkle rule also matches the Gemini logo pill

- **Trap:** At widths of at least 1024px, the `chatWidth` loading selector
  `main > div:has(img[src*="sparkle"])` also matched Gemini's logo wrapper. It stretched the wrapper
  from 101px to the slider's computed width. Although the wrapper had `pointer-events: none`, its
  auto-pointer child inherited the large box and became a transparent hit target over header
  buttons. The affected area therefore tracked the chat-width slider, not sidebar width.
- **Rule:** Exclude the logo wrapper with `:not(:has(chat-app-side-nav-menu-button))` while
  retaining the #110 clamp for real loading wrappers. Do not change the static, in-flow host's
  geometry because that perturbs the header layout.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` Live-page verification:
  toggling only that selector moves the host between 101px (hit-stack top `mat-icon` /
  `span.dynamic-upsell-label`) and the slider's pixel value (hit-stack top
  `chat-app-side-nav-menu-button`) at 30/50/70/100%.

## The file-drop overlay is pinned to Gemini's native input width

- **Trap:** Gemini fixes the visual file-drop overlay at
  `var(--bard-chat-window-max-width-default, 760px)`. The variable is unset, so the hint stays 760px
  while `chatWidth` or `editInputWidth` can widen `input-area-v2`. Upload still works outside the
  hint because `.chat-container` is the real drop target.
- **Rule:** Both width modules must inject an overlay width with the same value and precedence as
  their input rule. When only chat width is on, its `input-container` prefix wins. When edit input
  width is also on, `html body input-container …` must beat that prefix so the composer and overlay
  follow the edit slider (#955), while the thread still follows chat width.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` and
  `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`. At 70% width, a synthetic
  drag over `.chat-container` must give the overlay and `input-area-v2` identical left and right
  edges. `editInputWidth` tests must keep the `html body input-container` composer/overlay prefix.

## Chat-width popup switch can look on while the page stays native

- **Trap:** The content script only injects chat-width CSS when `gvChatWidthEnabled`
  is `true`, and treats a missing key as an upgrade auto-enable when the saved
  width is not 70%. The popup used `chrome.storage.sync.get` with a `false`
  default, then treated `false` plus a custom width as on. After an explicit
  off, the switch lit up, the slider wrote `geminiChatWidth`, and the page kept
  Gemini's 708px thread.
- **Rule:** Load the enabled flags with a `null` default so "never set" is not
  `false`. Auto-enable only when the flag is missing (`null`/`undefined`) and
  the saved width is custom. `false` stays off, matching the content script.
- **Guard:** `src/pages/popup/hooks/__tests__/usePopupLayoutSettings.test.tsx`
  (`keeps an explicit off even when the saved width is not the default`).

## Gemini luminous width variables cap the thread at 708px

- **Trap:** Gemini 3.8's `.enable-luminous-content-width-update` host sets
  `--bard-chat-window-content-width-default: 708px`. Native conversation and input rules read
  `max-width: var(...)`. Voyager used to only set `max-width: none` / a pixel cap on its own
  selectors, so the composer stayed on chat width's more specific `input-area-v2` rule and the
  thread could look stuck at the luminous cap on the new layout.
  Gemini declares the variables from
  `.enable-luminous-content-width-update[_nghost-ng-cXXXXXXXX]`, and that Angular host attribute
  outranks a bare class selector, so an assignment without `!important` loses on the host itself:
  measured on the live build, `chat-window-content` still computed `708px` while Voyager's rule
  asked for the slider value. It only looked correct because Voyager re-declares the variables on
  descendant hosts; anything under `chat-window-content` outside that list keeps the narrow default.
  Furthermore, on `.enable-extended-and-xl-grid`, Gemini applies CSS `@scope (.md-content)` rules
  `& > :not(#_)` that hardcode `max-width: 708px` (and 740px) on assistant markdown child elements,
  and hardcodes `max-width: 708px` on response footers, message actions, and thinking overlays.
- **Rule:** `chatWidth` must assign both luminous variables on the chat-window hosts with
  `!important` and keep an explicit width on `.conversation-container`. Under
  `.enable-extended-and-xl-grid`, it must explicitly override `.conversation-container user-query`,
  `model-response`, `.md-content > :not(#_)`, `.md-content > *`, `message-actions` (including
  resetting its indented `margin-inline`), `thinking-overlay`, and related response children with
  `!important`. `editInputWidth` must assign the same variables on `input-container`, also with
  `!important`, and beat chat width's input/overlay selectors when both sliders are enabled.
  Inheritance still resolves the composer: `input-container` is the nearer ancestor, so the edit
  slider owns it.
- **Guard:** `src/pages/content/chatWidth/__tests__/chatWidth.test.ts` and
  `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`.

## Template placeholders must stay on double braces

- **Trap:** Prompt bodies render through `marked` with `marked-katex-extension`, so a single-brace
  placeholder syntax would claim `{a}` and `{b}` out of `\frac{a}{b}`, and the `{` in any JSON
  snippet a prompt happens to quote. Widening the syntax looks like a small convenience and
  silently corrupts every maths and code prompt in the library.
- **Rule:** Only `{{name}}` is a placeholder, and a prompt is a template only when it contains one,
  so a body without them keeps exactly its previous behaviour. `\{{` escapes a literal opener.
  Migration from single braces is an explicit author action (`convertLegacyBraces` behind the
  form's button), never inferred: only the author knows whether a given `{x}` is a placeholder or
  prose. Anything that has to find placeholders in already-rendered text builds its matcher from
  `TEMPLATE_VARIABLE_SOURCE` rather than copying the character class.
- **Guard:** `src/features/prompt/model/__tests__/promptTemplate.test.ts` asserts that
  `\frac{a}{b}` and `{"role": "user"}` yield no variables, and that the escape survives parsing.

## Prompt panel accent must come from the brand token, not a rebuilt hue

- **Trap:** The prompt panel's form controls are themed in three parallel layers: the base rules, a
  `prefers-color-scheme` / `.theme-host.<theme>` layer, and a `.gv-pm-panel[data-gv-theme='…']`
  layer. The panel always carries `data-gv-theme`, so that last layer is the one that renders.
  `.gv-pm-save` rebuilt its colour as `oklch(0.55 0.17 var(--gv-pm-brand-h))` — keeping only the
  hue — and then hardcoded hue 158 in `:hover` and hue 160 in the dark foreground. A user's custom
  accent therefore lost its chroma at rest and snapped back to the default green on hover.
- **Rule:** Paint accent surfaces with `var(--gv-pm-brand, var(--gv-pm-brand-default))`,
  `var(--gv-pm-brand-fg, …)` and `var(--gv-pm-brand-hover)`. The `*-default` tokens are already
  theme-scoped for `:root`, `prefers-color-scheme: dark`, `.theme-host.dark-theme` and
  `.theme-host.light-theme`, so a token-driven rule adapts without a per-theme copy. Reserve
  `oklch(… var(--gv-pm-brand-h) / <alpha>)` for translucent washes, never for a solid fill. When
  restyling one layer, update the `data-gv-theme` layer too or the change never ships.
- **Guard:** `src/pages/content/prompt/__tests__/promptFormStyle.test.ts`. Every `.gv-pm-save`,
  `.gv-pm-add`, and `.gv-pm-backup-btn` block that sets a background must resolve it through a
  brand token, and no `.gv-pm-save` / `.gv-pm-add` block may contain a literal hue 158 or 160.

## Gemini's edit-mode actions rely on block-level `justify-self`

- **Trap:** Gemini right-aligns the Cancel/Update row with `justify-self: flex-end` on
  `.edit-button-area`, a block-level flex container inside a `display: block` parent.
  Self-alignment in block layout is a Chrome-only feature today. Safari drops the declaration, so
  the row stretches to the full container width per spec and its own `justify-content: flex-start`
  parks both buttons at the far left, visually detached from the edit box. Measured on the live
  page: Chrome `x=904 w=172`, Safari `x=352 w=724`, with every other element in the edit tree
  identical. No Voyager module targets this element, and the width sliders do not need to be
  enabled for it to happen — do not start by suspecting `editInputWidth`.
- **Rule:** Reproduce Gemini's intended result with properties every engine implements:
  `width: fit-content` plus `margin-inline-start: auto` on `.user-query-container
.edit-button-area`. Both need `!important` because Gemini's own `margin: 0` rule carries two
  attribute selectors. Keep the margin logical so the row still lands on the inline end in RTL.
  Verified as a no-op in Chrome: the row measures `x=904 w=172` with and without the shim.
- **Guard:** `src/pages/content/__tests__/geminiEditActionsStyle.test.ts`. The shim must keep both
  `!important` declarations, must not use a physical `margin-left`, and its selector must match the
  edit-mode row without catching an unrelated `.edit-button-area`.

## Edit input width desynced Cancel/Update from the edit box

- **Trap:** Gemini's edit mode nests two `.edit-container` elements. The outer one holds both the
  prompt box and `.edit-button-area` (Cancel/Update); the inner one sits inside
  `.query-content.edit-mode` and starts indented by that element's horizontal padding.
  `editInputWidth` matched both with `.edit-mode .edit-container` and gave them the same
  `width: min(100%, <slider>)`, without `box-sizing: border-box`. Measured live at 60%: the outer
  container ended at x=1036 and the form field at x=1088, so the box overhung the button row by
  exactly the padding and the actions no longer sat under it.
- **Rule:** The slider width belongs to the outermost edit container only. Anything nested
  (`.edit-mode .edit-container .edit-container`, `.edit-mode .edit-container .query-content.edit-mode`)
  must be `width: 100%` so it fills that owner instead of re-clamping from a different left offset.
  Every selector that carries a width must also carry `box-sizing: border-box`, because these
  containers have horizontal padding.
- **Guard:** `src/pages/content/editInputWidth/__tests__/editInputWidth.test.ts`. The nested-fill
  selector is read back out of the injected CSS and run against Gemini's real edit-mode shape: it
  must match the inner container and `.query-content.edit-mode`, and must not match the outer one.

## Compact timeline preview hover gap closes panel

- **Trap:** In compact timeline mode, moving the pointer from the rail to the preview panel could
  close the panel before the pointer reached it, making history items hard to click. The rail and
  panel each owned separate hover enter/leave handlers, but the panel is positioned with a 12px
  visual gap from the rail. A slow pointer crossing that non-hit-tested gap could outlive the
  compact close delay before panel mouseenter canceled it.
- **Rule:** Add a transparent fixed hover bridge over the actual rail-to-panel gap while the compact
  preview is open. Treat the bridge as part of the interaction area for hover and outside-click
  handling, and hide it when compact mode closes or turns off.
- **Guard:** `src/pages/content/timeline/__tests__/TimelinePreviewPanel.test.ts`
  (`keeps the panel open while the pointer pauses in the compact hover gap`,
  `treats the compact hover bridge as part of the preview interaction area`).

## A panel remount must not close the folder dialogs that hold unsaved input

- **Trap:** `onPanelUnmount` called `dialogs.closeAll()`, and `FolderSidebarRuntime` runs that same
  unmount when Gemini rebuilds its sidebar, not only on stop. A folder instructions editor or
  move-to-folder picker open at that moment vanished mid-edit and took the typed text with it. The
  two are body-level overlays with no tie to the sidebar, so nothing about the rebuild required
  closing them.
- **Rule:** Give the unmount a reason. `stop` closes everything; `remount` closes only the transient
  views. A view is transient unless it is a body-level modal holding user input — the colour picker,
  delete confirmations and context menus are anchored to a sidebar row and would otherwise be
  stranded at stale coordinates against a rebuilt list, so those must still close.
- **Guard:** `src/pages/content/folder/folderDialogs.test.ts`
  (`keeps the input-bearing modals across a panel remount and drops the anchored ones`).

## Template fill slots must be measured, not sized by the `size` attribute

- **Trap:** `openTemplateFill` created each inline slot as `<input type="text">` with
  `slot.size = Math.max(variableName.length, 4)`, set once at creation and never updated. Typing a
  value longer than the variable name left the box at its original width with the text scrolling
  horizontally inside it, so the sentence the slots sit in visibly broke apart. Measured live on
  gemini.google.com: a slot for `{{topic}}` stayed 68.5 px wide while `一个 AI 的可解释性研究方向`
  needed 171 px. `size` could not have fixed it either — it counts characters against an average
  Latin advance, so a CJK value is about twice as wide as the attribute claims.
- **Rule:** Size an inline slot from a hidden sizer span that inherits the slot's font and padding,
  and re-fit on every `input` — including the peer slots that mirror a repeated variable. Fit after
  the surface is in the document, since nothing is measurable before it inherits its font.
- **Guard:** `src/pages/content/prompt/__tests__/PromptTemplateFill.test.ts`
  (`grows a slot to fit what is typed into it, and its repeats too`).

## An off-canvas measuring span must not be `position: absolute` inside a scroll container

- **Trap:** `.gv-pm-slot-sizer` parked itself at `position: absolute; left: -9999px` inside
  `.gv-pm-fill`, which is `overflow: auto`. `visibility: hidden` does not remove a box from its
  ancestor's scrollable overflow, and the `-9999px` escape only works while that ancestor is LTR:
  overflow past the inline-start edge is unreachable, so no scrollbar appears. On an RTL host page
  the surface inherits `direction: rtl` from the page — `body.gv-rtl` is only a scoping hook and
  never sets `direction` itself — which makes the same offset end-side overflow. Every template fill
  surface then carries a horizontal scrollbar, and a wheel or trackpad gesture pans the sentence
  off-screen.
- **Rule:** Measure with a `position: fixed` span, not an absolute one. A fixed box contributes to no
  ancestor's scrollable overflow in either direction. It is safe here because its containing block is
  the viewport, exactly like `.gv-pm-fill` itself, so it adds no dependency the surface does not
  already have — but that holds only while no ancestor carries `transform`, `filter` or `contain`,
  which would re-contain the fixed box and would already be mispositioning the surface.
- **Guard:** `src/pages/content/prompt/__tests__/promptFormStyle.test.ts`
  (`keeps the slot sizer out of the fill surface scroll region`), which also pins the
  no-transform premise on `.gv-pm-fill`.

## A Gemini user turn's `textContent` is not the message

- **Trap:** `SentPromptChips` read the whole bubble to decide which saved prompt a turn came from, and
  nothing ever matched. Read off gemini.google.com, `.user-query-bubble-with-background.textContent`
  is `"You said 给出 md 版本的本文  给出 md 版本的本文 "` — a `cdk-visually-hidden` screen-reader
  prefix, then the text again. The bubble also holds the copy, edit and expand controls, which render
  through a Material Symbols icon font whose glyph _is_ the element's text, so the string gains
  literal words like `content_copy` and `expand_more`. The same effect shows in sidebar titles, which
  read `chat_bubble请求 Markdown 格式转换`.
- **Rule:** Read a user turn through `.query-text-line` (then `.query-text`), as
  `DOMContentExtractor` already does. Only fall back to the bubble with the controls stripped from a
  clone, never from the live node.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`ignores the icon-font controls beside the message`), whose fixture carries the same controls.

## A long Gemini turn is clamped, not truncated

- **Trap:** A long user message shows a few lines and an expand chevron, which reads as Gemini having
  dropped the rest. It has not: measured on two real turns, all 62 `.query-text-line` elements and
  all 956 characters are in the DOM, with `scrollHeight === clientHeight === 62` because
  `.query-text.collapsed` clamps the height. Designing around recovering text that is already there
  wastes a fix.
- **Rule:** Read the text regardless of the clamp, and do not try to lift it. Removing `.collapsed`
  makes Gemini put it straight back; pressing its own
  `[data-test-id="luminous-expand-button"]` makes Gemini re-render the whole turn. Both land as a
  grow-then-shrink flicker. A feature that needs the full text on screen should render its own copy
  and keep Gemini's lines hidden, which is what `SentPromptChips` does.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`never presses Gemini's expand button`).

## Pressing Gemini's expand button re-renders the whole turn

- **Trap:** With the clamp no longer being fought, expanding still flickered. Sampling the bubble
  across the click showed its height going to `0` at +600 ms: Angular replaces the turn's nodes, so
  the element reference, the inserted chip and every class on it are gone. The observer then sees a
  fresh matching turn and collapses it again — the reader's expand undone by our own code.
- **Rule:** Any per-turn state a content module keeps must be keyed on something that survives a
  re-render, such as the message text. An element reference, a class or a dataset flag on a Gemini
  node cannot be.
- **Guard:** `src/pages/content/prompt/__tests__/SentPromptChips.test.ts`
  (`stays open on a turn the reader opened, even after the nodes are replaced`).

## Text typed after a slash token lands on the prompt's own last line

- **Trap:** Matching a sent turn against its saved prompt was anchored at both ends, so a turn where
  the person kept typing never matched. Measured on a real send: the prompt normalised to 749
  characters, the message to 751, diverging at 749 with `大大` appended — on the prompt's final line,
  with no newline between them. Splitting only on line boundaries missed it too.
- **Rule:** Measure how far the prompt reaches in characters (`^pattern` with lazy wildcards, then
  the match length) and render the remainder as the feature's own element. Collapsing the whole turn
  would hide the sentence the person actually wrote. Note also that each rendered line carries its
  own padding - the first comes back as `" # 寓言写作 Prompt "` - so the pattern has to absorb
  leading whitespace, and that whitespace must be a counted capture group or every offset after it
  is short by its length.
- **Guard:** `src/features/prompt/model/__tests__/promptTextMatch.test.ts`
  (`finds the boundary inside a line when the person typed straight on`).

## A placeholder name must survive everything the parser accepts

- **Trap:** `NAME` was `[\w一-龥.\-]+`. Outside `u` mode `\w` is ASCII-only, and the Han range that
  followed it covers neither kana, hangul, Cyrillic, Arabic, nor an accented Latin letter, so
  `{{テーマ}}`, `{{주제}}`, `{{имя}}`, `{{العنوان}}`, `{{año}}` and `{{thème}}` all failed
  `isPromptTemplate`: the fill surface never opened and the raw `{{...}}` went to the model, with no
  error anywhere. Separately, the names the parser did accept included `constructor`, `toString` and
  `__proto__`, and the fill surface collected them into a plain object — reading one back answered
  from `Object.prototype` with a non-string, and the `.trim()` that followed threw and took the
  whole surface down on submit.
- **Rule:** The charset is `[\p{L}\p{M}\p{N}._-]` and every regex built from it carries `u`
  (property escapes are a syntax error without it; Safari has had them since 11.1, under our 15.4
  floor, unlike the lookbehind the same module still avoids). `\p{M}` keeps a decomposed accent part
  of its name. Because a name is whatever the author typed, never read a value out of a plain object
  by that name: collect into `Object.create(null)` and read through `hasOwnProperty`.
- **Guard:** `src/features/prompt/model/__tests__/promptTemplate.test.ts`
  (`accepts a name written in any locale the extension ships`,
  `fills a name that collides with an Object prototype member`),
  `src/pages/content/prompt/__tests__/PromptTemplateFill.test.ts`
  (`fills a placeholder named after an Object prototype member`).

## A preview that hangs over a live chat must not be able to navigate it

- **Trap:** The prompt hover preview renders the body as Markdown into `document.body`. DOMPurify
  sanitises the URL of a link but adds no `target`, so following one replaced the current Gemini,
  Claude or ChatGPT tab and discarded an in-progress conversation. Every other outbound link in the
  same module already used `window.open(..., '_blank', 'noopener')`.
- **Rule:** After sanitising rendered Markdown into any surface that floats over the host page,
  rewrite `a[href]` to `target="_blank"` with `rel="noopener noreferrer"`. Sanitising the markup is
  not the same as making it safe to click.
- **Guard:** `src/pages/content/prompt/index.ts` (`openTooltipLinksInNewTab`, called from the
  tooltip's `paint`).

## A template fill action must match the button the user opened

- **Trap:** The fill button chose Copy or Insert when the surface opened, but its submit callback
  read the current `PROMPT_INSERT_ON_CLICK` preference. Changing that preference from the extension
  popup while filling a template left the button unchanged and silently switched its action.
- **Rule:** Capture the delivery mode when opening the fill surface and use it for both the label
  and submission, including Keep as is. A later opening or a plain prompt click uses the latest
  preference; a setting change must not discard values already being entered.
- **Guard:** `src/pages/content/prompt/__tests__/templateFillAction.test.ts` exercises the real
  manager's fill surface and storage listener, then checks delivery before and after reopening.

## Body-wide observers must not measure layout per mutation record

- **Trap:** Loading each page of older Gemini sidebar chats got slower as the list grew; a user
  reported the list freezing (#1040). Quote Reply's body observer resolved the live chat input for
  every mutation record, and that lookup calls `getBoundingClientRect()`. Gemini appends sidebar
  rows individually, so each page forced repeated synchronous layout over the growing sidebar.
  Draft auto-save did the same: every body mutation batch re-ran its visible-input lookup, which
  reads `getBoundingClientRect()`, even while its attached input was still connected.
- **Rule:** Filter body-wide observer records with selectors (`closest`, `matches`,
  `querySelector`) only. Resolve live elements or read geometry after the debounce, once, and only
  when a record is relevant. A listener bound to a live element needs a lookup only when that
  element is detached or an added node is or contains a candidate.
- **Guard:** `src/pages/content/quoteReply/__tests__/renderedQuotes.test.ts`
  (`does not measure layout while unrelated rows stream into the page`) and
  `src/pages/content/draftSave/__tests__/draftSave.test.ts`
  (`does not look up the input while unrelated content streams into the page`,
  `follows Gemini when it replaces the chat input`).

## Native title sync must not match every sidebar row against every stored conversation

- **Trap:** Paginating a long Gemini sidebar still froze with folders in use (#1040). Each appended
  page touches conversation rows, so the debounced native title sync rescans the sidebar. For
  every row it ran `isSameConversation` against every stored folder reference, and that check
  parses the stored URL with `new URL()`. With 3,000 rows and 500 stored conversations, one pass
  parsed 1.5 million URLs and took about 0.9 s in jsdom, repeated after every page.
- **Rule:** A pass over native rows looks up stored references through an index built once per
  pass (`indexConversationsByRouteId`). The index, `isSameConversation` and the debounced-edit
  merge all key references through `conversationKeys` in `folderConversationIdentity.ts`; change
  identity there, not in one caller. Read a row's title only when the row matches a stored
  reference.
- **Guard:** `src/pages/content/folder/__tests__/nativeTitleSyncScale.test.ts` checks the id shapes
  that must still match and bounds URL parses on a 1,500-row sidebar.

## Folder messages must use keys that exist and fill every placeholder

- **Trap:** AI Studio's library drop toasts showed `conversation_added_to_folder "Name"` and
  `conversation_saved_to_root`, and its empty-library folder was saved as `folder_default_name`.
  The translator returns a missing key unchanged, so the `t(key) || 'English'` fallbacks never
  ran. The AI Studio import alerts also showed `{folders}`, `{conversations}` and `{error}`
  literally, because the translator does not interpolate.
- **Rule:** Every literal key the folder UI translates exists in all 10 locales, and each caller
  fills its placeholders with `.replace('{name}', value)`. Do not rely on `|| 'fallback'` after
  `t()`. A message that wraps a value, such as a folder name, takes it as a placeholder so each
  locale can place it. Pass user or error text through a function replacer,
  `.replace('{folder}', () => name)`: a string replacement expands `$&` and `$'` inside a name.
- **Guard:** `src/pages/content/folder/__tests__/folderMessages.test.ts` (`exist in the English
locale for every literal key the folder UI translates`, `confirms library drops in words`,
  `reports import results and failures with their values filled in`).

## Listeners outside an extension shadow root see its host, not the element

- **Trap:** Moving the floating folder panel into a shadow root made its name input look like a
  plain `<div>` to every page-level listener: `event.target` and `document.activeElement` are
  retargeted to the shadow host. The timeline shortcuts (plain `j`/`k`/`g` in a window
  capture listener that calls `preventDefault`) and input vim mode's `i` therefore swallowed
  letters typed into a folder name, and `panel.contains(e.target)` checks treated clicks inside
  the panel as outside clicks. The host page's own listeners have the same blind spot: in
  headless Chrome, a page "type anywhere to focus the prompt" handler moved every keystroke from
  the folder name into the page's prompt box.
- **Rule:** A guard that skips "the user is typing" reads `composedEventTarget` and
  `deepActiveElement` from `src/core/utils/composedTarget.ts`. Inside-or-outside checks against
  a shadow-rooted panel use `event.composedPath()` (`eventPassedThrough` in
  `folder/shadowHost.ts`), and focus checks read the shadow root's `activeElement`. Read
  `composedPath()` during dispatch; it is empty afterwards. Page code cannot be changed, so
  `attachShadowSurface` marks its host (`data-gv-shadow-surface`), and the `document_start`
  entry `shadowKeyGuardEntry.ts` listens on `window` in the capture phase, ahead of the page.
  For a key from a text field in a marked surface it calls `stopImmediatePropagation` and
  replays a non-composed copy on the field, so the panel's own Enter and Escape handlers run and
  the copy stops at the shadow root. It never cancels the original, so the browser still types
  the character and IME composition is untouched. The shadow-root bubble stopper stays as the
  fallback where no guard is installed. The entry must register synchronously when evaluated:
  CRXJS wraps any content chunk with imports or exports in a loader that awaits a dynamic
  import, and a page listener registered during that wait runs first. So the entry imports only
  the guard, the guard imports nothing, nothing else imports the guard (`shadowHost.ts` spells
  the marker out), and the `selfContainedContentScripts` build plugin fails the build if the
  emitted entry has imports, exports or a loader.
- **Guard:** `src/core/services/__tests__/KeyboardShortcutService.test.ts` (`ignores shortcuts
typed into an input inside an open shadow root`),
  `src/pages/content/chatInput/__tests__/vimModeShadowTarget.test.ts`,
  `src/core/utils/__tests__/composedTarget.test.ts`,
  `src/pages/content/shadowKeyGuard/__tests__/shadowKeyGuard.test.ts`,
  `src/pages/content/shadowKeyGuard/__tests__/shadowKeyGuardEntry.test.ts`,
  `scripts/__tests__/selfContainedContentScripts.test.ts` and
  `src/pages/content/folder/__tests__/shadowHost.test.ts`.

## Page rules beat a normal `:host` declaration whatever their specificity

- **Trap:** The floating panel's host element lives in the page's tree. In headless Chrome, a page
  rule as weak as `* { position: static !important; z-index: 0 }` or `div { background: red }`
  overrode `:host { position: fixed; z-index: ...; background: ... }`: the panel dropped into the
  page flow below the fold with a red, dashed, page-font frame. The old light-DOM panel won those
  fights on class specificity. Across a shadow boundary, normal outer declarations win regardless
  of specificity, so a CSS reset such as Tailwind's `*` border preflight can restyle the host.
- **Rule:** Every declaration in a host-only rule (`:host`, `:host([...])`) is `!important`, which
  reverses the order: an important inner declaration beats outer ones. Leave custom properties
  normal, and never put `!important` on geometry that the panel writes inline (`left`, `top`,
  `width`, `height`), or the inline drag and resize stop applying.
- **Guard:** `src/pages/content/folder/__tests__/floatingPanelHostCss.test.ts`.

## Hide-archived membership checks must not scan every stored conversation per row

- **Trap:** With hide-archived on, every sidebar row asked `FolderStore.isConversationInFolders`,
  which scanned all stored conversations with two regex replaces and a URL substring test each. A
  refresh or a page of older chats cost rows x stored conversations: 73ms at 1000 x 1000 and 285ms
  at 2000 x 2000 (#1040). Folder data is edited in place (`push`, `conv.url = ...`), so an
  index keyed only on object identity would go stale.
- **Rule:** Look membership up through `createConversationMembershipLookup`: build the index once
  per task, rebuild when any folder array or its length changes, and drop it at the next microtask.
  Keep the original match rules exact: direct id, id without `c_`, or a stored URL containing an id
  longer than 8 characters.
- **Guard:** `src/pages/content/folder/conversationMembership.test.ts` (parity with the original
  scan, `indexes once for a batch of rows instead of once per row`,
  `sees conversations added in place during the same task`).

## The Gems sidebar enforcer must not look up the visible entry on every sidebar row

- **Trap:** Gems Sidebar (on by default) observes the whole sidebar overflow container to keep its
  list after Gemini's Gems entry. Every frame that added a conversation row ran two sidebar-wide
  `querySelectorAll` lookups and two `getBoundingClientRect()` reads to pick the visible entry, so
  loading older chats forced layout for each row (#1040). With no gems to show it did the same work
  only to remove nothing.
  Gemini also keeps two Gems entries mounted and swaps which one is visible (sidebar mode,
  breakpoint) without adding nodes, so a connected, in-place anchor can still be the hidden one.
- **Rule:** Keep the anchored entry. Re-run the layout-reading lookup only when the anchor may have
  moved or swapped: the entry, list or chevron is detached or out of place, an added node is or
  contains a Gems entry, a `class`/`style`/`hidden`/`aria-hidden` change lands on a Gems entry or an
  element containing one (including ancestors of the overflow container), or the window resizes.
  Skip enforcement entirely when there is no list and nothing to show. Pass the entry found by one
  lookup to the chevron instead of looking it up again.
- **Guard:** `src/pages/content/gemsSidebar/__tests__/positionEnforcer.test.ts`
  (`does not read layout while conversation rows stream into the sidebar`,
  `settles after mounting and ignores class churn on conversation rows`,
  `follows Gemini when it re-renders the Gems entry`, the
  `when Gemini swaps which mounted Gems entry is visible` cases).

## A connected chat input is not necessarily the active composer

- **Trap:** Draft auto-save stopped re-looking up its input while the bound one stayed connected.
  Gemini can keep two composers mounted and swap which one is visible without adding nodes, so the
  listener stayed on the hidden input and drafts typed into the revealed one were never saved. The
  send poller and route restore found the visible input but never rebound to it.
- **Rule:** Every path that resolves the visible input (send poller, draft restore, observer
  lookup) rebinds the listener to it. A `focusin` on another input candidate runs one lookup
  synchronously, not in the next frame: Prompt Manager focuses the composer and dispatches `input`
  in the same tick, so a deferred rebind misses the inserted prompt.
- **Guard:** `src/pages/content/draftSave/__tests__/draftSave.test.ts`
  (`saves typing in the composer the user focuses`,
  `saves input dispatched in the same tick as the focus that switched composers`,
  `rebinds to the visible composer on the next send-detection check`).

## Delayed draft restoration must not outlive draft auto-save

- **Trap:** Draft restoration waits on `loadDraft()`, up to five retries for the composer and a
  route-change delay. Those continuations only checked the route, so a restore pending when the
  feature was disabled or cleaned up rebound the input listener and wrote the draft into the
  composer; drafts kept saving while the setting was off, and a second cleanup returned early.
- **Rule:** `restoreDraft` captures `restoreGeneration`, which enable and disable bump, and every
  continuation (after the load, each retry, the route-change timer) stops unless the feature is
  still enabled in the same generation. The startup settings read is a continuation too: a toggle
  event that arrives while it is pending wins over its result.
- **Guard:** `src/pages/content/draftSave/__tests__/draftSave.test.ts`
  (`does not rebind or restore when a retry fires after stopping`,
  `does not rebind or restore when the draft load resolves after stopping`,
  `ignores a slow startup read once the user has changed the setting`).

## Gemini health reports need evidence that does not come from the missing anchor

- **Trap:** An owner finding zero matches for its anchor looks the same whether Gemini renamed the
  element or the page simply has nothing yet. That includes a new chat (`/app`, `/gem/<id>`), a
  conversation still streaming in on a slow network, a background tab and a collapsed sidebar.
  Judged by the same selectors that just missed, every one of those would show "Gemini may have
  changed" in the popup and send users to file false bug reports.
- **Rule:** `nativeHealthReporter.reportMissing` arms a verdict only on the route the probe needs
  (`conversation` probes never on a new chat). The verdict runs after the grace period, waits while
  the tab is hidden and re-runs the owner's own check. It then requires anchor-independent
  evidence: rendered text in `main` (outside buttons, the composer and Voyager UI) for turn
  anchors and the composer, and an open sidebar in sidebar mode for folders. A new chat has no such
  evidence, so the composer is never judged there. Any found result or owner teardown clears the
  entry, and entries and pending probes belong to the pathname (with `/u/<index>/`) they were
  reported on. Probes reuse the owner's existing detection result and never add an observer.
- **Guard:** `src/pages/content/nativeHealth/__tests__/reporter.test.ts` (`never alarms on a new
chat`, `never alarms on a conversation route that has not rendered content`, `postpones the
verdict while the tab is hidden`) and `src/pages/content/nativeHealth/__tests__/owners.test.ts`
  (`does not count a collapsed sidebar as breakage`, `does not probe while chat width is off`,
  `does not count a miss while the conversation is still loading`).

## Conversation placement policies differ by entry point on purpose

- **Trap:** Five Gemini paths and three AI Studio drop handlers each copied the logic to add or
  move a conversation, and the copies drifted. The multi-select drop threw a TypeError when its
  source bucket was missing, so the drop was neither saved nor rendered. The floating panel kept the
  source `sortIndex`, which could tie with a target row. Placement deduped by exact id, so a legacy
  `c_` or `conv_*` row gained a second row for the same conversation. AI Studio rebuilt a moved
  prompt from the drag payload and lost its rename and open time. Folding the remaining policy
  differences into one rule would still change behavior users see.
- **Rule:** Every add or move that does not target a position goes through `placeConversations`;
  a positioned drop (reorder, also across folders) goes through `reorderConversations`, where the
  moved record replaces a copy the target held. The caller builds records, guards folder existence
  and decides save, notify and nudge; the core only places. Change a policy through that caller's
  `placement`, `removeFrom`, `removeWhenPresent` or `keysOf` options, not by editing the core for
  one caller.
  - Gemini callers pass `keysOf: conversationKeys`, so a conversation the target holds under any
    spelling is not placed again. Stored rows, existing duplicates included, are never merged or
    rewritten, and removal from a source matches the incoming record's exact id.
  - AI Studio uses exact ids and `placement: 'keep'`, because its records have no `sortIndex`;
    `append` or `top` would seed one. A stored prompt moves with its whole record, taken from
    the payload's `sourceFolderId` bucket first, because legacy or imported data can hold
    differing copies in several buckets; any stored copy is the fallback. The payload builds a
    record only for a prompt no bucket holds.
  - Known platform differences that are kept on purpose:
    - Gemini lets a conversation sit in several folders; AI Studio moves a prompt out of every
      other bucket.
    - When the target already holds the conversation, a folder-row drop keeps the source copy,
      while the floating panel and AI Studio remove it.
    - Native "Move to folder" puts the conversation at the top; normalization seeds missing
      indices by recency first, so a seeded row can tie with a shifted one.
    - Only native "Move to folder" checks that the folder still exists. Drops can create a bucket
      for a deleted folder: Gemini prunes it on the next load, and AI Studio keeps it.
- **Guard:** `src/pages/content/folder/__tests__/conversationPlacementCharacterization.test.ts`,
  `src/pages/content/folder/__tests__/aistudioPlacementCharacterization.test.ts` and
  `src/features/folder/model/__tests__/placeConversations.test.ts`.

## The ChatGPT sidebar section lives inside the subtree its own watcher observes

- **Trap:** The ChatGPT folder section is inserted into the sidebar `nav` that
  `ChatGptSidebarWatcher` observes for row, title and menu changes. Re-inserting it on every pass
  is itself a `childList` mutation, so each pass schedules the next one and the page never goes
  idle. Placing it inside `[data-chatgpt-project-conversation-drop-target]` puts it in ChatGPT's
  pointer-based Project drop zone. React can also drop the section, clone it, or remount the whole
  sidebar during pagination, navigation and collapse.
- **Rule:** `ChatGptFolderSection.place` is a no-op when the section already sits directly before
  the Recents drop-target wrapper. It removes stray copies, and it re-resolves the sidebar on every
  pass instead of holding the first `nav`. It never falls back to a floating mount while the sidebar
  is gone. The watcher's body observer only wakes it when its sidebar is disconnected.
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/sidebarSection.test.ts`
  (`settles instead of re-inserting itself after every sidebar change`,
  `shows the folders just above Recents, outside its Project drop target`,
  `comes back when a React re-render drops it`, `moves into a remounted sidebar`,
  `removes a copy ChatGPT cloned with its own nodes`).

## Hiding filed ChatGPT chats must not hide the open chat or rows inside Projects

- **Trap:** A rule that hides every filed row also hides the conversation the user has open, so the
  sidebar loses its current-page marker. A selector over every `listitem` also reaches rows under a
  Project, which are not part of Recents. Stored ids end up inside a CSS selector, so an id
  containing a quote or bracket could break out of it.
- **Rule:** The single `style[data-gv-chatgpt-hide-filed]` rule is scoped to
  `[data-sidebar-project-container-id="chats"]` and excludes rows that contain
  `[aria-current="page"]`. It only takes ids that match `^[A-Za-z0-9_-]+$`, and the rule is removed
  when the setting or the plugin turns off. The `:has()` form was checked live on chatgpt.com
  (2026-10-01).
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/hideFiled.test.ts`.

## A cloned ChatGPT menu item must stay out of Radix's keyboard collection

- **Trap:** "Move to folder" is a clone of a native item in ChatGPT's Radix "Chat actions" menu. A
  clone that keeps `data-radix-collection-item`, an `id`, or `data-highlighted` confuses Radix's
  roving focus and highlight. Adding those attributes back does not make it reachable either:
  Radix only moves between items React registered, so its arrow keys skip the clone. Without
  Radix's item wiring, a click on the clone does not close the menu by itself. The menu content
  can also render a few frames after its trigger turns `aria-expanded="true"`, and waiting for it
  without a bound polled every frame forever when it never rendered.
- **Rule:** `buildEntry` strips Radix wiring (`data-radix-collection-item`, `id`, highlight,
  disabled and submenu attributes). `wireKeyboard` handles ArrowDown/ArrowUp into and out of the
  entry with a listener on the menu, which runs before Radix's delegated React handlers, and
  leaves every other key to Radix (verified live 2026-10-01). Enter, Space and click close the
  menu with the Escape keydown that Radix listens for. `ChatGptMoveMenu.check` finds the menu by
  comparing `aria-labelledby` (Radix ids need escaping in selectors). It waits at most
  `MENU_WAIT_FRAMES` frames per trigger, and it injects once per open menu.
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/moveToFolder.test.ts`
  (`sits after Move to project once, and files the row into the picked folder`,
  `is reachable with the arrow keys and opens the picker with Enter`,
  `reaches a menu whose content renders after its trigger opens`,
  `stops waiting for a menu that never renders`).

## ChatGPT title sync writes only titles this tab saw change

- **Trap:** Every save from another tab reloads the ChatGPT folder store, and the reload schedules a
  sidebar pass. Two tabs whose sidebars cached different titles for one filed conversation each
  wrote their own title back on that pass. Each write reloaded the other tab, so they overwrote
  each other with no sidebar change in between. Skipping every unchanged row went too far the
  other way: an import that filed an already-cached conversation into another folder under an
  older title kept that title, because the row's text never changed.
- **Rule:** `ChatGptTitleSync` remembers the title it last read from each filed row and writes a
  title only when the row shows something new to this tab, or when the conversation gained a
  reference this tab had not seen (a new bucket + conversation id from `store.filings()`). Such
  a conversation is reconciled once, when its row is next read. A reload of unchanged data adds
  no reference, so it never writes. A reference another tab added is new here too; that costs at
  most one write per tab and settles.
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/sidebarTitleSync.test.ts`
  (`settles when another tab saves a title this sidebar still shows differently`,
  `gives an imported copy with an older title the title the sidebar shows`).

## The ChatGPT folder picker can offer a folder another tab deleted

- **Trap:** The "Move to folder" picker lists the folders it had when it opened. If another tab
  deleted one meanwhile, picking it created a bucket for a folder no tree shows. The conversation
  vanished into it, and with "hide filed chats" on, its Recents row disappeared too.
- **Rule:** `ChatGptFolderStore.addConversation` and `moveConversation` file only into the root
  bucket or a folder that still exists. A refused filing returns `missing`, and the user sees
  `folder_save_error` in the sidebar section (and the panel when it is open).
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/ChatGptFolderStore.test.ts`
  (`files nothing into a folder that no longer exists`) and
  `src/features/plugins/builtin/chatgptFolders/__tests__/moveToFolder.test.ts`
  (`refuses a folder another tab deleted while the picker was open, and says so`).

## The ChatGPT folder picker opens only after Radix hands focus back

- **Trap:** "Move to folder" closes ChatGPT's Radix menu with Escape and then opens the folder
  picker. The picker focused its search box at once, but Radix unmounts the menu and returns focus
  to the row's trigger a task later (later still during an exit animation). Focus left the picker,
  so typing went to the page.
- **Rule:** `ChatGptMoveMenu` opens the picker on the first frame where the trigger holds focus
  again (or the trigger is gone), waiting at most `CLOSE_WAIT_FRAMES`. Plugin teardown cancels a
  pending open.
- **Guard:** `src/features/plugins/builtin/chatgptFolders/__tests__/moveToFolder.test.ts`
  (`keeps focus in the picker's search after Radix hands focus back to the trigger`, with and
  without exit frames, and `opens no picker when turned off while the menu is still closing`).
  The fixture's menu models Radix's close order.

## A sidebar host for the floating tree must reset the panel host under its scheme selector

- **Trap:** AI Studio's sidebar tree reuses the floating panel stylesheet in its own shadow root,
  where `:host` paints a fixed, shadowed, bordered card. An override sheet appended after it with a
  bare `:host` rule still lost to the panel's `:host([data-gv-scheme='light'])` background, border
  and shadow, because the attribute selector is more specific than `:host` regardless of order, so
  the inline tree turned into a white floating card in light mode only.
- **Rule:** Reset every host property under both `:host` and `:host([data-gv-scheme])`, each
  declaration `!important` so page CSS reaching the light-DOM host cannot restyle it either. The
  context menu does not live in this host: it renders in the body-level popover layer described in
  the next note.
- **Guard:** `src/pages/content/folder/__tests__/floatingPanelHostCss.test.ts`
  (`AI Studio sidebar tree host stylesheet`).

## A transformed or clipping ancestor captures a `position: fixed` popover

- **Trap:** AI Studio's folder tree sits inside the nav, and its context menu used
  `position: fixed` to escape the nav's `overflow`. That escape holds only while no ancestor
  establishes a containing block for fixed boxes. Once the nav or any wrapper carries `transform`,
  `filter`, `backdrop-filter`, `perspective`, `contain` or a matching `will-change`, as page layouts
  and animations do without notice, the menu is placed relative to that ancestor and clipped by its
  `overflow`: menus on lower folders lost their right half or ran past the window's bottom edge.
- **Rule:** A popover owned by a tree mounted inside page layout renders in a separate shadow host
  appended to `document.body` (`mountPopoverLayer` in
  `src/pages/content/folder/floatingTree/popoverLayer.ts`, opted into through the tree controller's
  `popoverLayer`). The layer host is a 0×0 fixed box that takes no clicks, resets every property that
  would make it a containing block, carries the shadow-surface key guard marker and the mirrored
  scheme and direction, counts as inside for outside-click handling, and is removed with the tree.
  Trees whose own host is already a body-level fixed panel (Gemini and ChatGPT floating panels) keep
  the menu in the tree. After a menu renders, the controller shifts it by a measured delta to stay
  inside the viewport, so the fit also holds in a container that offsets fixed boxes.
- **Guard:** `src/pages/content/folder/__tests__/folderTreePopoverLayer.test.ts` and the popover
  layer host tests in `src/pages/content/folder/__tests__/floatingPanelHostCss.test.ts`.

## Removing a folder must cut a parent cycle where the tree does

- **Trap:** The shared tree shows folders whose stored parents form a cycle by letting the first of
  each group in stored order stand in as a root. Removal still walked the stored parents, so with
  `a(parent: b)` and `b(parent: a)` the tree showed B as a leaf under A, yet deleting B also deleted A
  and both conversation buckets. A Drive merge of two moves made on different devices, or data
  stored by an older version, can hold such a cycle, so refusing cyclic import files instead would
  only stop those users from re-importing their own export.
- **Rule:** Display and removal cut cycles at the same folders (`findCycleRoots` in
  `src/features/folder/model/folderData.ts`, used by `layoutFolders` and
  `getFolderAndDescendants`), and both follow the first record of a repeated id, so a delete removes
  exactly the folders the tree shows inside the deleted one. Imports accept a cyclic file and move
  each cut folder to the root (`cutFolderCycles`, in the shared validator and AI Studio's file
  reader), keeping every folder and bucket; repeated ids are still refused. Never rewrite stored
  parents outside an import.
- **Guard:** `src/pages/content/folder/__tests__/folderTreeStructure.test.ts` checks that removal
  takes what the tree shows; `src/features/folder/model/__tests__/folderData.test.ts` and
  `src/pages/content/folder/__tests__/aistudioTreeEdits.test.ts` cover removal on cycles; the import
  repair and the export round trip live in
  `src/features/folder/services/__tests__/FolderImportExportService.test.ts`,
  `src/pages/content/folder/__tests__/FolderTransferController.test.ts` and
  `src/pages/content/folder/__tests__/aistudioPersistence.test.ts`.

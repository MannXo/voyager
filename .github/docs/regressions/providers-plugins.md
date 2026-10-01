# Providers and plugins regression notes

## Floating plugin UI must escape a host container that hides its overflow

- **Trap:** The Vim HUD renders in the strip just above its mount. DeepSeek's
  composer card sets `overflow: hidden` two levels above the textarea, so the
  badge was laid out correctly and clipped to nothing — no error, no empty
  element, simply never on screen.
- **Rule:** Before mounting UI that draws outside its mount's box, climb past any
  ancestor whose `overflow` is not `visible` and whose own edge is close enough
  to swallow it (`pages/content/chatInput/vimComposerMount.ts`). Do it by
  measuring, not by naming the site: the next host will clip somewhere else.
- **Guard:** `src/pages/content/chatInput/__tests__/vimComposerMount.test.ts`
  (`climbs out of a composer card that would clip the badge above it`).

## A delayed navigator star read must not replace the current conversation

- **Trap:** A storage-triggered star read from conversation A can resolve after
  navigation to B, replacing B's starred markers with A's snapshot (DeepSeek #996).
- **Rule:** Apply a star snapshot only if its request is the newest, its route
  still matches, and its plugin scope is alive. Preserve the existing startup
  promise chain so observers are installed at the same point in the lifecycle.
- **Guard:** `src/features/plugins/verbs/turnNavigatorStarIsolation.test.ts`
  reproduces A resolving after B;
  `src/features/plugins/verbs/turnNavigator/starSnapshot.test.ts` guards invalidation.

Read this file when changing ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff,
or prompt commands.

## Remote plugin catalog checks are triggered only by pages an enabled plugin targets

- **Trap:** The plugin host starts on every injected page, including Gemini, AI Studio and
  Claude's per-artifact `*.frame.claudeusercontent.com` iframes. A catalog check keyed on
  `location.host` from every start would contact voyager.nagi.fun from Gemini (breaking the
  zero-request promise) and would produce one 404 plus one storage key per random artifact
  frame host.
- **Rule:** Only the top frame asks the background for a check, only when
  `hasEnabledPluginForUrl` is true for the page, and only for a plain hostname
  (`isEligibleCatalogHost`); the background re-checks eligibility and the user's switch,
  interval and backoff before any fetch. Manual checks from the popup bypass the interval, not
  the host-shape rule.
- **Guard:** `src/features/plugins/runtime/PluginHost.test.ts` (`PluginHost remote catalog`),
  `src/features/plugins/remote/hostCatalogPolicy.test.ts`,
  `src/features/plugins/remote/hostCatalogRefresh.test.ts` (`ineligible` case).

## Turn-navigator conversation ids are namespaced by site

- **Trap:** The Claude timeline stored starred messages under `claude:conv:<id>` with the prefix
  hard-coded. Reusing that engine on DeepSeek with the prefix left as-is (or dropped) would file
  DeepSeek stars under Claude ids, and two sites whose route ids collide would corrupt each
  other's stars. The Gemini timeline has the same rule (`gemini:conv:<id>`).
- **Rule:** `TurnNavigator` builds ids from `TurnNavigatorConfig.siteId` plus the site's
  `conversationIdPattern`; the `turnNavigator` primitive takes both from the site adapter. Claude's
  config reproduces the historical `claude:conv:<id>` exactly, so existing stars keep resolving.
- **Guard:** `src/features/plugins/verbs/turnNavigator.test.ts` (`namespaces conversation ids`),
  `src/features/plugins/builtin/claudeTimeline/index.test.ts` (`builds Claude-scoped conversation
and turn ids`).

## Repeated prompts need ordered matching, and ChatGPT needs no matching at all

- **Trap:** Navigator markers are keyed by a hash of the prompt text. With
  `[continue, x, continue]` known and only the last `continue` mounted, first-hash matching
  re-pointed marker 0 at the third turn; picking the nearest raw centre per turn instead turned a
  remount that shifted every centre into extra dots on Claude/DeepSeek. Accumulating ChatGPT's
  turns the same way kept a phantom `~2` dot when its earlier DOM briefly rendered one list item
  twice.
- **Rule:** `turnMerge.ts` first takes certain matches (the stamped id with
  the same text, a hash only one marker carries), then aligns each run of uncertain turns between
  two certain matches with the markers between them: most matches first, then the smallest
  distance after the nearer anchor's drift. That alignment costs run x markers in time and memory,
  so past 250k cells a run is matched in one ordered pass over the markers and the run, all texts
  together: a turn may skip a marker only while that marker's text has more markers left than
  turns left, so it never jumps past a marker another turn still needs, and a text without spare
  markers pairs in order, which no uniform shift can upset. Among the markers it may reach, a turn
  takes the nearest by position (earliest on a tie); a turn that can reach none skips the blocking
  marker only when it sits nearer the next one with its text, else it is new. Positions are
  searched on estimates that trust fresher measurements: the navigator stamps each centre with
  its measuring pass (`measuredAt`), each centre is clamped between the strictly fresher centres
  before and after it, freshest pass first, and a final running max sorts the rest. A centre
  left from before the page above grew or shrank then moves no fresher estimate. (A running max
  let one stale high centre near the start pull a deep window to the front; keeping the longest
  sorted run of centres preferred a stale block over fewer fresh centres.) Known limit: when a turn unmounts, a new one arrives
  and the rest slide by exactly one turn's height, the two readings tie and the first turn may
  come out new. (A nearest-centre scan per turn was quadratic
  on equal centres, and after an anchorless +100px shift it matched the first turn to the second
  marker and made the last one a new dot. A fixed 32-marker lookahead misfiled a window mounted
  deep in a long run. Reserving markers per text let a turn skip other texts' markers, so a
  missing turn before a long run left phantom dots; a search on raw centres could pick a
  far-off out-of-order marker.)
  Repeat ids (`~n`) are handed out without rescanning earlier ones. ChatGPT unmounts whole
  `[data-turn-key]` items off-screen (4-7 of a long thread mounted, measured live), so it uses
  merge mode too. Only a marker whose element left the DOM is remembered as virtualized out: one
  whose element is still in the page but hidden, no longer a turn, or now reads as another text (a
  prompt edited in place) is dropped and its element re-filed (`rememberedMarkers`). The keyed
  snapshot mode (`turnKey`) built for ChatGPT's earlier DOM was removed unreleased; a duplicate
  render on the current DOM, not observed, would again show as a phantom dot only.
- **Guard:** `src/features/plugins/verbs/turnNavigator/turnMerge.test.ts` (`re-matches a long run
of repeats after a shift, past the alignment budget`, `keeps every turn of a long identical run
after a uniform shift with no anchor`, `reads a bounded number of remembered positions`, `files a
window mounted deep in a long identical run by position`, `keeps other texts in place when a
long mixed run remounts shifted without one turn`, `files a deep window by position past a stale
centre that lags behind`, `files a deep window by position past a stale centre that runs ahead`,
  `files the top of a long run by its fresh centres past a stale block below`, `keeps every id when the first turn of a mixed run unmounts as a new one arrives`,
  `adds a turn loaded above a mixed run without shifting the run`, `does not file a turn under a
far-off remembered centre that is out of order`),
  `src/features/plugins/builtin/claudeTimeline/index.test.ts` (`files a remounted window of
repeats past a turn measured before the page above shrank`),
  `src/features/plugins/builtin/chatgptTimeline.test.ts` (`keeps a dot while ChatGPT unmounts
the item`, `updates the dot when a prompt is edited in place`),
  `scripts/__tests__/plugin-check.test.ts` (`older than a primitive param it sets`).

## Turn navigator must re-key on route changes that mutate no turn

- **Trap:** The navigator refreshed only on turn mutations. A new ChatGPT chat gains `/c/<id>`
  with no DOM change, and leaving for a page without turns removes them before the URL changes,
  so stars stayed filed under the path-hash id and the old rail lingered.
- **Rule:** `TurnNavigator.start()` subscribes to the shared `watchRouteChanges` inside its
  plugin scope and schedules a refresh. ChatGPT's `conversationIdPattern` accepts `/u/<n>/` and
  Projects `/g/<id>/` prefixes, matching the export adapter's conversation route.
- **Guard:** `src/features/plugins/builtin/chatgptTimeline.test.ts` (`stars a new chat's turns
once their replies name the id ChatGPT gave it`, `clears the rail when leaving`, `rebuilds for
the next conversation, Projects routes included`).

## Rail contents and star ids must not depend on the order of URL and DOM changes

- **Trap:** SPA hosts change the URL and the thread DOM in separate steps, in either order and
  with any delay. Grow-only markers owned by a conversation id kept the previous thread's turns
  on the next rail. Holding the old elements back emptied the next rail when its DOM came first.
  A settle timer that moved a new chat's stars to its assigned id moved them into whatever
  conversation the user opened while the draft was still on screen, and deleted the draft record
  even when the store had silently dropped the copy. A star-change event between the URL change
  and the refresh set the shared conversation id, so the refresh skipped its reset. With the URL
  first, the rail still shows the previous thread, and a long press filed its turn under the new
  id; a press whose star read was still pending wrote under the id from before the await with the
  URL from after it. Inferring "the thread was swapped" from a disjoint set of turns let a DOM
  that changed under the old URL be starred into it, took a ChatGPT key rename for a swap, and an
  empty refresh mid-switch reset the guard, so the previous thread's remounted turns got through.
  Every later inference that granted ownership had a counterexample: a new chat's turn (owner
  null) could be starred into an unrelated conversation opened before it rendered; a turn mounted
  under the old URL but first seen after the URL changed was given to the new conversation;
  same-text "renames" and one surviving sibling handed a new thread's turns to the old one.
- **Rule:** No timing heuristics. The rail resets when the route differs from `markerRouteId`,
  which only `refresh()` writes. Stars are read and
  written for the id the URL names at that moment (`conversationId.ts`); a site with a
  `conversationIdPattern` cannot star a route that does not match it, so star records never move.
  A write also needs a refresh to have seen the current route and the pressed turn to be owned by
  the current conversation (`turnOwnership.ts`). Ownership is evidence, not inference: a
  MutationObserver attached before the first refresh stamps every inserted node with the URL's id
  at the end of the inserting task, and a turn takes the latest stamp on itself or its ancestors.
  Turns on the page at start take the URL at start. Rules only ever withhold: no id in the URL
  (new chat), another conversation's or an unattributed turn still on screen, new turns whose
  texts all repeat the previous conversation. The first owner is kept, per element in a WeakMap;
  nothing adopts a turn. Ambiguous turns are unstarrable, never filed
  elsewhere. A route change seen by a refresh cancels a pending long press. A press fixes its
  turn, conversation and URL before any await and is dropped if the route changed by the time its
  read lands. This proves a turn's conversation only on hosts that change the URL
  before they render the next thread (measured on ChatGPT, Claude and DeepSeek). Known limits:
  a DOM-first host, and a navigator started mid-switch, give the old URL's id to the new
  thread's turns until the URL changes; a new chat's turns stay unstarrable until a re-render; one unattributed turn on screen withholds every later one. Where the
  host names a turn's conversation itself (`conversationIdAttribute`; Claude's `data-conv-id`
  thread container), that id, read live at the press and again after the read, decides instead,
  both ways, and is the only thing that grants: it is taken from the nearest ancestor carrying
  it, else from inside the turn's `turnItem`, and a turn without exactly one id there (a reply not
  rendered yet) is unstarrable rather than left to the stamps. "On screen" means connected
  and under no `display: none` ancestor (`turnVisibility.ts`): ChatGPT keeps the pages of earlier
  conversations hidden in the DOM, so the rail, the withholding rules and remembered merge
  markers skip hidden turns, and a `style`/`hidden` change that shows or hides a thread refreshes.
  ChatGPT: the prompt is `[data-user-message-bubble]`, and the reply inside the same
  `[data-turn-key]` item carries `data-chatgpt-selection-conversation-id`, equal to the URL's
  `/c/<id>` on every mounted item checked live; a new chat's turns become starrable without a
  reload once their reply names the id in the URL. Whether a draft's reply carries an id before
  the URL has one is not verified live (that needs sending a message); either way nothing on `/`
  is starrable. Known unproven assumption: DeepSeek names no conversation on its turns, so its
  stars still rest on the URL changing before the next thread renders (measured, not proven for
  every path). Residuals elsewhere are unstarrable turns or wrong dot positions: an item ChatGPT
  removes outright after the URL changed (rather than hiding its page) stays as a dot until the
  next route change, and its reply still names the previous conversation.
- **Guard:** `src/features/plugins/verbs/turnNavigator/turnOwnership.test.ts`,
  `src/features/plugins/verbs/turnNavigator/navigatorStars.test.ts`,
  `src/features/plugins/verbs/turnNavigator/turnVisibility.test.ts`,
  `src/features/plugins/verbs/turnNavigator/conversationId.test.ts`,
  `src/features/plugins/verbs/turnNavigatorStarIsolation.test.ts` (`keeps the next conversation
starrable while the previous thread stays hidden in the page`),
  `src/features/plugins/builtin/chatgptTimeline.test.ts` (`refuses a turn whose reply has not
named the conversation yet`, `refuses a turn whose reply names another conversation`, `keeps the
next conversation starrable while the previous page stays hidden in the DOM`, `shows what is on
screen while the URL changes before the page`, `drops the previous conversation's turns, mounted
or not, when its page is put away`, `stars the next conversation as soon as the URL names what its
replies name`, `keeps the previous conversation off the rail when a star change lands
mid-switch`, `leaves a turn removed outright after the route changed as a dot that cannot be
starred`, `stars a new chat's turns once their replies name the id ChatGPT gave it`, `cannot star
a new chat turn under a conversation opened before that one renders`, `never moves or deletes a
star stored under a new-chat id`, `keeps a new chat out of a conversation opened while the new
chat is still on screen`, `ignores a star press in the moment between a URL change and the next
refresh`, `stars the next conversation's turns, never the previous one's, while both are on
screen`, `cannot star a previous-conversation turn that mounts after the URL changed`, `drops a
press begun in the previous conversation`, `drops a star press whose read was still pending`),
  `src/features/plugins/verbs/turnNavigatorStarIsolation.test.ts` (`drops the previous
conversation's dots when a star change lands mid-switch`, `cannot star the previous thread after a
far scroll replaced every mounted turn`, `cannot star a turn that mounted before the URL named the
next conversation`, `stars a turn that mounted after the URL named the conversation`, `cannot star
the previous thread when its turns remount after the DOM briefly empties`, `stars a new chat
re-rendered under the id it was given`),
  `src/features/plugins/builtin/claudeTimeline/index.test.ts` (`refuses a turn Claude files under
another conversation`, `stars a new chat's turn once Claude files it under the id in the URL`).

## Column-reverse scrollers count offsets from the newest turn

- **Trap:** ChatGPT's thread was reported to scroll as a `column-reverse` flex box, where
  `scrollTop` is 0 at the newest turn and negative above it. Positive offsets clamp to 0, so
  every jump landed on the latest turn.
- **Rule:** `scrollMotion.ts` reads and writes container offsets through `readScrollOffset` and
  `applyScroll`, which map a reverse scroller onto a 0-based axis. Detection is by the scroller's
  own computed `flex-direction`, never by site and never by a negative `scrollTop`: Safari
  reports one on an ordinary scroller during rubber-band overscroll.
- **Guard:** `src/features/plugins/builtin/chatgptTimeline.test.ts` (`jumps through a
column-reverse thread`, `treats a normal scroller in rubber-band overscroll as a normal
scroller`).

## A builtin with a `native` op must not also be bound as a native handler

- **Trap:** `verifyNativeHandlerBindings` used to require one handler per builtin id. After the
  formula-copy, Vim and timeline builtins switched to `native` ops, keeping their id bindings would
  run the feature twice (once through the primitive, once through the handler) and a missing
  binding would log a wiring error for a plugin that needs none.
- **Rule:** `NATIVE_BUILTIN_PLUGIN_IDS` lists only builtins without native ops; a manifest gets
  either a `native` op or a handler binding, never both.
- **Guard:** `src/features/plugins/builtin/builtin.test.ts` (native-op expectations) and the
  binding verification in `src/pages/content/pluginNativeRegistration.ts` at startup.

## A primitive-backed plugin keeps its mounted version until the page reloads

- **Trap:** A catalog refresh remounts declarative plugins live, which is right for CSS and DOM
  ops. Doing the same for a plugin whose `native` op runs first-party code (formula copy, later
  the timeline) would tear down and restart JS with user-visible state mid-session, and a
  half-disposed scope racing a new activation is exactly the class of bug PluginScope exists to
  prevent.
- **Rule:** `PluginHost.reloadCatalog` pins a mounted plugin that has (or gains) a `native` op
  when its version or contributions change, reports `pendingVersion` in its status, and applies
  the new manifest only on the next full page load; declarative plugins remount immediately.
- **Guard:** `src/features/plugins/runtime/PluginHost.status.test.ts` (`keeps a primitive-backed
plugin on its mounted version`, `remounts a declarative plugin immediately`).

## The health signal must not report on an empty page or from a second observer

- **Trap:** "This plugin found nothing to act on" is only meaningful once the conversation has
  rendered. Evaluating on a fixed timer flags every plugin on a slow network, and evaluating on an
  empty conversation flags every plugin on a new chat. A second MutationObserver for the signal
  also broke the engine's invariant of observing only while a plugin has DOM ops.
- **Rule:** The engine's single observer feeds `HealthMonitor.noteMutation`; a verdict waits for a
  quiet period (the deadline only caps the first wait), requires `userTurn` matches > 0, counts
  targets from DOM ops plus primitive counters, and pure-CSS plugins are never tracked.
- **Guard:** `src/features/plugins/runtime/healthMonitor.test.ts`,
  `src/features/plugins/runtime/declarativeEngine.native.test.ts` (health cases),
  `src/features/plugins/runtime/declarativeEngine.test.ts` (`installs a MutationObserver only
while an active plugin has domOps`).

## Catalog CSS must be read for real under Vitest

- **Trap:** Vitest replaces every CSS import with an empty module unless the file matches
  `test.css.include`, and that stub wins over a `?raw` query too. The bundled plugins loaded
  under test therefore carried empty `contributes.styles[].css` for months without any assertion
  noticing; a lifecycle test that checks the injected style text would have passed on nothing.
- **Rule:** Keep `css.include` in `vitest.config.ts` matching
  `src/features/plugins/catalog/**/*.css` with an optional `?raw` suffix; assert CSS content
  through the loaded manifest, not only through `readFileSync`.
- **Guard:** `src/features/plugins/sources/bundledPluginsLifecycle.test.ts` (injected style text
  is non-empty) and `src/features/plugins/catalog/sites/index.test.ts` (discovered style files
  are non-empty).

## A missing or failed remote catalog must never unmount bundled plugins

- **Trap:** The remote catalog is authoritative for a host (a bundled plugin it no longer lists is
  dropped). Treating a 404, a network failure, or an entry written by another extension version as
  "the remote says this plugin is gone" would silently disable every user's plugins the moment the
  deploy, the CDN or the build lags behind the extension release.
- **Rule:** Only a valid `format: 1` file for the same host, fetched by the running extension
  version, is authoritative. 404 is cached as `missing`, failures keep the previous entry and only
  bump the attempt bookkeeping, and both fall back to the bundled snapshot. Cache writes that do not
  change the plugin set must not notify subscribers, or every failed attempt would remount CSS.
- **Guard:** `src/features/plugins/sources/defaultSources.test.ts` (`mergePluginRecords`),
  `src/features/plugins/remote/HostCatalogSource.test.ts`,
  `src/features/plugins/remote/hostCatalogCache.test.ts` (`subscribeHostCatalog`),
  `src/features/plugins/remote/hostCatalogRefresh.test.ts` (404 and failure cases).

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
  (`chatgptIsConversationPage`), `src/pages/content/export/__tests__/exportEntryGate.test.ts`.

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

## Temporary-chat handoff attachments need unique names

- **Trap:** A second long temporary-chat handoff could reuse the first attachment preview and insert
  only the new instruction, silently handing the old transcript to the new chat. Attachment recovery
  treats a visible matching filename as proof that the file was already delivered, while the
  original filename contained only the date.
- **Rule:** Give every handoff a timestamp plus nonce and reuse that identity for both the
  downloaded backup and the composer attachment.
- **Guard:** `src/features/plugins/builtin/chatgptTemporaryHandoff/handoff.test.ts`
  (`gives separate handoffs unique filenames even at the same instant`).

## Claude usage settings hash may not open the modal by itself

- **Trap:** Clicking the Claude usage link changed the URL hash to `#settings/usage`, but the usage
  modal did not open until the page was refreshed. Claude's SPA sometimes observes the usage hash
  only during load. A hash-only navigation on an existing chat path is not always enough to mount
  the settings modal.
- **Rule:** Keep the current chat path in the usage URL and reload only when usage content does not
  appear after opening.
- **Guard:** `src/features/plugins/builtin/claudeUsage/index.test.ts`

## Claude usage reset data can come from multiple surfaces

- **Trap:** The Claude usage bar showed percentages but missed the reset countdown, especially for
  the 5h window. The visible settings DOM and the usage API do not always expose the same reset
  data. Some 5h reset information arrives through `message_limit` events.
- **Rule:** Normalize usage API windows, visible settings DOM, cached snapshots, and `message_limit`
  events into the same metric shape.
- **Guard:** `src/features/plugins/builtin/claudeUsage/index.test.ts`
  `src/features/plugins/builtin/claudeUsage/observer.test.ts`

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
  `src/pages/content/prompt/__tests__/slashPrompt.test.ts`
  `src/pages/background/__tests__/runtimeMessageRouting.test.ts`

## D18 scope checks compare match patterns, never one probe URL

- **Trap:** The catalog build and `plugin:check` proved "plugin `matches` stay inside the site" by
  probing one URL derived from the plugin pattern. `https://*.example.com/*` probed as
  `https://x.example.com/` and passed under a site that only covers `x.example.com`, although the
  plugin also applies to every other subdomain; `*://` probed as https and passed an https-only
  site.
- **Rule:** Use `patternWithin` / `patternWithinAny` from `sites/matchPattern.ts`: scheme, host
  wildcard and path scope are compared part by part, so a plugin scope must be the site scope or
  narrower.
- **Guard:** `src/features/plugins/sites/matchPattern.test.ts`
  (`rejects a wildcard host, a wider scheme or a wider path than the site allows`).

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

## Data-supplied regular expressions follow the safe subset

- **Trap:** `conversationIdPattern` reaches the content thread from site.json, plugin params and
  the remote catalog, and `turnNavigator` executed it against the URL path after a syntax check
  only. A pattern such as `^/(a+)+$` backtracks exponentially: a remote catalog entry could stall
  every page of that host.
- **Rule:** Validate with `isSafeRegexSource` (`sites/safeRegex.ts`): no lookarounds, no
  backreferences, no `*`/`+`/`{…}` repetition of a group that holds a quantifier or an alternation
  at any depth (`(a+)+`, `((a+))+`, `(a|aa)+`; a regex on the source misses the nested and
  alternation forms, so the check is a small scanner), at most 200 characters and at most
  `MAX_SAFE_REGEX_QUANTIFIERS` quantifiers (adjacent `a*a*…` terms are polynomial with the count as
  the exponent); bound the subject with `MAX_REGEX_INPUT_LENGTH`. This is defence in depth for a
  catalog the project publishes itself, not a proof of bounded matching cost. Apply the same policy
  wherever a pattern comes from data.
- **Guard:** `src/features/plugins/sites/safeRegex.test.ts`,
  `src/features/plugins/verbs/turnNavigator.test.ts`
  (`validates selectors, the id pattern and the rail side`).

## Declarative plugin output is checked after `{{setting}}` substitution

- **Trap:** The validator checked only the literal manifest text, then the engine substituted
  setting values from the manifest `default`, `chrome.storage` or a Drive restore into CSS,
  `setStyle` and `setAttribute`. `default: "url(https://tracker/x.png)"` with `background:{{bg}}`
  passed and fetched remotely. The literal regex also missed CSS escapes (`\75 rl(`, `@\69mport`),
  `/*` that is plain text inside `url(…)`, and URLs the URL parser rewrites (`\\host`, `http:host`,
  tabs in the scheme). Per-sink checks also missed composition: `:root{--u:"https://…"}` before
  `image-set(var(--u) 1x)`, or a `setStyle` / `style`-attribute `--w:"https://…"` read by the plugin
  sheet. And an attribute blocklist let any selector reach `<link rel=stylesheet href>`,
  `<base href>`, SVG `<image href>` or `<iframe srcdoc>`, which all fetch. Checking only external
  URLs also let `body{background:url('/probe')}` through: a relative URL resolves against the page
  origin, so an enabled plugin still made a request. Accepting any `data:` URL left one more: in
  `filter:url(data:image/svg+xml;base64,…#f)` Firefox loads the SVG as a resource document that may
  fetch `<feImage href="https://…">`, and base64 or percent-encoding hides that URL from the scan.
- **Rule:** Check the rendered value at every sink with `manifest/sinkGuards.ts`: the validator
  renders styles and DOM ops with their defaults, and `declarativeEngine.ts` re-checks before each
  write, withholding the whole stylesheet or skipping the attribute or style value. CSS loads
  nothing: `url()` takes only a `#fragment` or a `data:` URL whose declared type is a raster image
  (png, jpeg, gif, webp, avif, bmp, icon). SVG, any other type and a missing type are refused in
  every encoding, without decoding the payload. And `@import`, `image-set()`, `image()`,
  `cross-fade()` and `src()` (which read a bare string as a URL) are refused, so a relative string
  elsewhere stays inert. No CSS sink (sheet, `setStyle` value, `style` attribute) may hold any
  string token that starts with an external URL, whatever precedes it, so `var()` cannot carry one
  between sinks. Attribute names are
  an exact-match allowlist (`data-*`, `aria-*`, a few inert globals, `style`), and allowed values may
  not contain an external URL (`attr()` can read them). Scan like the CSS tokenizer and the URL
  parser, in linear time, and fail closed on doubt. Any new sink or templated field goes through the
  same guard.
- **Guard:** `src/features/plugins/manifest/validate.test.ts`
  (`validateManifest remote-resource checks on rendered values`),
  `src/features/plugins/runtime/declarativeEngine.test.ts`
  (`DeclarativeEngine rendered-value guards`).

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

## The docs plugin store imports the extension's logos and builtin plugins

- **Trap:** The docs store kept hand copies of the platform marks and of the builtin plugin list.
  When DeepSeek plugins shipped, their cards fell back to a generic puzzle icon and did not merge
  with the same feature elsewhere; the builtin copy still listed two of five plugins, so Vim Input
  showed as DeepSeek-only although Claude and ChatGPT had it too.
- **Rule:** Docs components import `PLATFORM_LOGOS` (`src/core/icons/platformLogos.ts`) and
  `BUILTIN_PLUGINS` (`src/features/plugins/builtin/index.ts`) and only add the host list
  (`docs/.vitepress/theme/components/pluginStore.ts`). Never hand-copy extension data into the
  docs; a new platform needs its host there before its plugins appear correctly.
- **Guard:** `docs/.vitepress/theme/components/pluginCatalog.test.ts`
  (`gives every catalog plugin a known platform`, `folds every platform of Vim Input into one card`).

## User-imported plugins live only in the `local.*` namespace and never drive catalog checks

- **Trap:** A user-imported manifest is untrusted input under an id the user chose. Kept as-is,
  `voyager.formula-copy` would replace the official plugin and share its enable state and
  settings; a `<all_urls>` match would make enabling it request every host; and an enabled local
  plugin on DeepSeek would make the page eligible for a voyager.nagi.fun catalog check that has
  nothing to do with it.
- **Rule:** `validateLocalManifest` forces every id into `local.*`, runs the remote gate plus the
  primitive contract and engine-floor checks, and keeps `matches` inside an existing plugin
  platform or native surface. `mergePluginRecords` drops official records in `local.*` and merges local ones last,
  outside the kill switch; `hasEnabledPluginForUrl` / `hasEnabledPluginForHost` skip `local.*`.
  Import validates before it writes and always writes `enabled: false`.
- **Guard:** `src/features/plugins/local/validateLocalManifest.test.ts`,
  `src/features/plugins/local/localPluginImport.test.ts`,
  `src/features/plugins/sources/defaultSources.test.ts` (`mergePluginRecords with local plugins`),
  `src/features/plugins/remote/hostCatalogPolicy.test.ts`
  (`catalog eligibility ignores local plugins`).

## A local plugin on Gemini or AI Studio must not make the page network-active or inject twice

- **Trap:** Gemini and AI Studio are native surfaces: the manifest injects the content script
  there and lists them in `host_permissions`, and the zero-request promise says their pages never
  ask for a catalog. Once local plugins can target them, an enabled one would turn the page into
  a catalog host (a request per check interval, plus a catalog cache read), and its origin would
  flow into `registerContentScripts` (Voyager injected twice) and into the enable-time permission
  request (Safari and Firefox refuse it).
- **Rule:** `isEligibleCatalogHost` refuses every native-surface host (`sites/nativeSurfaces.ts`),
  so `catalogHostFromUrl` is undefined there and neither the page, the popup nor a forced
  background check can fetch for it. `pluginsToOriginPatterns` drops native-surface origins and
  `pluginToOriginPatternsForActiveUrl` returns nothing on a native page. Local plugins there may
  not declare `theme` or `native` ops (each primitive already runs there as a native feature).
  Keep `nativeSurfaces.ts` in step with `manifest.json`.
- **Guard:** `src/features/plugins/runtime/PluginHost.test.ts`
  (`PluginHost with a local plugin on Gemini`),
  `src/features/plugins/remote/hostCatalogPolicy.test.ts`
  (`native surfaces are never catalog hosts`),
  `src/features/plugins/remote/hostCatalogRefresh.test.ts`
  (`never fetches for Gemini or AI Studio, even on a forced check`),
  `src/features/plugins/runtime/siteRegistration.test.ts` (`native surfaces (Gemini, AI Studio)`).

## Local plugin mutations must be atomic, fail closed and serialized

- **Trap:** Import wrote the manifest and only then disabled the plugin, so a page could mount an
  uninspected re-import under the old `enabled: true`; the disable write's failure was swallowed.
  A failed storage read became `{}`, and the next whole-map write deleted every other plugin (the
  same pattern in `setPluginEnabled` wiped every plugin's enable state). Two popups, or an import
  racing a remove, overwrote each other's whole-map writes.
- **Rule:** `saveLocalPluginRecord` writes the manifest and `enabled: false` in one `storage.set`
  and rejects on failure; every read-modify-write reads strictly (`readPluginStateStrict`, the
  store's strict map read) and keeps entries it cannot parse; local plugin mutations hold the
  `gv-local-plugins` Web Lock. Imports cap style entries and expanded CSS before expanding.
- **Guard:** `src/features/plugins/local/localPluginMutations.test.ts`,
  `src/features/plugins/local/localPluginImport.test.ts`
  (`caps style entries and the expanded CSS before expanding or scanning any of it`).

## A catalog reload must not restart plugins that did not change

- **Trap:** Any source change (a CSS-only local import, a catalog bookkeeping write that re-lists
  the same plugins) unmounted and remounted every active plugin, resetting primitive state such as
  the turn navigator or Vim mode.
- **Rule:** `PluginHost.reloadCatalog` remounts only plugins whose version or contributions
  changed; unchanged ones keep running. D7 freezing for `native` ops is unchanged.
- **Guard:** `src/features/plugins/runtime/PluginHost.test.ts`
  (`keeps a running plugin mounted when an unrelated local plugin is imported`).

## Turning Voyager off on AI Studio must turn its plugins off too

- **Trap:** The content script checks `GV_AISTUDIO_ENABLED` only before starting AI Studio's
  native features, after `PluginHost` has already started, so with local plugins able to target
  AI Studio a user who switched Voyager off there still had their plugins running.
- **Rule:** `PluginHost` takes the site's master switch (`runtime/surfaceSwitch.ts`, AI Studio
  only; Gemini has none) and mounts nothing while it is off; a change reconciles live, so off
  unmounts and on mounts the enabled plugins again.
- **Guard:** `src/features/plugins/runtime/PluginHost.surfaceSwitch.test.ts`.

## A Drive merge restore must not drop local-only plugin state on a failed read

- **Trap:** `restorePluginState` merged cloud entries over `loadPluginState()`, which turns a
  failed read into `{}`, so the restore wrote the cloud entries alone and every local-only
  plugin's enable state and settings were lost, while the popup reported success.
- **Rule:** The merge reads with `readPluginStateStrict` and rejects without writing; the popup
  restores plugin state before settings and folders, so the failure surfaces as a failed restore
  with nothing written.
- **Guard:** `src/features/plugins/storage/pluginState.test.ts`
  (`rejects a merge restore when local state cannot be read, keeping local-only entries`),
  `src/pages/popup/components/__tests__/CloudSyncSettingsRestore.test.tsx`
  (`fails the whole merge restore when local plugin state cannot be read`).

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

## A host wildcard in a match pattern stays inside the hostname

- **Trap:** `matchesUrl` compiled a whole pattern into one regex with `*` as `.*`, so the host
  wildcard of the legal `https://*.frame.claudeusercontent.com/*` ran across `/` and `?` and
  matched `https://gemini.google.com/app/abc?x=.frame.claudeusercontent.com/`. The import gate
  judged that pattern as Claude-only, so a local plugin with a native op or a theme got onto
  Gemini anyway.
- **Rule:** `matchesUrl` parses the URL and matches scheme, `URL.host` and path + query
  separately; `*.example.com` only matches hostnames ending in `.example.com`. Independently of
  patterns, `PluginHost` never mounts or lists a plugin with a `theme` or a `native` op on a
  native-surface host, and `resolveBrandColor` never takes a plugin theme there
  (`conflictsWithNativeSurface`, `isNativeSurfaceUrl`).
- **Guard:** `src/features/plugins/sites/matchPattern.test.ts`
  (`keeps a host wildcard inside the hostname`), `src/features/plugins/runtime/PluginHost.test.ts`
  (`never mounts a plugin with a native op or a theme on a native surface, whatever its matches
say`), `src/pages/content/platformTheme/__tests__/platformTheme.test.ts`.

## A Drive restore that fails partway says what it restored

- **Trap:** The background restores highlights, then the popup writes plugin state, synced
  settings and folder data one after another with no transaction. A failure in a later write
  showed a bare "sync failed" although highlights, plugins and settings had already changed.
- **Rule:** `applyCloudRestore` (`src/pages/popup/components/cloudRestore.ts`) runs the popup's
  writes in order and throws `CloudRestoreError` with the restored and the not-restored parts;
  `cloudRestoreFailureText` names both (`syncRestorePartial`) and keeps `syncError` when nothing
  was restored.
- **Guard:** `src/pages/popup/components/__tests__/CloudSyncSettingsRestore.test.tsx`
  (`names the restored and the failed parts when a later write fails`).

## An enable started before a re-import must not switch on the new content

- **Trap:** The popup's enable awaited `permissions.contains` (or the permission prompt) and then
  enabled the plugin by id. If another popup re-imported the same id meanwhile, the atomic publish
  stored the new content disabled, and the old enable switched that unreviewed content on. The
  version alone cannot tell them apart: a re-import can keep the version and change the CSS.
- **Rule:** Enabling a `local.*` plugin goes through `enableLocalPluginIfUnchanged`
  (`local/localPluginStore.ts`), which, under the plugin-storage lock, re-validates the stored
  record and enables only if it equals the manifest the user saw; otherwise it writes nothing and
  `setPluginEnabledWithSiteAccess` reports `changed`, which the popup explains. A storage failure is
  `write_failed` (the generic save-failed note), never `changed`.
- **Guard:** `src/pages/popup/utils/__tests__/pluginEnablement.test.ts`
  (`refuses when the same id was re-imported with other content while the enable was pending`).

## A previewed import lands only over the install it was previewed against

- **Trap:** The AI-reply preview read the installed record when the reply was checked, and Import
  ran later. Another popup could install, edit or remove the same id in between, so Import replaced
  content the preview never mentioned (no "replaces vX" warning, or a stale one). The reply also
  stays editable while the import runs: acting on its outcome re-checked the previous reply (the
  old render's closure) under a fresh generation, so its preview replaced the edited reply's
  cleared state, and a success wiped the edit.
- **Rule:** The preview keeps `localPluginRecordSnapshot` of the install (null when none), and the
  import passes it as `expectedInstalled`. `saveLocalPluginRecord` compares it under the
  plugin-storage lock and throws `LocalPluginChangedError` on any difference, writing nothing;
  `importLocalPlugin` returns `changedSinceReview` and the popup re-checks the reply and asks for a
  new review. Hand imports pass no snapshot and keep plain replace semantics. The composer captures
  the check generation when Import starts and drops the outcome if any edit or check bumped it since
  (a refusal is cleared; a finished import is still reported). Cancel is disabled while the import
  runs and also starts a new run, so a pending refusal cannot reopen a dismissed preview.
- **Guard:** `src/features/plugins/local/localPluginMutations.test.ts`
  (`importing a reviewed manifest over the install it was reviewed against`),
  `src/pages/popup/components/__tests__/LocalPluginComposer.test.tsx`
  (`does not overwrite a plugin installed after the preview; it asks for a new review`,
  `drops a changed-record import result once the reply was edited while it ran`,
  `keeps a reply edited while a successful import ran`,
  `does not let Cancel race a pending import into bringing the preview back`).

## The plugin preview reads inline styles as CSS does and shows them whole

- **Trap:** The AI-reply preview matched `display:none` and similar on the raw text, so a comment
  (`display:/**/none`) or an escape (`display:n\6f ne`) hid content with no warning. The preview
  and the inspect view also clipped `setStyle` values and the `style` attribute, so a long
  custom-property declaration pushed a hiding one out of view.
- **Rule:** Normalize the property and value first (comments to spaces with `stripCssComments`,
  escapes with `decodeCssEscapes`, lowercase, no `!important`), read a `style` attribute both with
  comments removed and as written, and warn on a hiding property unless the value shows the element
  by itself, per property. A global keyword (`inherit`, `unset`, `revert`, …) always warns:
  `visibility:inherit` under a hidden ancestor hides a child the page made visible. Show every inline style value in full; clip only targets and other attributes.
- **Guard:** `src/features/plugins/local/pluginPreview.test.ts`
  (`reads hiding values through CSS comments and escapes`,
  `shows inline style values in full, so a long one cannot push a hiding declaration out of view`),
  `src/features/plugins/local/inspectPlugin.test.ts`
  (`shows inline style values in full and clips only the target`).

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

## A partial Drive restore names only parts it actually wrote

- **Trap:** The settings step counted as restored even when the backup had no settings (the restore
  was a no-op), and the overwrite refusal for a backup without folder data returned early with a
  plain message although the background had already restored highlights.
- **Rule:** Each step in `applyCloudRestore` (`popup/components/cloudRestore.ts`) reports whether
  it wrote; only those parts are named as restored. The missing-folders overwrite refusal is a
  `CloudRestoreError` thrown before any popup write, so restored highlights are named; with nothing
  restored it keeps the plain `syncOverwriteMissingFolders` text.
- **Guard:** `src/pages/popup/components/__tests__/CloudSyncSettingsRestore.test.tsx`
  (`does not name parts the backup had nothing for as restored`,
  `names restored highlights when an overwrite stops for missing folder data`).

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

## A research pack template file can only add new prompts

- **Trap:** Templates are prompts tagged `research-pack` in `gvPromptItems`, and their file is the
  prompts export format. The prompt library's own import (`PromptImportExportService.importFromPayload`)
  matches stored prompts by id first and lets a newer `updatedAt` overwrite text and name, so a
  shared template file sent through it could rewrite a prompt the user already has. A template
  shown as HTML, or a file read before its size is checked, would also trust the file.
- **Rule:** The pack panel's import checks `file.size` before reading, accepts only the prompts
  format object with at most 50 entries, reads only entries tagged as templates, and rejects the
  whole file if any template's name or text breaks a limit or carries control characters. It keeps
  only name and text, shows them with `textContent` in a preview, and writes nothing until Save.
  Saving gives each template a new id and skips any whose text or name the library already has,
  re-checked by the prompt library's background owner against the library at write time; existing
  prompts are written back exactly as stored. Export writes only the chosen template, never pack items, sources or other prompts.
- **Guard:** `src/features/researchPack/services/__tests__/templates.test.ts` (`never edits a
stored prompt, even when an imported file carries its id`) and
  `src/pages/content/researchPack/__tests__/templates.test.ts` (`previews an imported file as plain
text and saves only on Save`, `writes nothing when an import is cancelled, too large, or not a
template file`, `exports only the chosen template, never the pack or other prompts`).

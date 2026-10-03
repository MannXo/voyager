# Folders, timeline, and layout regression notes

Read this file when changing folders, timeline navigation, sidebar behavior, chat width, drag and
drop, or hover layout.

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

## The floating folder button and panel must open clear of the Prompt Manager ball

- **Trap:** In floating folder mode the closed-panel button defaulted to 24px in from the
  bottom-right corner and the ball to 18px, so the button (z-index 2147483645) sat on the ball at
  every window size and the ball could not be clicked. The open panel's default spot covered it
  too. Both features own that corner independently, and the ChatGPT folder plugin mounts the same
  button and panel.
- **Rule:** Default spots in `floatingModeFab.ts` and `floatingPanel.ts` go through
  `clearOfPromptTrigger` (`src/pages/content/prompt/triggerClearance.ts`): the ball's live box
  when it is on screen, else its default slot mirrored for RTL. Candidate spots must also clear
  the visible chat input's containing control surface (`form` on ChatGPT, native input wrappers
  on Gemini/AI Studio). Prefer beside the ball towards the page when clear, then above it; if
  the ball is inside a tall composer, try above both. Keep Gemini's ball-next-to-composer
  placement when it leaves room beside the ball. A default button follows the corner on resize,
  and `watchPromptTrigger` re-places it when the ball or composer mounts, moves or resizes: Prompt Manager moves the
  ball next to Gemini's composer up to 350ms after load, after the button may already be placed.
  A position the user saved by dragging is never moved.
- **Guard:** `src/pages/content/folder/__tests__/promptTriggerClearance.test.ts`.

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

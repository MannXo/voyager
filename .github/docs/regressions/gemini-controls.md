# Gemini controls regression notes

Read this file when changing Gemini scrolling, model or thinking controls, usage parsing, or
generation traffic detection.

## Gemini table menus are not model menus

- **Trap:** Gemini table option menus showed Voyager default-model star buttons, including the "Set
  as default model" tooltip. The default model injector treated generic Gemini menu DOM such as
  `.label-container` as enough evidence that a popup was a model menu. Gemini table menus use
  similar menu structure.
- **Rule:** Require model-menu evidence such as `data-mode-id`, `.mode-title`, or
  `.title-and-description` before injecting star buttons.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

## The trigger pill's short label must be learned, never guessed

- **Trap:** Gemini names a model `3.8 Flash` in the picker but labels the trigger pill `Flash`, and
  nothing in the DOM links the two. `modelMatchesLines` deliberately refuses a bare `Flash` pill for
  a specific Flash variant (otherwise the generic label would satisfy any of them), so such a
  default could never be confirmed from the pill: every new chat had to open the picker just to read
  the row's selected state, and a stored name that Gemini has since renamed keeps failing forever.
  `Pro` is only fine by luck — it is a word-bounded substring of `3.1 Pro`.
- **Rule:** Learn the label instead of guessing it. While the picker is open, Gemini's own
  `.selected` / `aria-checked` row is authoritative, so the pill rendered at that moment is that
  model's label: persist it as `pill` on the stored default (`{ id, name, pill }`) and let the
  fast path accept it. Learn only a label that reads as the model's own short form
  (word-bounded inside the stored name) — a pill that says anything else is a stale render, and
  trusting it would confirm the wrong model on every later chat. A Gemini rename then costs exactly
  one confirming open, which replaces the stale label.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts` — the learning open, the
  fast path on a learned label, and the refusal to learn a mismatched pill.

## Default model auto-apply must yield to active composer input

- **Trap:** Typing in a fresh Gemini chat could lose focus while the page was still loading.
  Disabling default-model auto-apply made the problem disappear. The default-model lock loop opened
  Gemini's model picker after startup even when the user had already started typing in the composer.
  The follow-up refocus helped after the switch, but the menu click still stole focus first.
- **Rule:** Track composer input/keydown activity and skip the current auto-apply attempt once the
  user has started editing the chat input.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

## Thinking-level default must resolve by label, not per-row OR

- **Trap:** Both Standard and Extended showed a filled default star at once in the Thinking level
  submenu, selecting two "defaults" simultaneously. `isThinkingDefaultForItem` marked a row default
  when EITHER its label matched the stored label OR its position matched the stored index. When the
  stored `{index, label}` pair drifted apart (e.g. saved under a different submenu order/language),
  the label lit one row and the stale index lit another, so two stars turned gold. The stored index
  and label are separate keys and can disagree; an OR test over each row cannot stay single-valued.
- **Rule:** Resolve exactly one default row per render (`resolveThinkingDefaultIndex`): prefer the
  label match, fall back to the stored index only when no label matches and it addresses a real row.
  The star click now reads its own `is-default` class instead of re-deriving from `(index, label)`.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts` ("marks only one
  thinking level default when the stored index and label disagree")

## Auto-applied thinking level must close the picker it opened

- **Trap:** After auto-selection ran, the Thinking level row was unresponsive until the whole model
  picker was manually closed and reopened. `tryLockToThinkingLevel` opened the picker and
  thinking-level submenu, clicked the target, then refocused the composer without closing the menu.
  The half-open picker left a submenu overlay that the user's next open could not drive.
- **Rule:** Close the menu (`document.body.click()`) right after the auto-switch click, mirroring
  the already-selected branch so the next manual open starts clean.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts`

## Never lock to the page-default Standard thinking level

- **Trap:** On an already-correct new chat, the model picker could flash open during load. The lock
  loop opened the picker to enforce Standard even though Standard is Gemini's built-in default. That
  work is a no-op; a default corrupted by the double-star bug made it worse.
- **Rule:** Treat a Standard target (index 0 / label "standard") as "no thinking preference" for
  enforcement (`isPageDefaultThinkingLevel`), keeping the raw value only for the star display. Also
  bail before starting the loop when the trigger pill already shows the starred model + thinking
  level.
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts` ("never enforces the
  page-default Standard thinking level")

## tryLockToModel must reuse the bidirectional pill match

- **Trap:** On load, the model picker could flash and leave a focus ring even when Pro and Standard
  were already selected. `tryLockToModel` used a forward-only whole-word test, asking whether stored
  "3.1 pro" appeared in pill label "pro". A timing window could therefore open and close the picker
  for an already-selected model; Angular CDK then restored focus to the trigger.
- **Rule:** Early-return using the same `modelMatchesLines` (bidirectional short/long) check as the
  fast-path, and bail without opening the menu when the pill is not readable yet (retry next tick).
- **Guard:** `src/pages/content/defaultModel/__tests__/modelLocker.test.ts` ("does not open the
  picker while the trigger pill is still empty")

## Gemini usage buckets must use the period enum, not reset order

- **Trap:** The Gemini usage bar could swap the 5h and weekly limits. The parser inferred bucket
  labels from reset order. That breaks when the weekly reset is sooner than the rolling 5h window.
- **Rule:** Use Gemini's period enum when present. Do not guess labels from reset order when the
  enum is unknown.
- **Guard:** `src/pages/content/usageStatus/__tests__/usageStatus.test.ts`

## Gemini usage parsing must tolerate unknown sibling buckets

- **Trap:** On both Chrome and Edge, refreshing the usage pill from a conversation could finish
  without an error but leave the quota and "updated" timestamp unchanged. Opening `/usage` still
  refreshed the values. Gemini added a `period=4` quota bucket whose tuple layout differs from the
  existing 5h (`period=1`) and weekly (`period=2`) buckets. The parser required every sibling tuple
  to match the known layout, so one unfamiliar bucket caused it to discard the entire
  otherwise-valid HTTP 200 RPC response.
- **Rule:** Recognize a candidate metric array when it contains any valid known tuple, parse its
  members independently, and ignore unfamiliar buckets. Continue to map only `period=1` and
  `period=2`; do not infer unknown periods by position.
- **Guard:** `src/pages/content/usageStatus/__tests__/usageStatus.test.ts` ("ignores unfamiliar
  sibling quota buckets without dropping daily and weekly usage")

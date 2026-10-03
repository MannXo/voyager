# Rendering and export regression notes

Read this file when changing Mermaid, KaTeX, rendered previews, Quote Reply, or conversation export
output.

## Gemini turns must be paired by document order

- **Trap:** Conversation export could omit or duplicate most Gemini responses, and collapse repeated
  prompts into one, when virtualized turns exposed a mix of zero and nonzero `offsetTop` values.
  Turn elements can have different offset parents, so their local offsets are not comparable.
- **Rule:** Pair each response with the preceding user turn using DOM document order, bounded by the
  next user turn. Keep repeated prompts as separate turns; selector queries are already unique and
  top-level filtered. Do not use layout offsets as a shared conversation coordinate system.
- **Guard:** `src/pages/content/export/__tests__/chatPairs.test.ts` and
  `src/pages/content/fork/__tests__/chatPairs.test.ts` cover the export and fork collectors with
  repeated prompts and mixed virtualized offsets.

## Sanitized Mermaid SVGs must retain theme CSS and SVG labels

- **Trap:** Mermaid flowcharts turned black, then lost labels after the theme was restored. The CSS
  guard rejected Mermaid's contained tooltip `z-index` and removed the generated `<style>` block;
  DOMPurify removed HTML-label `foreignObject` nodes. Direct `main` commit `109a6698` introduced the
  over-broad guard in v1.8.0.
- **Rule:** Keep contained tooltip stacking while continuing to reject viewport-escaping CSS, render
  labels as sanitizable SVG text, translate simple HTML emphasis to Mermaid Markdown, and decode
  Mermaid's double-escaped ampersands only inside sanitized SVG text nodes.
- **Guard:** `src/pages/content/mermaid/__tests__/mermaid.test.ts` covers safe theme CSS, SVG
  labels, emphasis, entities, and unsafe escape CSS. Also check a real Gemini flowchart in Chrome; a
  synthetic malicious style fixture alone misses this regression.

## Rendered Quote Reply blocks must preserve their raw markers

- **Trap:** Quote Reply could leave raw `>` lines ungrouped in the live composer even when sent
  quotes were styled. Styling a sent user message could also remove its markers from export,
  timeline summaries, or cleanup, and user LaTeX rendering could later erase the visual treatment.
  Gemini uses separate DOM shapes for the editable Quill composer and sent user messages. The
  displayed user-message DOM is also shared by several features: the LaTeX renderer rebuilds
  matching paragraph contents, while export and timeline code still read the original text from
  those same paragraphs.
- **Rule:** Classify consecutive composer paragraphs with CSS classes only so caret, IME, and
  submitted Markdown remain native. Group sent quoted paragraphs in a semantic blockquote, hide each
  marker without deleting it, reapply decoration after relevant DOM changes, and restore the
  original structure during teardown.
- **Guard:** `src/pages/content/quoteReply/__tests__/renderedQuotes.test.ts` verifies raw-text
  preservation, composer grouping and live edits, idempotence, late messages, renderer repaint,
  teardown, and browser-neutral logical CSS. The Quote Reply integration suite verifies that
  rendering remains active when its insertion action is disabled.

## User export HTML must materialize multiline text

- **Trap:** PDF and image exports collapsed line breaks inside a multiline user prompt even though
  Markdown and JSON retained the original text. The user-content extractor escaped a multiline text
  part into one paragraph but left newline characters as HTML whitespace, which browsers collapse.
- **Rule:** Escape the text first, then serialize its newline characters as explicit `<br />`
  elements. Keep the plain-text representation unchanged.
- **Guard:** `src/pages/content/export/adapter/__tests__/platformAdapters.test.ts`
  (`renders multiline user prompts with explicit HTML line breaks`).

## Inline search illustrations must stay in image export

- **Trap:** "Copy response as image" dropped Gemini's inline instructional
  pictures (web-cited screenshots with a 来源 caption) even though surrounding
  list text survived. `extractAssistantImage` used descendant `querySelectorAll`
  and `return true` on the parent, so a wrapper that failed to emit (lazy
  `about:blank` / missing `img.image` / missing `data-full-size-image-uri`)
  swallowed the whole figure, caption included. Copy-as-image renders HTML, not
  Markdown, so a successful text-only walk looks like the image was never there.
- **Rule:** Treat only the image host itself (`single-image`, `generated-image`,
  `.attachment-container.search-images`, `.image-container[data-full-size-image-uri]`)
  as consumed. Resolve `currentSrc` / `data-src` before the `src` attribute.
  Keep captions in the HTML figure. Sweep leftovers beside `.markdown` the same
  way YouTube covers do, skipping hosts already walked in DOM order. Licensed
  hero shots live in `button.image-button` inside `.image-container.hide-from-message-actions`
  and use `img.hero-image`, not `img.image` — do not treat that button or class
  as export chrome.
- **Guard:** `src/pages/content/export/adapter/__tests__/platformAdapters.test.ts`
  (`exports licensed hero search images wrapped in Gemini image-buttons`,
  `preserves classic Gemini search images`, `does not drop surrounding prose`,
  `keeps inline single-image illustrations between lists`,
  `resolves lazy search-image placeholders`,
  `picks up search images rendered beside the markdown container`).

## Mermaid must honor Gemini explicit light theme

- **Trap:** With Gemini set to light while the browser reported a dark system preference, Mermaid
  diagrams rendered with the dark theme. Mermaid treated generic `body`/`html` dark markers as equal
  to Gemini's higher-priority `.theme-host.light-theme`, so stale outer markers could override the
  active Gemini theme.
- **Rule:** Resolve `.theme-host` first, then generic page markers, and only then fall back to the
  browser preference.
- **Guard:** `src/pages/content/mermaid/__tests__/mermaid.test.ts` (`resolveMermaidTheme`).

## Zero-width sanitising must not strip the emoji joiner

- **Trap:** Mermaid diagram labels containing a composed emoji rendered as its separate glyphs --
  `👨‍👩‍👦` came out as `👨👩👦`, `🏳️‍🌈` as `🏳️🌈`. `normalizeWhitespace` strips zero-width
  characters so stray invisibles from model output cannot break the parser, and U+200D sat in that
  character class alongside U+200B and U+200C. But U+200D is the zero-width _joiner_: it is what
  holds an emoji sequence together, so removing every occurrence splits the sequence. The rule that
  surfaced it (`no-misleading-character-class`) had never been enabled under the old ESLint config,
  which extended no recommended set.
- **Rule:** Strip U+200D only when it is not joining two emoji, checking the neighbouring code
  points and skipping variation selectors and skin-tone modifiers on the way back. Walk the string
  with `Array.from`, never by UTF-16 index, so astral emoji stay in one piece. The other zero-width
  characters keep their unconditional removal.
- **Guard:** `src/pages/content/mermaid/__tests__/mermaid.test.ts`
  (`should keep the joiner that holds an emoji sequence together`,
  `should still remove a joiner that only touches an emoji on one side`, and the original
  `should remove zero-width joiner`, which pins the stray-joiner case that motivated the strip).

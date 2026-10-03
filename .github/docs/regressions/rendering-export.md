# Rendering and export regression notes

Read this file when changing Mermaid, KaTeX, rendered previews, Quote Reply, or conversation export
output.

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

# Watermark and media regression notes

Read this file when changing watermark detection or removal, image downloads, full-size media, or
native media handoffs.

## Low-confidence watermark matches require isolated trial removal

- **Trap:** A known Gemini watermark could fall just below trusted spatial and gradient thresholds.
  The chooser returned the default anchor, but removal rejected the same untrusted signal without
  testing whether reverse-alpha subtraction actually suppressed it.
- **Rule:** If every anchor misses the trusted gate, trial each preset and snap offset independently
  from the original pixels. Require both signals to decrease, combined suppression above `0.08`, and
  severe undershoot below `0.1`. Restore pixels after every trial, then apply only the strongest
  candidate once. Never let this path override a trusted candidate or its safety rollback.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts` covers
  independent restored trials, snapped offsets, strongest-candidate selection, the `0.08` and `0.1`
  gates, exactly one final pass, and trusted-path priority.

## Full-size images may carry the downscaled V2 watermark

- **Trap:** New Gemini 2816x1536 downloads retained a 48px watermark 96px from the right and bottom
  edges even though Voyager already supported that watermark on preview-sized images.
  `getWatermarkConfigOptions` offered the downscaled 48px May 2026 V2 preset only when an image
  failed the legacy large-image size check. Full-size downloads therefore tried only the historical
  96px anchor and the full-size 96px V2 anchor, so the actual watermark region was never inspected.
- **Rule:** Offer the existing downscaled 48px V2 preset for large images as an additional
  candidate. Preserve the historical anchor first and rely on the existing signal and removal-safety
  checks to choose whether any candidate is applied. Derive its alpha map by averaging each 2x2
  block of the native 96px V2 capture, matching the upstream OpenCV `INTER_AREA` shrink instead of
  relying on the browser's implementation-dependent Canvas smoothing.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
  (`offers old, full-size, and downscaled May 2026 anchors for 2816x1536 outputs`) pins the reported
  48px anchor at `(2672, 1392)`, while
  `area-downsamples the 96px V2 capture before using it as a 48px alpha map` protects the alpha
  profile derivation.

## Full-size V2 removal needs gradient-backed transition evidence

- **Trap:** A subtle 96px V2 watermark on a bright diagonal background was detected at the correct
  anchor, but the visually correct reverse-alpha result was rolled back. The reconstructed
  background retained mild positive spatial correlation with the star template, leaving spatial
  suppression at `0.177`, just below the default `0.2` reliability-transition gate even though
  gradient correlation dropped from `0.167` to `0.052` without clipping or severe undershoot.
- **Rule:** Keep the default safety gate unchanged. Only for the exact 96px May 2026 V2 preset,
  accept the first transition out of reliable detection when spatial and gradient suppression
  independently exceed narrow thresholds, the absolute residual correlations are below the
  direct-match thresholds, and the trial introduces no new black or clipped pixels. Correlation sign
  is deliberately ignored because a clean reconstruction can cross zero. Subsequent passes still use
  the default gate.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
  (`accepts the reported full-size V2 reliability transition without weakening the default gate` and
  `rejects the supported transition when ...`).

## Dark watermark restoration must distinguish clipping from severe undershoot

- **Trap:** Valid white watermarks on dark backgrounds were left untouched even when the template
  and anchor matched, because correct restoration produced many black or channel-clipped pixels. The
  removal safety gate treated the number of newly black/clipped pixels as proof of damage. It could
  not distinguish a correct reconstruction near zero from an over-strong alpha subtraction that fell
  far below zero before clipping.
- **Rule:** When the legacy near-black or clipping limits are exceeded, only roll back if at least
  10% of watermark-region pixels have a raw reverse-alpha channel below `-5`.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/watermarkEngine.test.ts`
  (`accepts clipped pixels that reconstruct a dark background without severe undershoot` and
  `rejects a watermark-like pattern when trial removal would clip pixels`).

## Watermark toggles must reconfigure already-open Gemini tabs

- **Trap:** Changing either watermark-removal toggle in the popup had no effect in an already-open
  Gemini tab until the page was refreshed. The content runtime read both settings only during
  startup. Background registration kept future documents in sync, but dynamically registering
  `fetchInterceptor.js` did not install it into a document that was already open when download
  removal changed from disabled to enabled.
- **Rule:** Apply storage changes only after normal Gemini startup activates the runtime, reuse its
  engine, and reject stale starts or preview writes with a lifecycle generation. Treat preview and
  download as separate lifecycles: preview changes must preserve an enabled download bridge, intent,
  observer, and feedback; only download disable performs full teardown. Give every download intent
  and MAIN-world status the same token so late status cannot finish a newer sequence. Release a
  stale preview's queue slot before retrying, clear its bookkeeping without restoring `src`, and
  inject the guarded MAIN-world interceptor once into matching open tabs. A disabled installed
  wrapper stays in immediate pass-through mode.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/runtimeToggle.test.ts` covers
  bidirectional changes, engine reuse, lifecycle races, retry, reused image nodes, and
  preview/download isolation. `src/pages/background/__tests__/watermarkOpenTabs.test.ts` covers
  targeted open-tab injection and closed-tab failures.

## Watermark download indicators must not wait for engine assets

- **Trap:** The 🍌 indicator appeared noticeably after Gemini's download button, even though clicks
  during that window already queued correctly for watermark processing. The download bridge was
  installed before `WatermarkEngine.create()`, but both the initial indicator decoration and its DOM
  observer were installed only after the engine finished loading all watermark image assets.
- **Rule:** Decorate existing buttons and start the lightweight indicator observer before awaiting
  engine initialization. When preview removal is enabled, disconnect that temporary observer before
  the preview observer takes over so only one page-wide image observer remains active.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/engineRaceCondition.test.ts`
  (`shows download indicators while WatermarkEngine.create is still pending`).

## Native download health checks must not depend on watermark removal

- **Trap:** Gemini could show a sharp preview but return a blurred or partly blank full-size PNG.
  Voyager's click intent, MAIN-world bridge, and toasts ran only with watermark removal, so the
  disabled path could not compare the files. Direct Canvas sampling of Gemini's
  `googleusercontent.com` image was also tainted because the image lacked `crossorigin`, silently
  removing the preview fingerprint.
- **Rule:** Keep lightweight click intent and bridge listeners active independently of the two
  removal toggles. When removal is off, return Gemini's original Promise and Response objects
  unchanged, inspect only a clone, and warn only when a 32×32 preview/download fingerprint has a
  severe mismatch. Never warn from the download alone: a legitimate image may intentionally contain
  a large flat region. If direct preview sampling is tainted, fetch that exact preview URL through
  the extension runtime and await its origin-clean fingerprint without delaying the synchronous
  native download intent.
- **Guard:** `src/pages/content/watermarkRemover/__tests__/fetchInterceptor.test.ts`,
  `src/pages/content/watermarkRemover/__tests__/imageHealthDetector.test.ts`,
  `src/pages/content/watermarkRemover/__tests__/downloadToasts.test.ts`, and
  `src/pages/content/watermarkRemover/__tests__/corruptedDownloadDetection.test.ts` cover native
  identity, healthy and damaged pairs, legitimate flat regions, disabled-path silence, and the
  tainted-preview extension-fetch fallback.

## Safari full-size watermark downloads require a static page-world interceptor

- **Trap:** Safari watermark downloads failed with **Original Image Not Found**. Processing the
  image visible in Gemini appeared to work, but produced only a low-resolution preview instead of
  the full-size generated image. Gemini exposed only a `blob:` preview in the DOM. The full-size
  image URL was available to `public/fetchInterceptor.js`, but Safari did not reliably install the
  dynamically registered `MAIN`-world script for the temporary extension. A stale dynamic
  registration could also win the interceptor's double-injection guard after a rebuild.
- **Rule:** Declare `public/fetchInterceptor.js` as a static Safari `MAIN`-world manifest content
  script, and unregister the legacy dynamic Safari copy. Keep the shared fetch-interceptor download
  path instead of adding a Safari-only path that saves the visible preview Blob.
- **Guard:** `src/core/utils/__tests__/manifestPermissions.test.ts` verifies that the Safari
  manifest loads the interceptor first in `MAIN` world. A live Safari check must also confirm that
  the bridge is installed and enabled and that the downloaded image has full-size pixel dimensions,
  not merely that a PNG file exists.

## Changing the watermark default must not flip untouched existing installs

- **Trap:** Turning watermark removal off by default would also turn it off for existing users who
  never saved a watermark choice. Their storage has no split key and no legacy key, which is
  indistinguishable from a fresh install, so the new default silently changed their behavior after
  an update. A settings backup exported without a choice also carries `null` for the three keys, and
  restoring it erased a saved choice.
- **Rule:** On `runtime.onInstalled` with reason `update` from a release at or before
  `LAST_VERSION_WITH_WATERMARK_REMOVAL_ON_BY_DEFAULT` (or with no readable previous version), save
  both split keys as `true` only when no watermark key holds a boolean. The saved keys are the
  one-time marker, so fresh installs and later updates stay on the off default. Settings restore
  skips non-boolean watermark values so a backup without a choice cannot erase one.
- **Guard:** `src/pages/background/__tests__/watermarkDefaultMigration.test.ts` covers updated,
  fresh, later-release, saved-preference, rerun, and unknown-version installs.
  `src/core/services/__tests__/SettingsBackupService.test.ts`
  (`keeps a saved watermark choice when %s-restoring a backup without one`) covers restore.

# Watermark and media regression notes

Read this file when changing watermark detection or removal, image downloads, full-size media, or
native media handoffs.

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

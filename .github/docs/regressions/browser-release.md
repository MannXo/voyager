# Browser and release regression notes

Read this file when changing browser support, extension permissions or messaging, Safari native
behavior, or bundled public assets.

## Chrome-only permissions must not leak into the shared base manifest

- **Trap:** `manifest.json` feeds every browser build. Adding Chrome-only `declarativeContent` there
  creates an unknown Firefox permission and Safari conversion noise even if runtime code no-ops. Its
  `SetIcon` action also accepts `imageData`, not a path or badge action.
- **Rule:** Inject Chrome/Edge-only permissions in `vite.config.chrome.ts`, keep the base manifest
  portable, and guard runtime access with `if (!chrome.declarativeContent?.onPageChanged) return;`.
  Draw the toolbar dot into `ImageData` with OffscreenCanvas. Chrome cannot programmatically pin the
  icon, so unpinned users see the dot only in the extensions menu.
- **Guard:** `src/features/plugins/__tests__/promptNudge.test.ts` (pure domain math). Manifest
  scoping is verify-by-build:
  `bun run build:chrome && grep -c '"declarativeContent"' dist_chrome/manifest.json` must be `1`,
  while `manifest.json` / `manifest.dev.json` must be `0`.

## Safari notification clicks must be owned by the containing app

- **Trap:** Safari displayed the native completion notification, but its Open Conversation action
  only raised Voyager's status window. The app extension scheduled the notification, so macOS routed
  the click back to that process, which logs showed as `can launch: false`; it could display the
  notification but could not relaunch to handle the response.
- **Rule:** Let the app extension validate permission and hand the notification to the containing
  app before scheduling it. The app owns the notification category and delegate; on click it
  dispatches the typed open-conversation message back to Safari, which focuses the matching tab.
  Keep the handoff payload validated and never log its full URL because it can contain conversation
  details.
- **Guard:** `Voyager/Tests/NativeSupportTests.swift`,
  `src/pages/background/__tests__/responseCompleteNativeNotification.test.ts`,
  `src/core/utils/__tests__/safariNativeNotifications.test.ts`, and
  `src/core/utils/__tests__/nativeOpenConversation.test.ts`. A live Safari check must reach
  privacy-safe logs `app didReceive` and `app dispatchMessage delivered to Safari`, then visibly
  focus the target conversation.

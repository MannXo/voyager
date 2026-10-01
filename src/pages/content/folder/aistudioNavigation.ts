/**
 * In-app navigation for AI Studio. A full page load would drop the SPA's
 * state, so these never assign `location`.
 */

const NATIVE_LIBRARY_LINK =
  '.nav-content a[href="/library"], .nav-content a[href$="aistudio.google.com/library"]';

/** Opens /library: the nav's own Library link, else the History API. */
export function openLibraryInApp(): void {
  const link = document.querySelector<HTMLAnchorElement>(NATIVE_LIBRARY_LINK);
  if (link) {
    link.click();
    return;
  }
  try {
    window.history.pushState({}, '', '/library');
    window.dispatchEvent(new PopStateEvent('popstate'));
  } catch {}
}

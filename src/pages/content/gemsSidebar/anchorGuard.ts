/** Gemini's native Gems entry in the sidebar nav. */
export const GEMS_NAV_ENTRY_SELECTOR = '[data-test-id="gems-side-nav-entry-button"]';

export interface GemsAnchor {
  /** The native Gems entry the list was last placed after. */
  entry: HTMLElement | null;
  /** Voyager's injected gems list. */
  list: HTMLElement | null;
  /** Voyager's chevron inside the entry. */
  toggle: HTMLElement | null;
}

/**
 * Decide whether a sidebar mutation batch could have displaced the injected
 * gems list or chevron. The observer watches the whole sidebar overflow
 * container, so most batches are Gemini appending conversation rows; those
 * leave the anchor intact and must not trigger the visible-entry lookup, which
 * forces layout with `getBoundingClientRect()`.
 *
 * Uses identity and selector checks only — never geometry. Pure.
 */
export function gemsAnchorMayBeDisturbed(
  mutations: readonly MutationRecord[],
  anchor: GemsAnchor,
): boolean {
  const { entry, list, toggle } = anchor;
  if (!entry || !list || !toggle) return true;
  if (!entry.isConnected || !list.isConnected) return true;
  if (entry.nextElementSibling !== list || toggle.parentElement !== entry) return true;
  // A new Gems entry (e.g. Gemini re-rendering its nav or mounting the
  // alternate layout) may now be the visible one.
  for (const mutation of mutations) {
    for (const node of Array.from(mutation.addedNodes)) {
      if (!(node instanceof Element)) continue;
      if (node.matches(GEMS_NAV_ENTRY_SELECTOR) || node.querySelector(GEMS_NAV_ENTRY_SELECTOR)) {
        return true;
      }
    }
  }
  return false;
}

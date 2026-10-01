/**
 * Keeps keys typed into a Voyager shadow surface away from the host page.
 *
 * A page listener sees a shadow host, not the field inside it, as the key's
 * target, and `document.activeElement` is the host too. A page "type anywhere to
 * focus the prompt" or single-key shortcut therefore takes keystrokes meant for a
 * Voyager panel field. A listener inside the shadow root can stop page listeners
 * in the bubble phase only; a page listener on `window` in the capture phase runs
 * before anything in the shadow tree.
 *
 * This guard listens on `window` in the capture phase. It must be registered
 * before the page's own listeners, so it is installed from a `document_start`
 * entry. For a key from a text field in a marked surface it stops the original
 * event and replays a non-composed copy on the field: the copy runs the panel's
 * own handlers (Enter, Escape) and stops at the shadow root, so the page never
 * sees it. The original is never cancelled, so the browser still types the
 * character; a handler that cancels the copy cancels the original.
 */

/** Host attribute that marks a shadow surface whose fields this guard protects. */
export const SHADOW_SURFACE_ATTR = 'data-gv-shadow-surface';

const KEY_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

function isTextField(node: EventTarget | undefined): node is HTMLElement {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    (node instanceof HTMLElement && node.isContentEditable)
  );
}

function isInMarkedSurface(field: HTMLElement): boolean {
  const root = field.getRootNode();
  return root instanceof ShadowRoot && root.host.hasAttribute(SHADOW_SURFACE_ATTR);
}

function copyInsideShadow(event: KeyboardEvent): KeyboardEvent {
  return new KeyboardEvent(event.type, {
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    isComposing: event.isComposing,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    keyCode: event.keyCode,
    charCode: event.charCode,
    bubbles: true,
    cancelable: true,
    // Not composed: the copy stops at the shadow root and never reaches the page.
    composed: false,
  });
}

/** Install the guard on `win`; the returned function removes it. */
export function installShadowKeyGuard(win: Window = window): () => void {
  const guard = (event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    const origin = event.composedPath()[0];
    if (!isTextField(origin) || !isInMarkedSurface(origin)) return;
    event.stopImmediatePropagation();
    const copy = copyInsideShadow(event);
    origin.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
  };
  for (const type of KEY_EVENTS) win.addEventListener(type, guard, true);
  return () => {
    for (const type of KEY_EVENTS) win.removeEventListener(type, guard, true);
  };
}

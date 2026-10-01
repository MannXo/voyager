import { SCHEME_ATTR, getScheme } from '@/pages/content/platformTheme/scheme';

/** Host attribute that carries `body.gv-rtl` into a shadow tree. */
export const SHADOW_RTL_ATTR = 'data-gv-rtl';

const RTL_CLASS = 'gv-rtl';

const TYPING_EVENTS = ['keydown', 'keypress', 'keyup'] as const;

function isTextField(target: EventTarget | undefined): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export type ShadowSurface = {
  root: ShadowRoot;
  /** Stops mirroring the page and releases the key boundary; the caller removes the host. */
  disconnect: () => void;
};

/**
 * Give `host` an open shadow root styled by `css`, and keep the page's light/dark
 * scheme and RTL direction on the host as attributes. Page selectors such as
 * `html[data-gv-scheme]` and `body.gv-rtl` cannot reach a shadow tree, and
 * `:host-context()` is Chromium-only, so the shadow stylesheet keys off
 * `:host([data-gv-scheme])` and `:host([data-gv-rtl])` instead.
 */
export function attachShadowSurface(host: HTMLElement, css: string): ShadowSurface {
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  root.appendChild(style);

  const sync = () => {
    host.setAttribute(SCHEME_ATTR, getScheme());
    host.toggleAttribute(SHADOW_RTL_ATTR, document.body?.classList.contains(RTL_CLASS) ?? false);
  };
  sync();

  const observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [SCHEME_ATTR] });
  if (document.body) {
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // Page listeners see the host, not the field, as the target, so a page's
  // "type anywhere to focus the prompt" or single-key shortcut would take
  // keystrokes meant for a field in this surface. Keep them inside. This runs
  // after the field's own handlers; page capture listeners still run first.
  const keepTypingInside = (event: Event) => {
    if (isTextField(event.composedPath()[0])) event.stopPropagation();
  };
  for (const type of TYPING_EVENTS) root.addEventListener(type, keepTypingInside);

  return {
    root,
    disconnect: () => {
      observer.disconnect();
      for (const type of TYPING_EVENTS) root.removeEventListener(type, keepTypingInside);
    },
  };
}

/** Whether `event` passed through `node`, across shadow boundaries. */
export function eventPassedThrough(event: Event, node: Node): boolean {
  return event.composedPath().includes(node);
}

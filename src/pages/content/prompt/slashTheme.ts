/** The host page's light/dark scheme, as every slash completion surface paints it. */
export function detectTheme(): 'light' | 'dark' {
  if (
    document.querySelector('.theme-host.dark-theme') ||
    document.body.classList.contains('dark-theme') ||
    document.documentElement.classList.contains('dark') ||
    document.body.getAttribute('data-theme') === 'dark'
  ) {
    return 'dark';
  }
  if (
    document.querySelector('.theme-host.light-theme') ||
    document.body.classList.contains('light-theme') ||
    document.documentElement.classList.contains('light') ||
    document.body.getAttribute('data-theme') === 'light'
  ) {
    return 'light';
  }
  return typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function applyPromptTokenColor(token: HTMLElement): void {
  token.dataset.gvTheme = detectTheme();
  // Gemini's editor applies host styles to contenteditable=false spans. An
  // inline custom property feeds the stylesheet's important declaration, so
  // the selected prompt follows Voyager's configurable accent even when a
  // Gemini host selector would otherwise win.
  token.style.setProperty(
    '--gv-pm-slash-token-color',
    'var(--gv-pm-brand, var(--gv-pm-brand-default))',
  );
}

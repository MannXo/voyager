import { detectPageScheme } from './pageScheme';

export function applyPromptTokenColor(token: HTMLElement): void {
  token.dataset.gvTheme = detectPageScheme();
  // Gemini's editor applies host styles to contenteditable=false spans. An
  // inline custom property feeds the stylesheet's important declaration, so
  // the selected prompt follows Voyager's configurable accent even when a
  // Gemini host selector would otherwise win.
  token.style.setProperty(
    '--gv-pm-slash-token-color',
    'var(--gv-pm-brand, var(--gv-pm-brand-default))',
  );
}

/**
 * The plain-language preview of a gated plugin before it is imported: where it
 * runs, each change it makes, and what to check first. Structured and
 * untranslated; the popup turns it into sentences. Pure.
 */
import { patternWithinAny } from '../sites/matchPattern';
import { DEFAULT_ADAPTERS } from '../sites/registry';
import type { PluginManifest, SelectorRef, SiteAdapter } from '../types';

export type PluginPreviewTarget = SelectorRef;

export type PluginPreviewChange =
  | { readonly kind: 'css'; readonly chars: number }
  | { readonly kind: 'addClass'; readonly target: PluginPreviewTarget; readonly className: string }
  | { readonly kind: 'hide'; readonly target: PluginPreviewTarget }
  | { readonly kind: 'setStyle'; readonly target: PluginPreviewTarget; readonly styles: string }
  | {
      readonly kind: 'setAttribute';
      readonly target: PluginPreviewTarget;
      readonly name: string;
      readonly value: string;
    }
  | { readonly kind: 'native'; readonly handler: string }
  | { readonly kind: 'setting'; readonly label: string }
  | { readonly kind: 'theme'; readonly brand: string };

export type PluginPreviewWarning =
  /** A target is a raw CSS selector, which a site redesign can break. */
  | { readonly kind: 'raw-selector' }
  | { readonly kind: 'hides' }
  /** None of its patterns covers the site the user asked for. */
  | { readonly kind: 'not-on-site'; readonly site: string }
  /** Allowed by the gate on plugin platforms, but outside what the prompt asked for. */
  | { readonly kind: 'theme' }
  | { readonly kind: 'native' }
  /** An import replaces this installed version and turns the plugin off. */
  | { readonly kind: 'replaces'; readonly version: string };

export interface PluginPreview {
  readonly name: string;
  readonly description: string;
  /** Supported-site label per pattern, or the pattern itself. */
  readonly sites: readonly string[];
  readonly changes: readonly PluginPreviewChange[];
  readonly warnings: readonly PluginPreviewWarning[];
}

export interface PluginPreviewOptions {
  readonly previousVersion?: string;
  /** The site the user picked when writing the prompt, when known. */
  readonly targetSite?: SiteAdapter | null;
  readonly sites?: readonly SiteAdapter[];
}

const MAX_TEXT = 120;

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

function clipTarget(target: SelectorRef): SelectorRef {
  return target.kind === 'css' ? { kind: 'css', selector: clip(target.selector) } : target;
}

export function previewPlugin(
  manifest: PluginManifest,
  options: PluginPreviewOptions = {},
): PluginPreview {
  const sites = options.sites ?? DEFAULT_ADAPTERS;
  const changes: PluginPreviewChange[] = [];
  const warnings: PluginPreviewWarning[] = [];
  const { styles = [], domOps = [], settings = {} } = manifest.contributes;

  const cssChars = styles.reduce((sum, style) => sum + style.css.length, 0);
  if (styles.length > 0) changes.push({ kind: 'css', chars: cssChars });
  let rawSelector = false;
  for (const op of domOps) {
    if (op.op === 'native') {
      changes.push({ kind: 'native', handler: op.handler });
      continue;
    }
    if (op.target.kind === 'css') rawSelector = true;
    const target = clipTarget(op.target);
    switch (op.op) {
      case 'addClass':
        changes.push({ kind: 'addClass', target, className: clip(op.className) });
        break;
      case 'hide':
        changes.push({ kind: 'hide', target });
        break;
      case 'setStyle':
        changes.push({
          kind: 'setStyle',
          target,
          styles: clip(
            Object.entries(op.styles)
              .map(([prop, value]) => `${prop}: ${value}`)
              .join('; '),
          ),
        });
        break;
      case 'setAttribute':
        changes.push({ kind: 'setAttribute', target, name: op.name, value: clip(op.value) });
        break;
    }
  }
  for (const field of Object.values(settings)) {
    changes.push({ kind: 'setting', label: clip(field.label) });
  }
  if (manifest.theme) changes.push({ kind: 'theme', brand: manifest.theme.brand });

  if (options.previousVersion) {
    warnings.push({ kind: 'replaces', version: options.previousVersion });
  }
  const target = options.targetSite;
  if (target && !manifest.matches.some((pattern) => patternWithinAny(pattern, target.matches))) {
    warnings.push({ kind: 'not-on-site', site: target.label });
  }
  if (domOps.some((op) => op.op === 'hide')) warnings.push({ kind: 'hides' });
  if (rawSelector) warnings.push({ kind: 'raw-selector' });
  if (manifest.theme) warnings.push({ kind: 'theme' });
  if (domOps.some((op) => op.op === 'native')) warnings.push({ kind: 'native' });

  return {
    name: manifest.name,
    description: manifest.description,
    sites: [
      ...new Set(
        manifest.matches.map(
          (pattern) =>
            sites.find((site) => patternWithinAny(pattern, site.matches))?.label ?? pattern,
        ),
      ),
    ],
    changes,
    warnings,
  };
}

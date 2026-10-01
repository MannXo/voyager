/**
 * The plain-language preview of a gated plugin before it is imported: where it
 * runs, each change it makes, and what to check first. Structured and
 * untranslated; the popup turns it into sentences. Built on the inspect view's
 * `inspectPlugin` (sites, CSS size, primitives, settings, theme); only the DOM
 * ops are re-read here, because the preview names their targets in words. Pure.
 */
import { patternWithinAny } from '../sites/matchPattern';
import { DEFAULT_ADAPTERS } from '../sites/registry';
import type { DomOperation, PluginManifest, SelectorRef, SiteAdapter } from '../types';
import { inspectPlugin } from './inspectPlugin';

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
  /** Its CSS can change anything, hiding included; the preview shows it but does not summarize it. */
  | { readonly kind: 'css' }
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
  /** Every stylesheet's full source, shown as is. */
  readonly css: readonly string[];
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

/** Values a hiding property could take that the preview cannot read statically. */
const DYNAMIC_VALUE = /\{\{|\b(?:var|calc|attr|env|min|max|clamp)\(/i;

/** Whether one inline style declaration can hide its element. */
function declarationHides(property: string, rawValue: string): boolean {
  const prop = property.trim().toLowerCase();
  const value = rawValue
    .toLowerCase()
    .replace(/!\s*important/g, '')
    .trim();
  if (!['display', 'visibility', 'opacity', 'content-visibility'].includes(prop)) return false;
  if (DYNAMIC_VALUE.test(value)) return true;
  switch (prop) {
    case 'display':
      return value === 'none';
    case 'visibility':
      return value === 'hidden' || value === 'collapse';
    case 'content-visibility':
      return value === 'hidden';
    default: {
      const amount = Number.parseFloat(value);
      if (Number.isNaN(amount)) return true;
      return (value.endsWith('%') ? amount / 100 : amount) < 0.1;
    }
  }
}

/** Whether a DOM op can hide what it targets (the `hide` op, `hidden`, or a hiding style). */
function opHides(op: Exclude<DomOperation, { op: 'native' }>): boolean {
  switch (op.op) {
    case 'hide':
      return true;
    case 'setStyle':
      return Object.entries(op.styles).some(([prop, value]) => declarationHides(prop, value));
    case 'setAttribute':
      if (op.name === 'hidden') return true;
      if (op.name !== 'style') return false;
      return op.value.split(';').some((declaration) => {
        const colon = declaration.indexOf(':');
        return (
          colon > 0 && declarationHides(declaration.slice(0, colon), declaration.slice(colon + 1))
        );
      });
    case 'addClass':
      return false;
  }
}

function clipTarget(target: SelectorRef): SelectorRef {
  return target.kind === 'css' ? { kind: 'css', selector: clip(target.selector) } : target;
}

export function previewPlugin(
  manifest: PluginManifest,
  options: PluginPreviewOptions = {},
): PluginPreview {
  const inspection = inspectPlugin(manifest, options.sites ?? DEFAULT_ADAPTERS);
  const changes: PluginPreviewChange[] = [];
  const warnings: PluginPreviewWarning[] = [];
  const domOps = manifest.contributes.domOps ?? [];

  if (inspection.styleSheets > 0) changes.push({ kind: 'css', chars: inspection.cssChars });
  let rawSelector = false;
  let hides = false;
  for (const op of domOps) {
    if (op.op === 'native') continue;
    if (op.target.kind === 'css') rawSelector = true;
    if (opHides(op)) hides = true;
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
  for (const primitive of inspection.primitives) {
    changes.push({ kind: 'native', handler: primitive.handler });
  }
  for (const setting of inspection.settings) {
    changes.push({ kind: 'setting', label: clip(setting.label) });
  }
  if (inspection.themeBrand) changes.push({ kind: 'theme', brand: inspection.themeBrand });

  if (options.previousVersion) {
    warnings.push({ kind: 'replaces', version: options.previousVersion });
  }
  const target = options.targetSite;
  if (target && !manifest.matches.some((pattern) => patternWithinAny(pattern, target.matches))) {
    warnings.push({ kind: 'not-on-site', site: target.label });
  }
  if (inspection.css.length > 0) warnings.push({ kind: 'css' });
  if (hides) warnings.push({ kind: 'hides' });
  if (rawSelector) warnings.push({ kind: 'raw-selector' });
  if (inspection.themeBrand) warnings.push({ kind: 'theme' });
  if (inspection.primitives.length > 0) warnings.push({ kind: 'native' });

  return {
    name: manifest.name,
    description: manifest.description,
    sites: [...new Set(inspection.sites.map((entry) => entry.site ?? entry.pattern))],
    changes,
    css: inspection.css,
    warnings,
  };
}

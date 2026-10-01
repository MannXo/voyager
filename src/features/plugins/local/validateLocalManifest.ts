/**
 * The one gate every user-imported plugin passes, on import and again on every
 * read by `LocalPluginSource`.
 *
 * It is the remote catalog's gate plus local-only rules, never a weaker one:
 *   - `validateManifest` with its CSS and rendered-sink guards, exactly as a
 *     remote catalog entry gets it;
 *   - the id is forced into the `local.*` namespace;
 *   - `tier` must be `declarative` (no plugin-supplied JS, ever);
 *   - every `native` op names a primitive this build ships, with params that
 *     match its published spec, and `engine` admits no build older than it
 *     (the same rule `plugin:check` applies to official plugins);
 *   - every match pattern stays inside a plugin platform Voyager already
 *     supports (the D18 rule official plugins follow), so enabling a local
 *     plugin can only ask for host access an official plugin could ask for.
 */
import type { Result } from '@/core/types/common';

import { BUNDLED_SITE_ADAPTERS } from '../catalog/sites';
import { primitiveParamIssues, primitiveShippabilityIssues } from '../manifest/primitiveChecks';
import { type ManifestIssue, validateManifest } from '../manifest/validate';
import { patternWithinAny } from '../sites/matchPattern';
import type { PluginManifest, SiteAdapter } from '../types';
import { toLocalPluginId } from './localPluginId';

export interface ValidatedLocalPlugin {
  readonly manifest: PluginManifest;
  /** The input with its id namespaced: what the store persists. */
  readonly raw: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateLocalManifest(
  input: unknown,
  sites: readonly SiteAdapter[] = BUNDLED_SITE_ADAPTERS,
): Result<ValidatedLocalPlugin, ManifestIssue[]> {
  if (!isRecord(input)) {
    return { success: false, error: [{ path: '', message: 'manifest must be a JSON object' }] };
  }
  const issues: ManifestIssue[] = [];
  let raw: Record<string, unknown> = input;
  if (typeof input.id === 'string' && input.id.trim() !== '') {
    const id = toLocalPluginId(input.id);
    if (id) {
      raw = { ...input, id };
    } else {
      issues.push({
        path: 'id',
        message: 'must be a lowercase reverse-dotted id (a-z, 0-9, ".", "_", "-"), up to 100 chars',
      });
    }
  }
  if (input.tier === 'scripted') {
    issues.push({ path: 'tier', message: 'local plugins must be declarative' });
  }

  const result = validateManifest(raw);
  if (!result.success) return { success: false, error: [...issues, ...result.error] };
  const manifest = result.data;

  issues.push(...primitiveShippabilityIssues(manifest), ...primitiveParamIssues(manifest));
  const supported = sites.flatMap((site) => site.matches);
  manifest.matches.forEach((pattern, index) => {
    if (patternWithinAny(pattern, supported)) return;
    issues.push({
      path: `matches[${index}]`,
      message: `"${pattern}" is outside the sites plugins can target (${supported.join(', ')})`,
    });
  });

  return issues.length > 0
    ? { success: false, error: issues }
    : { success: true, data: { manifest, raw } };
}

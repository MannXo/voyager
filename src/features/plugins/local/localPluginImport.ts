/**
 * Import, re-import, export and removal of user-authored plugins. The popup
 * calls these; nothing here touches the DOM.
 *
 * Import is validate-then-swap: the manifest passes `validateLocalManifest`
 * before anything is written, so a failed re-import leaves the installed
 * version untouched and returns every issue (path + message) for the user.
 * A successful import is written in one step and always lands DISABLED: the
 * popup may close at any moment, and a stale `enabled: true` entry (for
 * example restored from Drive) must never switch on code the user has not
 * inspected yet.
 */
import type { Result } from '@/core/types/common';

import type { ManifestIssue } from '../manifest/validate';
import { resolveStyleFileContributions } from '../sources/styleFiles';
import { removePluginState, setPluginEnabled } from '../storage/pluginState';
import type { PluginManifest } from '../types';
import { toLocalPluginId } from './localPluginId';
import {
  type LocalPluginRecord,
  type LocalPluginRecordMap,
  loadLocalPluginRecords,
  removeLocalPluginRecord,
  saveLocalPluginRecord,
} from './localPluginStore';
import { validateLocalManifest } from './validateLocalManifest';

/** One picked file: its relative path (or bare name) and text. */
export interface LocalPluginFile {
  readonly name: string;
  readonly text: string;
}

/** Ceiling on everything one import reads (manifest plus CSS). */
export const MAX_LOCAL_PLUGIN_IMPORT_CHARS = 1_000_000;

function issue(path: string, message: string): ManifestIssue {
  return { path, message };
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash + 1);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Turn picked files into one raw manifest: exactly one `.json` file, with each
 * `contributes.styles[].file` resolved against the `.css` files picked with it
 * (by path relative to the manifest, then by unique file name). The CSS goes
 * through the same file-path and stylesheet checks as the bundled catalog.
 */
export async function readLocalPluginFiles(
  files: readonly LocalPluginFile[],
): Promise<Result<unknown, ManifestIssue[]>> {
  const total = files.reduce((sum, file) => sum + file.text.length, 0);
  if (total > MAX_LOCAL_PLUGIN_IMPORT_CHARS) {
    return {
      success: false,
      error: [issue('file', `exceeds ${MAX_LOCAL_PLUGIN_IMPORT_CHARS} characters`)],
    };
  }
  const manifests = files.filter((file) => extension(file.name) === 'json');
  if (manifests.length !== 1) {
    return {
      success: false,
      error: [issue('file', 'pick exactly one manifest .json file, plus its .css files')],
    };
  }
  const manifestFile = manifests[0];

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestFile.text) as unknown;
  } catch (error) {
    return {
      success: false,
      error: [
        issue('', `not valid JSON (${error instanceof Error ? error.message : 'parse error'})`),
      ],
    };
  }

  const base = dirname(manifestFile.name);
  const cssFiles = files.filter((file) => extension(file.name) === 'css');
  const loadCss = async (file: string): Promise<string> => {
    const exact = cssFiles.find((css) => css.name === `${base}${file}` || css.name === file);
    if (exact) return exact.text;
    const byName = cssFiles.filter((css) => basename(css.name) === basename(file));
    if (byName.length === 1) return byName[0].text;
    throw new Error(`style file ${file} was not picked with the manifest`);
  };
  try {
    return {
      success: true,
      data: await resolveStyleFileContributions(parsed, basename(manifestFile.name), loadCss),
    };
  } catch (error) {
    return {
      success: false,
      error: [issue('contributes.styles', error instanceof Error ? error.message : String(error))],
    };
  }
}

export type LocalPluginImportResult =
  | { readonly ok: true; readonly manifest: PluginManifest; readonly previousVersion?: string }
  | {
      readonly ok: false;
      readonly issues: readonly ManifestIssue[];
      /** Version still installed under the same id; a failed import never replaces it. */
      readonly previousVersion?: string;
    };

export interface LocalPluginImportDeps {
  readonly loadRecords: () => Promise<LocalPluginRecordMap>;
  readonly saveRecord: (manifest: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly setEnabled: (id: string, enabled: boolean) => Promise<void>;
}

const DEFAULT_DEPS: LocalPluginImportDeps = {
  loadRecords: loadLocalPluginRecords,
  saveRecord: (manifest) => saveLocalPluginRecord(manifest),
  setEnabled: setPluginEnabled,
};

function recordVersion(record: LocalPluginRecord | undefined): string | undefined {
  return typeof record?.manifest.version === 'string' ? record.manifest.version : undefined;
}

/** Validate a raw manifest and, only when it passes, install it disabled. */
export async function importLocalPlugin(
  raw: unknown,
  deps: LocalPluginImportDeps = DEFAULT_DEPS,
): Promise<LocalPluginImportResult> {
  const rawId =
    typeof raw === 'object' && raw !== null && 'id' in raw && typeof raw.id === 'string'
      ? toLocalPluginId(raw.id)
      : null;
  const records = await deps.loadRecords();
  const previousVersion = rawId ? recordVersion(records[rawId]) : undefined;
  const previous = previousVersion ? { previousVersion } : {};

  const result = validateLocalManifest(raw);
  if (!result.success) return { ok: false, issues: result.error, ...previous };

  const { manifest } = result.data;
  try {
    await deps.saveRecord(result.data.raw);
  } catch (error) {
    return {
      ok: false,
      issues: [issue('', error instanceof Error ? error.message : String(error))],
      ...previous,
    };
  }
  await deps.setEnabled(manifest.id, false);
  return { ok: true, manifest, ...previous };
}

/** Read picked files (or pasted text as one `plugin.json`) and import the result. */
export async function importLocalPluginFiles(
  files: readonly LocalPluginFile[],
  deps: LocalPluginImportDeps = DEFAULT_DEPS,
): Promise<LocalPluginImportResult> {
  const read = await readLocalPluginFiles(files);
  if (!read.success) return { ok: false, issues: read.error };
  return importLocalPlugin(read.data, deps);
}

/** Remove a local plugin together with its enable state and settings. */
export async function removeLocalPlugin(id: string): Promise<void> {
  await removeLocalPluginRecord(id);
  await removePluginState(id);
}

/** The stored manifest as a re-importable `plugin.json` (CSS inlined). */
export function exportLocalPluginJson(record: LocalPluginRecord): string {
  return `${JSON.stringify(record.manifest, null, 2)}\n`;
}

import type { PluginManifest, PluginSettings, PluginSettingValue } from '../types';

/** Resolve the same settings for the popup and the running plugin. */
export function resolvePluginSettings(
  manifest: PluginManifest,
  stored: PluginSettings = {},
): PluginSettings {
  const schema = manifest.contributes.settings;
  if (!schema) return stored;
  const resolved: Record<string, PluginSettingValue> = {};
  for (const [key, field] of Object.entries(schema)) {
    resolved[key] = stored[key] ?? field.default;
  }
  // The new default must not erase a compact preference saved by the old control.
  if (
    schema.timelineStyle &&
    stored.timelineStyle === undefined &&
    stored.compactView === true &&
    manifest.contributes.domOps?.some((op) => op.op === 'native' && op.handler === 'turnNavigator')
  ) {
    resolved.timelineStyle = 'compact';
  }
  return resolved;
}

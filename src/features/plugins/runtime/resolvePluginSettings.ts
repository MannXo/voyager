import type { PluginManifest, PluginSettings, PluginSettingValue, SettingField } from '../types';

function declaresChoice(field: SettingField, value: unknown): value is string {
  return typeof value === 'string' && (field.options ?? []).some((o) => o.value === value);
}

/** The timeline style select that replaced the `compactView` switch, when `manifest` declares it. */
function legacyTimelineStyle(manifest: PluginManifest): SettingField | undefined {
  const schema = manifest.contributes.settings;
  const field = schema?.timelineStyle;
  if (field?.type !== 'select') return undefined;
  const isTimeline = manifest.contributes.domOps?.some(
    (op) => op.op === 'native' && op.handler === 'turnNavigator',
  );
  return isTimeline ? field : undefined;
}

/** Resolve the same settings for the popup and the running plugin. */
export function resolvePluginSettings(
  manifest: PluginManifest,
  stored: PluginSettings = {},
): PluginSettings {
  const schema = manifest.contributes.settings;
  if (!schema) return stored;
  const resolved: Record<string, PluginSettingValue> = {};
  for (const [key, field] of Object.entries(schema)) {
    const value = stored[key];
    // A choice the manifest no longer offers would run on the host while the
    // popup's select showed another one.
    if (field.type === 'select') {
      resolved[key] = declaresChoice(field, value) ? value : field.default;
    } else {
      resolved[key] = value ?? field.default;
    }
  }
  // The new default must not erase a compact preference saved by the old control.
  const style = legacyTimelineStyle(manifest);
  if (
    style &&
    declaresChoice(style, 'compact') &&
    stored.timelineStyle === undefined &&
    stored.compactView === true
  ) {
    resolved.timelineStyle = 'compact';
  }
  return resolved;
}

/**
 * A `compactView` write as the `timelineStyle` choice it stands for, or
 * undefined when `write` is not such a legacy write for `manifest`.
 */
export function translateLegacySettingWrite(
  manifest: PluginManifest,
  write: { readonly key: string; readonly value: PluginSettingValue },
): { key: 'timelineStyle'; value: string } | undefined {
  // A guide mounted under the previous manifest stays pinned until reload and
  // still sends the old switch after the catalog replaced it with the select.
  const style = legacyTimelineStyle(manifest);
  if (!style || manifest.contributes.settings?.compactView) return undefined;
  if (write.key !== 'compactView' || typeof write.value !== 'boolean') return undefined;
  if (!write.value) return { key: 'timelineStyle', value: String(style.default) };
  return declaresChoice(style, 'compact') ? { key: 'timelineStyle', value: 'compact' } : undefined;
}

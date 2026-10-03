import type { PluginManifest, PluginSettingValue } from '@/features/plugins/types';

import { Switch } from '../../../components/ui/switch';
import { useLanguage } from '../../../contexts/LanguageContext';
import { pickLocalized, pickLocalizedSetting } from './PluginIdentity';

interface PluginSettingsProps {
  readonly plugin: PluginManifest;
  readonly values?: Record<string, PluginSettingValue>;
  readonly handleSetting: (id: string, key: string, value: PluginSettingValue) => void;
  readonly handleImmediateSetting: (id: string, key: string, value: PluginSettingValue) => void;
}

export function PluginSettings({
  plugin,
  values,
  handleSetting,
  handleImmediateSetting,
}: PluginSettingsProps) {
  const { language } = useLanguage();
  const settingsSchema = plugin.contributes.settings;
  const localizedName = pickLocalized(plugin, 'name', language);
  if (!settingsSchema) return null;
  return (
    <div className="mt-2 space-y-2.5" role="group" aria-label={localizedName}>
      {Object.entries(settingsSchema).map(([key, field]) => {
        const rawValue = values?.[key] ?? field.default;
        const settingText = pickLocalizedSetting(plugin, key, field, language);

        if (field.type === 'boolean') {
          const checked = rawValue === true;
          return (
            <div key={key} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground text-[11px]">{settingText.label}</span>
              <Switch
                checked={checked}
                aria-label={settingText.label}
                onChange={(event) => handleImmediateSetting(plugin.id, key, event.target.checked)}
              />
            </div>
          );
        }

        if (field.type !== 'number') return null;
        const value = Number(rawValue);
        return (
          <div key={key} title={`${settingText.label}: ${value}`}>
            <div className="text-muted-foreground mb-1 flex items-center justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate">{settingText.label}</span>
              <span className="shrink-0 tabular-nums">{value}</span>
            </div>
            <div className="flex items-center gap-2">
              {settingText.minLabel && (
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {settingText.minLabel}
                </span>
              )}
              <input
                type="range"
                min={field.min ?? 0}
                max={field.max ?? 100}
                value={value}
                aria-label={settingText.label}
                onChange={(e) => handleSetting(plugin.id, key, Number(e.target.value))}
                className="accent-primary h-1.5 flex-1 cursor-pointer"
              />
              {settingText.maxLabel && (
                <span className="text-muted-foreground shrink-0 text-[10px]">
                  {settingText.maxLabel}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

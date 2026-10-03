# Providers and plugins regression notes

Read this file when changing ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff,
or prompt commands.

## Every plugin-state writer shares the local-plugin import's lock

- **Trap:** Import wrote the new version with `enabled: false` under the `gv-local-plugins` lock,
  but setting toggles, enable toggles and Drive restore were unlocked whole-map writes: one that
  read the old `enabled: true` before the import and wrote after it switched the new, unreviewed
  version back on. A content script (the turn navigator's style guide) wrote the map too, and its
  `navigator.locks` belongs to the page origin, so it can never share an extension-page lock. A
  plain restore of an older Drive copy also enabled the new version with no race at all.
- **Rule:** Every `PLUGINS_STATE` and `PLUGIN_LOCAL_MANIFESTS` write runs under
  `withPluginStorageLock` (`storage/pluginStorageLock.ts`); removing a local plugin drops its
  record and state in one write. Content scripts never write plugin state: they send
  `PLUGIN_SET_SETTING_MESSAGE` (`requestPluginSetting`) and the background writes under the lock;
  the request carries one setting value and cannot enable a plugin. Drive restore may switch a
  `local.*` plugin off, never on.
- **Guard:** `src/features/plugins/local/localPluginMutations.test.ts`
  (`a plugin-state write racing a re-import`, `restoring plugin state from Drive`),
  `src/pages/background/__tests__/pluginRuntimeMessages.test.ts`.

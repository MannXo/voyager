# Regression Notes

Use this page to find the regression notes that match a change. Search for the affected feature or
service, then open the matching topic file. Load another topic only when the change crosses that
boundary.

## Add a note

Add a note when the root cause was not obvious, a maintainer could repeat the mistake, and a
regression test or exact verification command now protects the behavior.

Each entry has three fields:

- **Trap:** the symptom and root cause.
- **Rule:** the invariant the implementation must preserve.
- **Guard:** the protecting test or verification command.

Keep each field to one paragraph. Source history already records the fixing commit, so add commit
details only when the introduction point changes how a maintainer should reason about the bug. Run
`bun run regressions:check` after editing these notes.

## Topics

| Topic                                                           | Read when changing                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Providers and plugins](regressions/providers-plugins.md)       | ChatGPT or Claude adapters, plugin lifecycles, temporary chat handoff, or prompt commands.       |
| [State, identity, and sync](regressions/state-identity-sync.md) | Account or route identity, extension message lifetimes, storage mirrors, clear markers, or sync. |

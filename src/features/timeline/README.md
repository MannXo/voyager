# Shared timeline ownership

`TimelineEngine` composes one captured conversation through `TimelineAdapter`. The adapter supplies
turn identity, observation roots, viewport discovery and persistence. The engine owns the rail,
preview, tooltips, interactions, navigation and settings application. The same owners render Gemini,
ChatGPT, Claude and DeepSeek.

| Behavior                                                            | Owner                                           |
| ------------------------------------------------------------------- | ----------------------------------------------- |
| Rail composition, styles, preview and viewport synchronization      | `TimelineView`                                  |
| Dot geometry, dense/virtual dots, ruler wave and runner             | `TimelineDotLayer`                              |
| Slider scroll dragging and fade                                     | `TimelineSlider`                                |
| Width/position restore, migration and dragging                      | `TimelineRailPlacement`                         |
| Preview search, pinning and hover bridge                            | `TimelinePreviewPanel`, `TimelinePreviewPress`  |
| Tooltip delay, content and visibility                               | `TimelineTooltip`                               |
| Marker navigation, star long press and hierarchy menu               | `TimelineMarkerInteractions`                    |
| Shortcuts, active turn and navigation cancellation                  | `TimelineNavigation`                            |
| Virtualized turn homing, reversed scrollers and remembered geometry | `VirtualizedTimelineNavigation`, `scrollMotion` |
| Collapse layout                                                     | `TimelineHierarchyGeometry`                     |

The [Gemini adapter](../../pages/content/timeline/GeminiTimelineAdapter.ts) retains Gemini selector
priority, stable identities, account scope, verified legacy aliases and timestamps. Its state and
storage owners remain in the [native timeline directory](../../pages/content/timeline/README.md).

The [catalog adapter](adapters/catalog/CatalogTimelineAdapter.ts) receives semantic selectors from
`site.json` and optional `turnNavigator` manifest parameters. It retains identity and ownership
across virtualized DOM windows. Its state stores hierarchy and timeline-local stars under per-site
keys; stars still mirror the Saved Library. Every edit requires evidence that the turn belongs to
the current conversation. Catalog data currently exposes no account identity, so these sites have
site/conversation scope; Gemini keeps its existing account scope.

Viewport replacement rebinds scroll and intersection observation while retaining conversation state.
Path/query replacement destroys the engine and creates a fresh conversation adapter. Gemini's shared
history timestamp store has page lifetime: conversation teardown unsubscribes without stopping it.

Rail and preview styles are injected from `timeline.css` and `timelinePreview.css` by the view and removed on teardown. Shared theme tokens and
coachmark replicas remain in `public/contentStyle.css` because other features use them. Existing
`.gemini-timeline-bar`, `.timeline-track-content` and `.timeline-style-compact` classes remain the
highlight marker DOM contract. New DOM ownership metadata is `gv-` prefixed.

The packaged `turnNavigator` primitive remains the compatibility entry point for old remote catalogs.
Its name, parameter validator and engine floor are unchanged; both bundled and cached remote manifests
run the shared engine. Older extension builds can continue reading these unchanged manifests.

# Third-Party Notices

## FenixAgent

- Source: https://github.com/HuangPuStar/FenixAgent
- Commit: `72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9` (main)
- License: Apache License 2.0 (see `LICENSES/Apache-2.0.txt`)
- Upstream path: `packages/resources/memory/web/pages/hindsight/`

The following files under `src/web/features/memory/` are ports or adaptations of
the FenixAgent memory constellation renderer:

- `constellation-scene.ts` — ring layout, heat colour ramp, link indexing and
  visual constants, adapted from `components/constellation-scene.ts`.
- `constellation-state.ts` — pointer/view state shape, adapted from
  `components/constellation-state.ts`.
- `constellation-labels.ts` — inline/card label drawing and collision grid,
  adapted from `components/constellation-labels.ts`.
- `constellation-paint.ts` — on-demand frame painter, adapted from
  `components/constellation-paint.ts`.
- `ConstellationCanvas.tsx` — React shell and interaction wiring, adapted from
  `components/Constellation.tsx`, `components/constellation-tooltip.ts` and the
  legend behaviour in `components/constellation-legend.ts`.

Modifications for this repository:

- Removed the `@chenglou/pretext` dependency; label measurement and wrapping use
  the Canvas 2D `measureText` API instead.
- Replaced the continuous `requestAnimationFrame` loop with on-demand painting
  driven by React effects.
- Replaced the upstream tooltip DOM construction with React text nodes and
  routed all displayed strings through `maskSecrets`.
- Added a flat-graph adapter for `network_agent_memory_graph`, single-node
  centering, fit-scale based zoom (100% = fit), selected-node outline, a DOM
  HUD/heat legend for accessibility and tests, and native Fullscreen API
  fullscreen mode with Escape handling and a keyboard focus loop.
- The graph data model (`ConstellationGraphData`) differs from FenixAgent's
  `GraphData`; only fields returned by this repository's MCP graph tool are
  populated. Missing fields such as `context`, `occurred`, `proof` and `tags`
  are intentionally not fabricated.

## Fenix memory panel vendor scaffold (stage 2)

- Source: https://github.com/HuangPuStar/FenixAgent
- Commit: `72a1e4742bf04cb69aef6edfb5fd9ecaae9743a9`
- License: Apache License 2.0 (see `LICENSES/Apache-2.0.txt`); the upstream repository has no `NOTICE` file, and no upstream notice text is fabricated here.
- Upstream root for memory UI: `packages/resources/memory/web/pages/hindsight/`
- Upstream root for UI primitives: `packages/ui-components/web/`
- These files live under `src/web/features/memory/fenix/` and are not referenced by the production SPA in this phase.

| Vendored file | Upstream path | Modifications |
| --- | --- | --- |
| `types.ts` | `pages/hindsight/types.ts` | Verbatim type definitions. |
| `failure.ts` | `pages/hindsight/failure.ts` | `ApiError` check replaced by local `FenixApiError`; failure classification unchanged. |
| `recency.ts` | `pages/hindsight/recency.ts` | Verbatim. |
| `memory-type-title.ts` | `pages/hindsight/memory-type-title.ts` | Verbatim. |
| `element-height.ts` | `pages/hindsight/element-height.ts` | Verbatim. |
| `MemoriesPage.tsx` | `pages/hindsight/MemoriesPage.tsx` | Removed the `mental-models` perspective (no backend contract in this repository); master-detail shell replaced with a local shim; platform imports redirected to fenix modules. |
| `MemoriesPage.css` | `pages/hindsight/MemoriesPage.css` | Verbatim. |
| `i18n.ts` | `packages/resources/memory/web/i18n/locales/zh/hindsight.json` | Dictionary keys/copy copied; i18next/react-i18next replaced with a local `useTranslation`/`t()` shim. |
| `components/DataView.tsx` | `pages/hindsight/components/DataView.tsx` | Platform imports redirected; the graph view renders a local placeholder because cytoscape is not vendored in this phase. |
| `components/use-data-view-data.ts` | `pages/hindsight/components/use-data-view-data.ts` | Imports redirected to local `api`/`useRequest`; fetch and derivation semantics unchanged. |
| `components/data-view-model.ts` | `pages/hindsight/components/data-view-model.ts` | Verbatim. |
| `components/data-view-table.tsx` | `pages/hindsight/components/data-view-table.tsx` | Platform imports redirected; displayed text/entities/tags pass through `maskSecrets`. |
| `components/data-view-timeline.tsx` | `pages/hindsight/components/data-view-timeline.tsx` | Platform imports redirected; text/entities pass through `maskSecrets`. |
| `components/data-view-control-panel.tsx` | `pages/hindsight/components/data-view-control-panel.tsx` | Platform imports redirected. |
| `components/EntitiesView.tsx` | `pages/hindsight/components/EntitiesView.tsx` | Platform imports redirected; entity names pass through `maskSecrets`. |
| `components/graph-model.ts` | `pages/hindsight/components/graph-model.ts` | Verbatim. |
| `components/Graph2d.tsx` | `pages/hindsight/components/Graph2d.tsx` | Local placeholder, not a port: upstream requires cytoscape/cytoscape-fcose, which are deliberately not added in this phase. |
| `components/HindsightFailureNotice.tsx` | `pages/hindsight/components/HindsightFailureNotice.tsx` | Platform imports redirected. |
| `components/MemoryDetailBody.tsx` | `pages/hindsight/components/MemoryDetailBody.tsx` | Platform imports redirected; text/context/entities/tags pass through `maskSecrets` (reveal flow deferred to the UI-switch phase). |
| `components/MemoryDetailModal.tsx` | `pages/hindsight/components/MemoryDetailModal.tsx` | Platform imports redirected. |
| `components/MemoryDetailPanel.tsx` | `pages/hindsight/components/MemoryDetailPanel.tsx` | Platform imports redirected; `sonner` toast replaced by a local DOM-event shim. |
| `components/MemoryDetailPanel.css` | `pages/hindsight/components/MemoryDetailPanel.css` | Verbatim. |
| `components/MemoryPagination.tsx` | `pages/hindsight/components/MemoryPagination.tsx` | Platform imports redirected. |
| `components/MemoryViewSwitcher.tsx` | `pages/hindsight/components/MemoryViewSwitcher.tsx` | Platform imports redirected. |
| `components/MemoryVisualizationShell.tsx` | `pages/hindsight/components/MemoryVisualizationShell.tsx` | Platform imports redirected. |
| `components/Constellation.tsx` | `pages/hindsight/components/Constellation.tsx` | Platform imports redirected; theme comes from `prefers-color-scheme` instead of the upstream forced-light provider. |
| `components/constellation-scene.ts` | `pages/hindsight/components/constellation-scene.ts` | `@chenglou/pretext` removed; layout/heat/link-index semantics unchanged. |
| `components/constellation-labels.ts` | `pages/hindsight/components/constellation-labels.ts` | Pretext wrapping replaced by canvas `measureText` greedy wrapping; labels pass through `maskSecrets`. |
| `components/constellation-paint.ts` | `pages/hindsight/components/constellation-paint.ts` | `TFunction` imported from local i18n. |
| `components/constellation-legend.ts` | `pages/hindsight/components/constellation-legend.ts` | `TFunction` imported from local i18n. |
| `components/constellation-state.ts` | `pages/hindsight/components/constellation-state.ts` | Verbatim. |
| `components/constellation-tooltip.ts` | `pages/hindsight/components/constellation-tooltip.ts` | `TFunction` imported from local i18n; values written with `textContent`/`replaceChildren` and masked; `document_id` row removed. |
| `components/agent-master-detail-workspace.tsx` | `packages/ui-components/web/components/agent-master-detail-workspace.tsx` | Native `overflow-auto` replaced upstream `ScrollArea`; slot layout preserved. |
| `ui/button.tsx`, `ui/button.css` | `packages/ui-components/web/ui/button.tsx`, `button.css` | Local primitive copy; internal import paths changed. |
| `ui/input.tsx` | `packages/ui-components/web/ui/input.tsx` | Local primitive copy; internal import paths changed. |
| `ui/table.tsx`, `ui/table.css` | `packages/ui-components/web/ui/table.tsx`, `table.css` | Local primitive copy; internal import paths changed. |
| `ui/badge.tsx`, `ui/badge.css` | `packages/ui-components/web/ui/badge.tsx`, `badge.css` | Local primitive copy; internal import paths changed. |
| `ui/card.tsx`, `ui/card.css` | `packages/ui-components/web/ui/card.tsx`, `card.css` | Local primitive copy; internal import paths changed. |
| `ui/skeleton.tsx` | `packages/ui-components/web/ui/skeleton.tsx` | Local primitive copy; internal import paths changed. |
| `ui/spinner.tsx` | `packages/ui-components/web/ui/spinner.tsx` | Local primitive copy; internal import paths changed. |
| `ui/dialog.tsx`, `ui/dialog.css` | `packages/ui-components/web/ui/dialog.tsx`, `dialog.css` | Local primitive copy; internal import paths changed. |
| `ui/select.tsx`, `ui/select.css` | `packages/ui-components/web/ui/select.tsx`, `select.css` | Local primitive copy; internal import paths changed. |
| `ui/label.tsx` | `packages/ui-components/web/ui/label.tsx` | Local primitive copy; internal import paths changed. |
| `ui/empty-state.tsx` | `packages/ui-components/web/config/EmptyState.tsx` | Local primitive copy; internal import paths changed. |
| `ui/cn.ts` | `packages/ui-components/web/lib/cn.ts` | Verbatim. |
| `clipboard.ts` | `packages/ui-components/web/lib/clipboard.ts` | Verbatim. |
| `theme.ts` | `packages/ui-components/web/lib/theme.tsx` | Rewritten to follow `prefers-color-scheme` (upstream forces light). |

Local (not ported) files in the same tree, kept small and documented in their own headers:
`api.ts` (adapter boundary; default rejects), `hooks/use-request.ts` (ahooks subset),
`ui/toast.ts` (sonner subset), `css/fenix.css` (scoped Tailwind entry, no preflight),
`index.ts` (vendor entry), and the `Graph2d.tsx` placeholder above.

### Dependencies added by this phase

| Package | License | Role |
| --- | --- | --- |
| `lucide-react` | ISC | Upstream icon imports, tree-shaken into the lazy memory chunk. |
| `clsx` | MIT | `cn()` class joining. |
| `tailwind-merge` | MIT | `cn()` conflict resolution, matching upstream semantics. |
| `class-variance-authority` | Apache-2.0 | Upstream `Button`/`Badge` variants. |
| `@radix-ui/react-slot` | MIT | `asChild` support in Button/Badge. |
| `@radix-ui/react-label` | MIT | Upstream `Label` primitive. |
| `@radix-ui/react-select` | MIT | Upstream `Select` primitive. |
| `tailwindcss` (dev) | MIT | Scoped utility generation. |
| `@tailwindcss/vite` (dev) | MIT | Vite integration for the scoped utility generation. |

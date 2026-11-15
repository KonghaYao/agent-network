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

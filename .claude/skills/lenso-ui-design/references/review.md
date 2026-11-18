# Rendered review

For daily visual review in this repository, use `bun run dev:docs` and keep its
hot-reloading server running. Use a production artifact when acceptance depends
on production behavior, following the repository's `CONTRIBUTING.md`.
Record whether each check used dev or production.
Capture candidate and reference with matching viewport, theme,
direction and state. Wait for fonts and overlays to settle; use reduced motion
or disabled screenshot animations for stable geometry.

Confirm the primary task is visible and usable. Compare frame and pane boundaries,
then information density, type and
spacing, then surfaces/icons/focus treatment. Record discrepancies with their
location and cause. Fix the shared rule when several pages show the same error.
Avoid a pixel-diff claim when the reference, fonts or content do not match.

For alignment changes, measure the relevant text starts, icon bounds, baselines
or shared tracks. For spacing changes, identify the parent that owns each gap.
Check longer labels and larger text before accepting a compact arrangement.
Use `docs/design/apple-guidance.md` in the Lenso UI checkout to distinguish a
platform recommendation from a Lenso-specific value or a verified browser state.

For each affected page, review:

- Initial desktop and narrow layout.
- Light/dark surfaces and edited accent/font/radius where relevant.
- A selected/open state and keyboard focus.
- Reachable empty/invalid content and overflow/scrolling ownership.
- RTL and reduced motion when supported by the surrounding application.

Run behavior checks separately: native selection, form validation, dismissal,
focus restoration and theme propagation into portals. Geometry assertions
complement screenshots; screenshots complement typecheck/lint/build. Neither
alone proves the other axis.

Deliver a small evidence table identifying pages, viewports/states, comparison
status and unresolved differences. State when color contrast was not checked or
when exact source values fail it. Leave missing evidence visible rather than
converting a draft or unavailable reference into an approval.

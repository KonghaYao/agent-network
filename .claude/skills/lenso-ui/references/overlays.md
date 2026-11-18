# Overlays and focus

Choose by task, then read that installed family's parts and maintained example.
Modal is a task dialog, AlertDialog a consequential confirmation, Popover
anchored content, Menu actions, and Tooltip a short accessible hint. Drawer,
Sheet and ActionSheet retain different panel and touch-interaction contracts.

## Preserve the native hierarchy

Follow the installed root, trigger, backdrop and `Content` composition. SDK
Content owns positioning, presence and focus in the browser's top layer.
Popups render in place by default; do not add a Portal or Positioner part.
Use `Menu.SubContent`
inside `Menu.Sub`. Drawer and Sheet expose the SDK handle and snap-point
contracts. Tooltip delay belongs on Root. Toast uses `createToaster` and
`Toast.Region`; pass each independent queue explicitly.

Use the native `render` composition for custom triggers, preserving props, refs
and handlers. Avoid nested interactive elements. Dialogs need an accessible
title; associate explanatory text through the supported description part.
Keep one owner for controlled open state and let native callbacks report close
reasons. Retain native dismissal, focus management and scroll locking rather
than adding document-level listeners.

## Theme and material ownership

Use ThemeScope around the popup's owning tree. In-place top-layer content
inherits that scope. An explicit `container` or custom portal changes
inheritance: inspect where it mounts before duplicating theme
variables. Apply semantic StyleX maps to exported slots. Use the family's own
positioning and stacking behavior; inspect clipping and scroll containers before
adding arbitrary z-index or viewport positioning.

Ordinary fields inside a dialog keep form material. Reuse the shared Glass
recipe only where the floating surface's role calls for it. One popup owns its
surface; nested controls do not each need another glass background.

## Verify

Open by keyboard and pointer; check initial focus, Tab navigation, Escape,
outside interaction and return focus. Verify scroll containment, anchored
positioning after scrolling and narrow viewport behavior. Check theme/direction
inside the actual portal. For nested overlays, dismiss the inner layer and
confirm the outer layer and its focus remain correct.

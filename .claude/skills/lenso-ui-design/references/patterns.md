# Page composition patterns

Use the application's established design direction. These patterns explain
relationships; exact component parts and variants come from the installed API.

## Settings and forms

Group fields by the decision they support, with one section label and concise
supporting text where useful. Keep labels, controls, descriptions and errors
associated. Ordinary fields share the form surface; the group owns its outer
background and corners. Avoid making every row another card.

Align peer labels and controls to shared tracks. Let long labels wrap without
colliding with trailing controls. On a narrow screen, stack the tracks when
that preserves editing space. Keep Save/Cancel near the draft they commit;
immediate settings use the appropriate immediate-control contract.

## Collections and detail

Choose a list or table based on the comparison task. Tables keep comparable
values on stable columns and show units; lists allow richer variable content.
Use stable keys, one selection owner and the native collection semantics. Show
empty, loading and error states in the content region they replace.

A split view needs useful content in both panes. At narrow widths, define how
users reach detail and return without losing their query, selection or scroll
position. Search and filters remain reachable without consuming the entire
first view. Row actions belong to their row or an explicit selection toolbar.

## Navigation and surfaces

Tabs switch associated content panels; TabBar navigates destinations. Keep the
active destination visible and labels understandable. Prefer existing overflow
behavior over squeezing every destination into unreadable items.

Use Glass when floating navigation or controls need separation from moving
content. Grouped content and fields use their ordinary semantic surface. Evaluate
legibility over the actual backdrop, including a portalled popup. A more vivid
material does not compensate for unclear hierarchy.

## Responsive and interaction states

Establish the scroll owner and overlay bounds before tuning fixed heights.
Keep the primary task usable with narrow widths, longer translated labels and
larger text. Let spacing and tracks reflow before reducing control hit areas.

Keyboard focus, hover, pressed, selected and invalid states convey different
facts. Keep the state distinctions visible in both themes. Editing preserves
caret, selection, paste and resizing. Motion expresses a state change or direct
manipulation; reduced motion preserves complete feedback and operation.

## Review priorities

Inspect task visibility, grouping, shared edges and baselines, then type/spacing,
semantic colors and material detail. For spacing defects, identify the parent
that owns the gap; for repeated defects, correct the shared rule. Validate actual
rendered rectangles when alignment or overflow is the issue.

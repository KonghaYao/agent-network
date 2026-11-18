---
name: lenso-ui-design
description: Design or visually review pages built with @lenso/ui. Use for new screens, responsive layout, screenshot reconstruction, page polish and rendered comparison; component API, theme wiring and build failures use lenso-ui.
---

# Design with Lenso UI

## Establish the intended screen

Read the application's design direction and existing screen. Identify the
primary task, real content, next action and states that affect the layout.
A small correction follows the established direction. A new screen or substantial
redesign benefits from comparing viable structures before choosing variants.
When supplied a screenshot or live reference, use
[reference.md](references/reference.md).

In the Lenso source checkout, `DESIGN.md` owns visual decisions;
`docs/design/component-conventions.md` owns exact component rules. For an
Apple-inspired decision read the relevant topic in `docs/design/apple-guidance.md`.
In a consumer without those files, use the project's direction and the portable
[page patterns](references/patterns.md); no Lenso checkout is required.

## Compose the page

Resolve actual public components with the sibling
[Lenso UI skill](../lenso-ui/SKILL.md). Choose hierarchy, reading order and shared
alignment before colors, radii or motion. Assign each gap one owner and each
surface a task. Use semantic theme roles and existing material recipes.

Read [patterns.md](references/patterns.md) for settings/forms, collections,
navigation and narrow-screen adaptations. Preserve real content, longer labels
and usable controls while choosing density. Native HTML owns static structure;
interactive components keep their native parts and behavior.

Implement one representative section with a working primary interaction. Render
it in the actual application and adjust before expanding. If implementation is
already delegated, use [handoff.md](references/handoff.md) to keep shared decisions
and acceptance states consistent.

## Review the rendered result

Use [review.md](references/review.md) to inspect task, structure, alignment,
hierarchy, interaction and adaptation. Repair the highest-impact shared defect,
then render again. Review behavior separately from appearance: a working form
does not establish visual fidelity, and a screenshot does not establish focus
restoration or validation.

Finish when the requested task works and no known material defect remains in
the reviewed scope. Report the rendering environment, relevant viewports/states,
comparison evidence and remaining gaps. Source review alone supports a proposal,
not a claim that the screen was visually verified.

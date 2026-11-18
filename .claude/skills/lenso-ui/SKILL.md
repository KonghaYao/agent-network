---
name: lenso-ui
description: Build, fix or integrate @lenso/ui components with StyleX, semantic themes and UI SDK interactions. Use for Lenso component selection, forms, overlays, theming, Vite/Next setup and missing-style debugging in consumer apps or the Lenso UI checkout.
---

# Lenso UI

Lenso supplies React components as packages. Application styles use StyleX;
UI SDK owns native Web interactions. Start with the project's installed API,
not a similarly named shadcn, Radix, HeroUI or React Aria component.

## Establish project context

Read `package.json`, the lockfile, framework configuration and an existing Lenso
screen. Identify the package manager, installed UI/tokens versions, rendering
entry, StyleX compiler and current theme scope. In a workspace, resolve packages
from the application that imports them. Use [query.md](references/query.md) to
locate public exports, native props, implementation and examples directly.

For this checkout, read `DESIGN.md` and the relevant sections of
`docs/design/component-conventions.md`. Use native SDK contracts in the owning UI family or `packages/primitives` and update callers with them;
do not introduce Base UI compatibility layers or dependency patches.
Consumer applications follow their own design direction and installed versions.

## Select and compose

| User needs                             | Starting family                                     | Detail                                      |
| -------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Submit or invoke an action             | Button; GlassButton for floating material           | [composition.md](references/composition.md) |
| Edit and validate text                 | TextField, Input, TextArea, Form                    | [forms.md](references/forms.md)             |
| Choose a value                         | Select; ComboBox for editable search                | [forms.md](references/forms.md)             |
| Choose multiple or independent options | CheckboxGroup, Switch                               | [forms.md](references/forms.md)             |
| Choose one option in a visible group   | RadioGroup, SegmentedControl                        | [forms.md](references/forms.md)             |
| Change content views                   | Tabs with associated panels                         | [composition.md](references/composition.md) |
| Navigate application destinations      | TabBar, NavigationBar, Sidebar                      | [composition.md](references/composition.md) |
| Show a task or confirmation            | Modal, AlertDialog                                  | [overlays.md](references/overlays.md)       |
| Show anchored content or actions       | Popover, Menu, ContextMenu                          | [overlays.md](references/overlays.md)       |
| Show a panel or touch sheet            | Drawer, Sheet, ActionSheet                          | [overlays.md](references/overlays.md)       |
| Edit dates, times or colors            | Matching date/time/color family and value model     | [forms.md](references/forms.md)             |
| Build a page or match a screenshot     | Use the [design skill](../lenso-ui-design/SKILL.md) | Layout and rendered review                  |

Confirm each family exists in the installed exports before importing it. Use its
built-in variants and supporting parts first. Keep one state owner for each
value, selection and open state; derive summaries from it.

## Lenso-specific rules

- `Button` variants are `prominent`, `bordered`, `borderless`; sizes are `sm`,
  `md`, `lg`. Destructive emphasis uses `destructive`. Recheck installed types
  before using these names on another family.
- Loading actions use the supported `isLoading` behavior, preserving focus while
  blocking repeat activation. `disabled` represents unavailable actions.
- Apply local StyleX through `xstyle`. Component wrappers compose caller maps
  last and preserve runtime custom properties and native style callbacks.
- Use semantic tokens for shared roles. Ordinary fields use the form surface;
  Glass belongs to floating navigation or controls with a material purpose.
- Preserve native `render`, refs, event callbacks, portal ownership and keyboard
  behavior. Resolve whether `Root` styles a DOM node before adding layout props.
- Keep the native date/time/color values and collection keys. Display labels
  and translated text are not stable selection identities.
- Floating surfaces use `Content`, submenus use `SubContent`; former
  Portal/Positioner/Popup adapters are absent. Imperative actions use native
  controllers, not former manager APIs.
- Autocomplete edits free text; ComboBox selects values. ListBox uses native
  scalar/array values, not Set-based selected keys. See [forms.md](references/forms.md).

For theme editing read [theming.md](references/theming.md). For first-time setup,
CSS delivery, SSR or production-only style failures read
[setup.md](references/setup.md). For a runtime defect use
[debugging.md](references/debugging.md).

## Verify the requested behavior

In this repository, iterate with `bun run dev:docs`; follow `CONTRIBUTING.md`
for affected checks and production acceptance. In a consumer, use its existing
format/lint/typecheck and framework build scripts.

Operate the changed workflow in its actual rendering surface: edit/select,
submit, open/dismiss and restore focus as applicable. Check the affected theme,
portal, overflow and narrow-layout states. A source snippet is reference code;
a passing typecheck does not establish stylesheet delivery or browser geometry.
Report the changed result, checks performed and material untested behavior.

# Compose native Lenso parts

This guidance uses Lenso native contracts and StyleX. Retained adaptation
attribution is in [provenance](../NOTICE.md).

## Establish the structure

Start from the matching family documentation, native signatures and applicable
example. Identify the root's state owner, its supporting parts and any context
requirements. Use actual public exports from `@lenso/ui`.

UI SDK owns controls, collections, forms and overlays. Specialized date, time
and color parts retain their domain value models while using native
UI SDK interaction parts. Native HTML owns static structure. Follow the queried API for that family; similarly
named parts from another library are not interchangeable.

Keep native `data-slot` and state attributes intact. Lenso's material and
appearance hooks use `data-lenso-slot`; do not replace the SDK attributes with
Lenso slot names. Components read direction from the DOM, not a direction provider.

Use controlled state when the surrounding workflow needs to coordinate it.
Keep one owner for each fact: selection, dialog openness, draft, theme or URL.
Native callbacks perform the update; derive counts, summaries and filtered rows
from that owner. Preserve stable item keys when labels are translated.

Choose semantic variants by functional emphasis: a primary action, alternatives,
low-emphasis actions and destructive actions. Resolve the actual allowed variants
per family rather than applying a Button variant table to every component.

## Style without replacing behavior

Use semantic theme variables for shared colors, fonts and radii. Compose local
StyleX maps through the documented `xstyle` surface and leave caller overrides
last. Retain all `stylex.props` output, including runtime custom properties.
Merge native state-dependent style callbacks with those properties.

Preserve native refs, render composition, event callbacks, state attributes,
focus behavior and portal ownership. Keep the required root/trigger/content
hierarchy even when rearranging presentation. Apply slot-specific maps to the
corresponding exported parts, not broad descendant selectors.

Tabs include their native panels and tab/panel associations, not just styled
tab buttons beside unrelated content. Collections, forms and overlays likewise
retain the contextual supporting parts documented for their native family.

Read the current map for variants, sizes, motion and focus styling instead of
introducing a second scale. Keep component-specific variant names. Lenso uses
StyleX rather than Tailwind class composition; upstream styling syntax is a
visual reference, not working consumer code.

## Prove the composition

Run typecheck and the actual rendering build. Then operate the changed workflow
with a keyboard: select, submit, open, dismiss and return focus. Check disabled,
invalid, empty and loading states that the workflow can reach.

For overlays, confirm the top-layer content retains edited theme variables and
direction, including an explicit container when used. For collection/form changes, confirm submitted values and selection
keys as well as visible labels. For layout changes, inspect the actual component
rectangles and scroll regions in both themes and relevant widths.

Keep component correctness and page design separate: this reference proves the
parts behave coherently, not that a composed screen matches a visual target.

## Concrete API differences

These examples illustrate the current source API. Resolve the installed version
before copying them; they are source snippets, not browser verification.

```tsx
import { Button } from "@lenso/ui";

<Button type="submit" variant="prominent" isLoading={saving}>
  Save changes
</Button>;
```

Use `destructive` for destructive meaning; `variant="destructive"` is not a
Button variant. Likewise, Lenso Button supports `isLoading`; rules written for
another library's Button cannot establish this contract.

```tsx
import { Button, Modal } from "@lenso/ui";

<Modal.Root>
  <Modal.Trigger render={<Button />}>Edit profile</Modal.Trigger>
  <Modal.Backdrop />
  <Modal.Content>
    <Modal.Header>
      <Modal.Title>Edit profile</Modal.Title>
      <Modal.Description>Update your profile details.</Modal.Description>
    </Modal.Header>
    <Modal.Body>{/* The actual editing form belongs here. */}</Modal.Body>
    <Modal.Footer>
      <Modal.Close render={<Button />}>Cancel</Modal.Close>
    </Modal.Footer>
  </Modal.Content>
</Modal.Root>;
```

`Modal.Content` owns top-layer presence and focus, rendering in place by default.
Use the native SDK composition
from the installed types and update callers when its contract changes.

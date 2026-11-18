# Configure one Lenso theme

This guidance uses Lenso's typed theme and scope APIs. Retained adaptation
attribution is in [provenance](../NOTICE.md).

Read the matching authored theming guide and `@lenso/tokens` exports. The theme
stylesheet supplies defaults and derived values; load it from the actual
rendering document before adding overrides.

## Choose the supported surface

- Shared semantic overrides: `defineTheme`, `themeToVariables`, `themeToCSS`.
- Theme editor inputs: derive keys/categories from `themeTokens`.
- Local component presentation: use its exported parts and `xstyle`.
- Scoped component/portal rendering: use `ThemeScope`.

A basic application composition is:

```tsx
import { defineTheme, themeToCSS, tintOverrides } from "@lenso/tokens";
import { ThemeScope } from "@lenso/ui";
import "@lenso/tokens/styles.css";

const theme = defineTheme({
  name: "studio",
  light: { ...tintOverrides([0.1, 0.4, 0.9], "light"), "shape-content": "0.625rem" },
  dark: tintOverrides([0.3, 0.6, 1], "dark"),
  lightIncreased: tintOverrides([0.1, 0.4, 0.9], "light", "increased"),
  darkIncreased: tintOverrides([0.3, 0.6, 1], "dark", "increased"),
});

<ThemeScope theme="light" data-lenso-theme={theme.name}>
  <style>{themeToCSS(theme)}</style>
  {/* Application components */}
</ThemeScope>;
```

For generated CSS, load `themeToCSS(theme)` after the default stylesheet. Put
`data-lenso-theme` and the matching `data-theme` on the same intended scope.
Replace the inline variable map when switching modes so omitted overrides return
to their defaults.

## Keep the source of truth

Use public CSS names without `--lenso-` in typed overrides. Leave derived hover/soft
mixes and material recipes in the theme CSS. Retrieve the current editable
keys rather than maintaining another token inventory or copying default values.
Pair `tint` with `label-on-tint`; keep background, label and status roles distinct.
Use `tintOverrides` for validated RGB custom tint pairs in each mode/contrast.
The font source key is `font-body`; named font references also need their family
variable and actual stylesheet/font delivery.

Keep a Theme Builder's editable settings, generated palettes and exported CSS
on one validated path. URL state is configuration, not sample application data.
Preserve separate ownership for preview content. Validate imported/shared input
with the existing domain guard before applying it.

## Inspect the rendered result

Exercise both modes, hover/focus states, explicit field radius overrides and a
portalled overlay. Check colors and geometry in computed styles, not just a
serializer string. Changing hue can change contrast: source fidelity and a
working theme selector do not certify WCAG contrast.

Provide `lightIncreased` and `darkIncreased` when custom colors need contrast variants.
Prefer `themeToCSS` for live system preference support. Inline maps must be
recomputed with `themeToVariables(theme, mode, contrast)` when appearance changes.
There are no legacy palette aliases; inspect the matching `@lenso/tokens` exports for current names.

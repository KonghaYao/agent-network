# Consumer setup and stylesheet delivery

Inspect the installed package README, framework config and an existing working
entry before editing. Preserve authored aliases, compiler options and CSS entry
ownership. Use the project's package manager for dependencies; add only what the
selected integration needs. Lenso components are imported packages, not source
files installed into the app.

## Shared requirements

Lenso ships compiler-readable JavaScript style declarations. Compile application
and library styles together using official StyleX integration. Import
`@lenso/tokens/styles.css` in the actual rendering entry for semantic theme/base
CSS. That stylesheet and generated atomic CSS have separate jobs: loading one
does not replace the other.

Use the installed packages' peer/dependency requirements. Read the matching
getting-started integration guide; avoid copying this checkout's workspace
aliases into a consumer application.

## Vite

Use `@stylexjs/unplugin` with the app's existing Vite setup. Ensure the plugin
processes shipped Lenso declarations as well as application StyleX. Preserve
plugin ordering and React integration from the matching supported setup. Check
a component with an application `xstyle` override in both dev and the built app.

## Next.js

Use the official StyleX Babel and PostCSS integration for installed versions.
Transpile `@lenso/tokens` and, when used, `@lenso/docs`. PostCSS scans include
shipped declarations and all app sources, including server-only styles.

Each rendering root layout, custom global-error and global-not-found document
imports the stylesheet containing theme CSS and the `@stylex` directive. Add
`"use client"` at the appropriate boundary for application state, handlers or
browser APIs. Keep framework server/client ownership intact. Next owns emitted
CSS assets and manifests; verify the production response and CSS requests.

The separate Lenso Docs host can stage official Babel/PostCSS defaults when no
authored config exists. That behavior belongs to the docs host, not every UI
consumer. Authored configs take precedence.

## Diagnose before changing configuration

| Symptom                                        | Inspect                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Components have classes but no appearance      | Generated atomic CSS, compiler inputs and loaded CSS assets             |
| Geometry exists but semantic colors are absent | Theme stylesheet in the rendering document and variable scope           |
| App styles work, Lenso styles are absent       | Compiler handling of shipped package declarations                       |
| Dialog has the wrong theme                     | ThemeScope and portal container inheritance                             |
| Dev works, production fails                    | Extraction/scanning inputs, root/error documents and actual emitted CSS |
| Inline styles disappear in a wrapper           | Full `stylex.props` output and native style callback merging            |

Verify a representative component, local `xstyle`, both theme modes and a
top-layer overlay in the consumer itself. SDK popups render in place by default;
check theme inheritance separately if using `container` or a custom portal.
Run its typecheck and framework build;
inspect computed style and served assets before claiming CSS delivery works.

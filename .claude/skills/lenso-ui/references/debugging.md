# Diagnose a Lenso integration defect

Start with the smallest failing workflow in the actual application. Record the
trigger, expected result and observed result, then inspect its owning layer.

| Failure                               | First evidence                                     | Likely owner                               |
| ------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| Missing export or rejected prop       | Installed export map and declaration               | API/version or copied upstream syntax      |
| Selection does not update             | Callback signature, controlled value and item keys | State/composition                          |
| Trigger fires twice                   | Rendered elements and merged handlers              | Nested control or event composition        |
| Focus escapes or does not return      | Native part hierarchy and portal mounting          | Overlay composition                        |
| Labels and errors are not announced   | Accessible name and field associations             | Form semantics                             |
| Missing styles or wrong portal theme  | Loaded CSS and computed variables                  | [Setup](setup.md) or [theming](theming.md) |
| Wrong spacing across several controls | Shared token map and parent geometry               | Shared style owner                         |
| Only generated docs disagree          | Current source and generation inputs               | Stale projection                           |

Read the affected declarations and implementation before changing behavior.
For UI SDK beta declaration/renderer constraint errors, distinguish runtime
defects from `exactOptionalPropertyTypes` incompatibility. This checkout's
temporary primitives policy retains `strict: true` and `skipLibCheck: false`
with `exactOptionalPropertyTypes: false`; see `docs/upstream-ui-sdk-types.md`
when available. A consumer enabling exact optional properties can still fail.
Do not patch dependencies or suppress declaration checking to hide that gap.
Compare with one maintained example and keep app state, styling and interaction
changes separable enough to identify the cause. Fix the shared owner when the
same defect appears in multiple places.

Use existing regression coverage first. Add a test when it can reproduce a
specific failure the current tests miss: submitted values, keyboard/focus,
portal theme, or measured browser geometry. DOM-only tests cannot establish
rendered dimensions, optical material quality or device performance.

Re-run the failing workflow and affected checks after the change. Report the
observed result and its environment; preserve any remaining browser/device or
production verification gap.

# Help and capability states

## Job

Help explains the controls that exist now, while unavailable states explain why one requested action cannot run now.

## Best simple implementation

Build help from the canonical command registry and current keymap.

Build action availability from provider and runtime capability reports.

Render unsupported actions as visible and disabled when discovery matters.

Use one `UnavailablePanel` for a requested action and one `HelpViewPanel` for discoverable guidance.

Do not advertise a command that no typed intent can dispatch.

## Component map

| Component | Responsibility |
| --- | --- |
| `HelpViewPanel` | Render current commands, keys, and concise usage guidance. |
| `UnavailablePanel` | Show the requested action and one exact capability or configuration reason. |

## Inputs and outputs

Help receives immutable command and key descriptions.

Fork help exposes `--confidential JSON` as the canonical workspace-fork request.

Unavailable state receives a safe title and reason.

Both surfaces emit only close or navigation events.

They do not mutate product state.

## Copy rules

Name the user action first.

State the exact missing capability, configuration, or connection condition.

Offer a valid route only when one exists.

Do not show fake progress, fake readiness, or procedural cards.

Do not repeat a control label as explanatory copy.

## Responsive behavior

Narrow help keeps command, key, and one-line meaning.

Wider help adds aliases and capability notes.

Unavailable state always keeps its title, reason, and close route visible.

## Failure and safety

Capability reports are authoritative for availability.

An unknown report disables the action instead of guessing support.

Reasons are sanitized and cannot carry terminal controls.

Credential or provider-private details never appear in the reason.

## Proof

Tests compare the command registry, palette, autocomplete, help, and dispatcher for drift.

Fixtures cover unavailable runner actions, workspace fork, attach, interaction, analysis, and connection states.

## Non-goals

Help does not become product documentation inside the main transcript.

An unavailable panel does not silently change the selected profile or connection.

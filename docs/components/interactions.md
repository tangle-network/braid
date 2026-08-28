# Interactions and secrets

## Job

Interactions let a user answer, approve, decline, cancel, or automate a runtime request with the shape the provider declared.

## Best simple implementation

Render every request through the canonical `answerSpec` contract.

Use one `InteractionShell` that delegates value entry to the matching input component.

Use `TerminalInteractionController` as the only modal queue and dispatch coordinator.

Keep secret entry in `MaskedSecretInput` and send the value only through its bounded response path.

Fail closed for an unknown answer shape that Braid cannot validate.

## Component map

| Component | Responsibility |
| --- | --- |
| `TerminalInteractionController` | Select the next pending request, open its panel, and reconcile response outcomes. |
| `InteractionShell` | Render the request context, answer control, outcomes, timeout, and footer. |
| `InteractionDecisionList` | Select one declared decision or option. |
| `OutcomeKeys` | Route explicit approve, decline, and cancel keys. |
| `SecretInput` | Adapt a secret answer specification to masked entry. |
| `MaskedSecretInput` | Accept a secret without exposing its value through render or inspection. |

## Inputs and outputs

An `InteractionView` includes run, interaction, provider session, kind, prompt, answer specification, outcomes, deadline, and capability data.

The component emits a typed response or cancellation with both run and interaction identifiers.

The operation identifier remains stable across retry and restart.

The component never emits a value that violates the declared answer specification.

## Answer shapes

Text supports required and maximum-length constraints.

Number supports required, minimum, and maximum constraints.

Boolean and select use declared options.

Forms validate every field and emit one complete response object.

Secret answers use masked entry and a secret-designated response path.

Unknown shapes render the generic explanation and disable invalid submission.

## Queue and concurrency

Interactions stay attached to their source run.

The controller shows one interaction at a time and retains the remaining order.

Focusing another run changes priority but does not reassign a request.

Answering a background request carries its explicit run identifier.

Duplicate provider events do not create a second modal.

## Failure and safety

Timeout, provider cancellation, user cancellation, stale response, declined response, and accepted response remain distinct outcomes.

A secret value never enters profiles, SQLite, logs, view models, snapshots, screenshots, or trace artifacts.

An acknowledged response replays as the same result.

A changed response with the same operation identifier returns a conflict.

Terminal text is sanitized before the prompt or option label renders.

## Performance

Only the active interaction panel renders.

The pending queue uses immutable summaries and bounded prompt text.

Deadline updates do not rebuild the transcript.

## Proof

Tests cover every answer shape, keyboard acceptance, decline, timeout, cancel, duplicate event, response retry, restart, secret canaries, and unknown shapes.

Live proof must keep a retained cloud interaction answerable after Braid reconnect and continue exactly once.

## Non-goals

The component does not invent an approval policy or default answer.

It does not store credential values for later reuse.


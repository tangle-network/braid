# Interaction automation

## Job

Interaction automation reuses a non-secret response for matching future requests under an explicit scope and audit record.

## Best simple implementation

Create rules only from a current interaction and a response that passed its `answerSpec`.

Use `AutomationOverlayWorkflow` for asynchronous list and mutation coordination.

Use `AutomationRulePanel` for list, create, scope, confirmation, disable, and delete steps.

Use `RuleResponseEditor` for the supported reusable answer shapes.

Keep matching and execution in the application domain, not the panel.

## Component map

| Component | Responsibility |
| --- | --- |
| `AutomationOverlayWorkflow` | Load rules and dispatch idempotent create, disable, and delete operations. |
| `AutomationRulePanel` | Coordinate the visible rule workflow. |
| `RuleResponseEditor` | Validate one reusable response against the current request. |

## Scope

`once` applies to the next matching request.

`session` applies within the declared provider or runtime session boundary.

`persistent` survives restart and requires explicit confirmation.

The interaction declares which scopes are allowed.

The UI does not offer a broader scope.

## Inputs and outputs

A rule contains a stable identifier, matcher, safe response, scope, enabled state, usage count, and optional maximum uses.

Creation emits the source run and interaction identifiers plus a stable operation identifier.

Disable and delete target one exact rule identifier.

The list response contains no secret response values.

## Failure and safety

Secret, unknown, and unsupported form responses remain manual.

Persistent creation names the future effect and requires confirmation.

Rule parsing fails closed on malformed data.

Duplicate operations return the recorded result.

Automation never bypasses a provider capability or user policy check.

## Performance

The workflow loads bounded rule summaries only while open.

Filtering and editing remain local until the user confirms an operation.

## Proof

Tests cover create, once, session, persistent confirmation, maximum uses, disable, delete, restart, malformed data, secret refusal, and duplicate operations.

## Non-goals

The panel does not predict an answer or create a rule from text similarity alone.

It does not store secret-designated answers.


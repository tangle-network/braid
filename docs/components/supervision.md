# Supervisor graph

## Job

The supervisor graph shows the runtime-owned tree of active supervisors and workers and routes supported controls to one exact worker.

## Best simple implementation

Read the canonical runtime supervisor snapshot through the shared Runtime API.

Project it into bounded `GraphNodeView` rows with stable supervisor, worker, run, and parent identifiers.

Render it through `GraphView` and the shared entity browser.

Dispatch steer or cancel through the runtime control API with a stable operation identifier.

Wait for the runtime acknowledgement and render its effect instead of treating request admission as success.

Reconnect by loading a fresh runtime snapshot and rereading the same operation identifier.

Use `attachWorker` only when an exact provider source exists and the runtime returns an opaque interactive handle.

Do not read `.agent/supervisor` files or infer control support from worker status text.

## Component map

| Component | Responsibility |
| --- | --- |
| `GraphView` | Filter and navigate the projected hierarchy and open node details. |
| `RuntimeSupervisorWatcher` | Read and refresh the Runtime-owned immutable snapshot. |
| `RuntimeSupervisorController` | Resolve one exact worker and route typed steer, cancel, and attach operations. |
| `SupervisorService` | Serialize projection commits and expose the supervisor port to the application. |

The runtime owns graph reads, control reconciliation, and live worker state.

## Inputs and outputs

Each node includes kind, stable identifier, parent, depth, status, label, spend, timing, and declared actions.

Graph edges contain explicit source and destination identifiers.

Steer and cancel intents include the source Braid run, supervisor, worker, payload, and operation identifier.

The component renders the recorded control outcome after runtime reconciliation.

Steer acknowledgement includes the matching request digest, exact worker, and delivered effect.

Cancellation acknowledgement includes the matching operation, proven terminated worker identifiers, and effect.

Terminal takeover exposes only the runtime handle or the runtime's explicit unavailable reason.

## Hierarchy and refresh

Projection keeps required ancestors for every retained recent worker.

Sibling order follows the runtime snapshot order and stable recency rules.

Two Braid runs keep separate supervisor bindings even when snapshot order changes.

Refresh ignores an unchanged snapshot and stops when the graph closes.

Selection remains on the same node identifier across refreshes.

Reconnect never reuses a stale local control result as a new effect.

## Capability behavior

Steer appears only when the runtime reports steer support for that worker.

Cancel appears only when the runtime reports cancellation support.

Attach remains disabled until Runtime exposes an external-client attach contract.

The disabled action includes that exact reason.

An available attach result carries the exact provider-owned process handle, not a reconstructed display row.

## Failure and safety

An unavailable runtime read preserves the last confirmed snapshot and shows stale status.

An unknown control result remains unknown until the runtime reports a terminal outcome.

Duplicate controls reconcile by operation identifier.

A control can never target a row by display position.

Worker output and labels are sanitized before display.

An admitted request without an acknowledgement remains queued or unknown.

The graph never reports delivered steering or cancellation without the matching Runtime effect.

## Performance

Projection retains a bounded recent set plus required ancestors.

Graph filtering and layout remain linear in the bounded set.

Refresh uses one subscription or bounded poll per open surface.

## Proof

Tests cover hierarchy, cycles, missing parents, two supervisors, status updates, spend, steer, cancel, unavailable actions, restart, and unchanged refresh.

The deterministic supervisor fixture exercises the same public Runtime API shape without creating supervisor files.

Live proof requires a real root and worker stream, a changed spend observation, acknowledged steering, proven cancellation, and a fresh reconnect snapshot.

The release check records terminal takeover as attached or unavailable and never treats an unavailable provider as an attachment.

## Non-goals

Braid does not implement a supervisor, agent loop, worker process, or attach transport.

The graph does not equate a branch, run, worker, and provider session.

# Supervisor graph

## Job

The supervisor graph shows the runtime-owned tree of active supervisors and workers and routes supported controls to one exact worker.

## Best simple implementation

Read the canonical runtime supervisor snapshot through the shared Runtime API.

Project it into bounded `GraphNodeView` rows with stable supervisor, worker, run, and parent identifiers.

Render it through `GraphView` and the shared entity browser.

Dispatch steer or cancel through the runtime control API with a stable operation identifier.

Do not read `.agent/supervisor` files or infer control support from worker status text.

## Component map

| Component | Responsibility |
| --- | --- |
| `GraphView` | Filter and navigate the projected hierarchy and open node details. |

The runtime owns graph reads, control reconciliation, and live worker state.

## Inputs and outputs

Each node includes kind, stable identifier, parent, depth, status, label, spend, timing, and declared actions.

Graph edges contain explicit source and destination identifiers.

Steer and cancel intents include the source Braid run, supervisor, worker, payload, and operation identifier.

The component renders the recorded control outcome after runtime reconciliation.

## Hierarchy and refresh

Projection keeps required ancestors for every retained recent worker.

Sibling order follows the runtime snapshot order and stable recency rules.

Two Braid runs keep separate supervisor bindings even when snapshot order changes.

Refresh ignores an unchanged snapshot and stops when the graph closes.

Selection remains on the same node identifier across refreshes.

## Capability behavior

Steer appears only when the runtime reports steer support for that worker.

Cancel appears only when the runtime reports cancellation support.

Attach remains disabled until Runtime exposes an external-client attach contract.

The disabled action includes that exact reason.

## Failure and safety

An unavailable runtime read preserves the last confirmed snapshot and shows stale status.

An unknown control result remains unknown until the runtime reports a terminal outcome.

Duplicate controls reconcile by operation identifier.

A control can never target a row by display position.

Worker output and labels are sanitized before display.

## Performance

Projection retains a bounded recent set plus required ancestors.

Graph filtering and layout remain linear in the bounded set.

Refresh uses one subscription or bounded poll per open surface.

## Proof

Tests cover hierarchy, cycles, missing parents, two supervisors, status updates, spend, steer, cancel, unavailable actions, restart, and unchanged refresh.

Live proof requires a real root and worker stream plus observed steering and cancellation effects.

## Non-goals

Braid does not implement a supervisor, agent loop, worker process, or attach transport.

The graph does not equate a branch, run, worker, and provider session.


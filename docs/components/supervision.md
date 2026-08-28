# Supervisor graph

## Job

The supervisor graph shows the runtime-owned tree of active supervisors and workers and routes supported controls to one exact worker.

## Best simple implementation

Read the canonical runtime supervisor snapshot through the shared Runtime API.

The protected LIVE-11 command provisions one Runtime-owned supervisor when no external run is supplied.

The Runtime provisioner creates the root, worker, acknowledger, and provider binding through its public APIs.

The provisioner returns exact identifiers and an owner-scoped cleanup function.

Project it into bounded `GraphNodeView` rows with stable supervisor, worker, run, and parent identifiers.

Render it through `GraphView` and the shared entity browser.

Dispatch steer or cancel through the runtime control API with a stable operation identifier.

Wait for the runtime acknowledgement and render its effect instead of treating request admission as success.

Reconnect by loading a fresh runtime snapshot and rereading the same operation identifier.

Use `attachWorker` only when an exact provider source exists and the runtime returns an opaque interactive handle.

Do not read `.agent/supervisor` files or infer control support from worker status text.

The protected command accepts `BRAID_SUPERVISOR_ROOT`, `BRAID_SUPERVISOR_ID`, and `BRAID_SUPERVISOR_WORKER` only as an all-or-nothing external-run override.

Those identifiers are not the normal path and Braid never cleans up an external run it does not own.

## Component map

| Component | Responsibility |
| --- | --- |
| `GraphView` | Filter and navigate the projected hierarchy and open node details. |
| `RuntimeSupervisorWatcher` | Read and refresh the Runtime-owned immutable snapshot. |
| `RuntimeSupervisorController` | Resolve one exact worker and route typed steer, cancel, and attach operations. |
| `SupervisorService` | Serialize projection commits and expose the supervisor port to the application. |
| `RuntimeSupervisorProvisioner` | Ask Runtime to create one owned proof run and validate its cleanup receipt. |

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

Attach appears in the interactive TUI when at least one projected worker is running.

Braid resolves the selected projected identifiers back to Runtime identifiers before attachment.

Runtime rereads the exact durable worker binding and returns an opaque handle or a named unavailable reason.

Braid claims control, suspends its own screen, forwards terminal input and resize, and restores the same screen after detach.

The JSONL interface keeps attachment unavailable because it cannot present a native terminal.

If Runtime reports that the selected provider supports terminal takeover, LIVE-11 requires a successful exact attach.

A failed attach never becomes a simulated terminal row.

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

Tests cover hierarchy, cycles, missing parents, two supervisors, status updates, spend, steer, cancel, exact attach, unavailable actions, restart, and unchanged refresh.

The deterministic supervisor fixture exercises the same public Runtime API shape without creating supervisor files.

Live proof provisions a real root and worker through Runtime, then requires a stream, a changed spend observation, acknowledged steering, proven cancellation, and a fresh reconnect snapshot.

The release check records terminal takeover as attached or unavailable and never treats an unavailable provider as an attachment.

An owned proof run must return a completed cleanup receipt with terminal root and worker status, `resourcesReleased: true`, and no remaining resources.

The receipt validator binds cleanup to the provisioned root, supervisor, and worker identifiers.

Cleanup runs after a passing proof and after every failed observation or control attempt.

The proof records configured external runs as `not-owned` and records the owner-scoped cleanup receipt for provisioned runs.

Runtime provisioner contract:

```text
provisionSupervisor({ invocationId, environment, workspaceDir, timeoutMs, pollMs, profile?, connection? })
  -> { rootDir, supervisorId, workerId, providers?, terminalTakeover, cleanup() }
cleanup()
  -> { status: "completed", rootDir, supervisorId, workerId,
       supervisorStatus, workerStatus, resourcesReleased: true, remainingResources: [] }
```

The environment argument contains only supervisor selectors, endpoints, model and runner preferences, workspace, and opaque credential references.

The optional profile is the canonical `AgentProfile` supplied by the caller.

The optional connection is the caller's connection record.

The Runtime creates its canonical default profile and connection when those optional values are absent.

The environment argument is never written into the proof receipt.

The Runtime owns all supervisor files and provider resources created by this contract.

## Non-goals

Braid does not implement a supervisor, agent loop, worker process, or attach transport.

The graph does not equate a branch, run, worker, and provider session.

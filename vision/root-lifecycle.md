# Durable root and worker lifecycle

Proposed 2026-10-07. These are acceptance requirements, not claims that the pinned Runtime or Braid already implements them. The [root profile](root-agent.md) defines decisions; Runtime owns execution and recovery; Cloud owns sandbox lifecycle; Braid presents and controls their acknowledged state.

The user talks to one logical root across many runs. That root can remain responsive while children work, receive their results after an absence, and explain what changed. A logical root is not a permanently running model process or a new AgentProfile type.

## Required behavior

| Capability | Required contract |
| --- | --- |
| Durable event inbox | Retain user input, child outcomes, interactions, timers, and authorized external events with source identity, deduplication identity, and ordering information. An MCP notification can prompt delivery; it must not be the only record of unfinished work. |
| Wake and dispatch | Committing a child outcome makes a root continuation discoverable even if the root is offline. Recovery closes the gap between persisting that outcome and scheduling its consumer. Repeated delivery cannot admit duplicate work. |
| Responsive conversation | User input can inspect or steer an active pursuit without waiting for every child. Runtime serializes conflicting decisions and fences stale coordinators. Parallel reasoning may produce proposals; it cannot race to commit conflicting changes. |
| Exact delegation | Record parent linkage, immutable profile and task, acceptance criteria, granted authority, resource reservation, environment, artifacts, and operation identity. A timed-out submission is reconciled before retrying. |
| Topology controls | Address an exact root, subtree, or worker. Record requested scope and each acknowledged effect, including unavailable or unknown descendants. Children created concurrently must obey the effective parent control state. |
| Resource accounting | Reserve capacity before child admission, inherit narrower limits recursively, reconcile actual usage, and release reservations only on evidence. Count root work, descendants, analysis, retries, tool usage, and infrastructure. Missing usage is unknown, never free. |
| Recovery | Restore committed decisions, unconsumed events, profile receipts, pending interactions, worker bindings, artifacts, and accounting. Discover still-running workers before replacing them. Preserve unsupported native-session recovery as a visible limitation. |
| Verified completion | Separate provider termination, artifact delivery, acceptance, and objective completion. A successful child exit does not establish that its result is correct or that the root's task is finished. |
| Explainable waiting | Say what is active, blocked, awaiting the user, scheduled, or unknown; give the last observed progress and next wake condition. A heartbeat establishes liveness, not useful progress. |
| Revocation and revision | Apply steering, withdrawn authority, and objective changes at explicit boundaries. Late results retain provenance but cannot revive cancelled work or activate an obsolete profile revision. |

Native subagents and Runtime cloud workers may support different controls. Retain those distinctions. Reuse existing canonical identities and owner contracts before adding fields or another abstraction.

## Stop and resume must mean something precise

| Operation | Meaning |
| --- | --- |
| Detach the client | Close Braid while authorized remote work continues. Reattach reconstructs an honest view from owner state and retained events. |
| Pause root continuation | Stop admitting new root decisions and delegation. Already-admitted children follow the recorded policy, continue or receive their own control request. Their events accumulate durably. |
| Pause a subtree | Prevent new descendant admission and request supported suspension of existing work. Show pending, unsupported, and unknown effects. Never label an active process suspended because a request was accepted. |
| Resume | Reconcile from a checkpoint and consume subsequent events under current authority and remaining resources. Do not repeat already-committed effects. |
| Cancel | Revoke future admission for the selected scope, propagate cancellation, and reconcile running work and reservations. Completion needs acknowledgements or an explicit unresolved state. |
| Fork from a point | Create distinct work with explicit conversation, profile, workspace, and external-state copy semantics. It does not undo actions in the world or clone all live processes. |

A topology checkpoint describes a recoverable boundary and any in-flight work. It need not be an atomic snapshot of every sandbox. The contract must state which state was captured, which work still runs, and how recovery resolves uncertainty. Retention expiry must be visible before a checkpoint is advertised as resumable.

## Bounded autonomy

The root can allocate its remaining allowance; a child cannot mint a fresh allowance by spawning another child. Runtime enforces admission, concurrency, depth, deadlines, and scoped authority independently of writable profile text. Reservations and settlement need one authoritative owner and fencing against concurrent admissions.

Reserve enough capacity for checking results, reporting, and shutdown. Decide what happens when a cap is near: narrow work, return a partial result, wait for an authorized increase, or stop. Do not promise a hard currency cap when a provider lacks enforceable limits or timely usage. Expose the enforceable bound and remaining uncertainty.

Durable subscriptions and timers need stable identities, cancellation, and catch-up rules. Batch related completions and apply backpressure rather than invoking the root model for every token or heartbeat. Approval requests survive restarts with their original scope and expiry. A missing user answer never becomes permission. Child artifacts and external events remain untrusted input, even when they claim authority.

## Failure tests that earn the durability claim

| Fault or race | Required observable result |
| --- | --- |
| Crash before or after child admission acknowledgement | One child execution or an explicit unresolved admission; no blind replacement. |
| Child commits while root is offline, or crash before wake is queued | Outcome survives and becomes consumable after recovery; no lost wake. |
| Duplicate, delayed, or reordered events | Stable final state and one admitted continuation for the same committed decision. |
| User steering and child completion arrive together | Defined ordering; accepted steering is preserved and stale results cannot override it. |
| Two coordinators recover the root | Only the current owner can commit; the stale owner cannot dispatch or spend. |
| Pause or cancel races with grandchild creation | Effective scope prevents new admission; every existing descendant has an acknowledged or explicit unresolved state. |
| Restart with pending approval or profile activation | No implicit approval, lost decision, duplicate activation, or mutation of admitted run receipts. |
| Concurrent children reserve the last capacity | Reservations remain within the enforceable parent allocation, including descendants. Late usage and abandoned work remain accountable. |
| Worker or host disappears | Reconcile provider state, leases and retained evidence before replacement. Keep uncertain effects unknown. |
| Resume an old checkpoint or expired sandbox | Explain captured state, later effects, and missing resources. Never imply the external world was rolled back. |
| Child exits successfully with a bad artifact | Root rejects or repairs the result under its remaining budget; objective remains incomplete. |
| Burst of outcomes, revoked authority, or obsolete timer | Bounded queue processing; no new unauthorized work or revival of cancelled objectives. |

Use deterministic assertions and fault injection for ledger, accounting, and lifecycle invariants. Use a small number of semantic evaluations for the quality of objectives, delegation, and synthesis. Retain tests that detect these consequential failures; remove tests that merely repeat implementation details only after checking their unique coverage.

First integration proof: through Braid, launch a root with two real cloud children and one bounded grandchild; disconnect Braid; let one child finish; pause and resume the supported scope; restart the coordinator; steer the objective; cancel a subtree; reconnect and inspect the accepted artifact, outstanding work, and reconciled budget. Inject duplicate delivery and uncertain admission in the same owner contracts. Record exact builds, profiles, run and environment identities, fault timing, event receipts, effects, and remaining gaps. Fake-provider tests support this proof but cannot replace it.

Test larger fleets only after this flow passes. Define recovery time, event backlog, concurrency, cancellation latency, and spend bounds before increasing scale. A graph with thousands of nodes proves rendering capacity, not durable execution.

# Implementation path

Draft 2026-10-07. Root agent's provisional plan, awaiting the requested [GPT-6 Pro reviews](reviews/gpt-6-pro-2026-10-07/README.md). This is not an audited consensus or authorization to implement every stage.

The first deliverable is one root AgentProfile that can converse, author useful bounded child work, preserve continuity, and propose a justified change to its own methods. Build that complete flow before expanding the number of roles, domains, or workers.

## Reuse before extending

The [upstream durability inventory](https://github.com/tangle-network/agent-runtime/blob/3e9e7f166cce374a44403804f2b175b90f862705/docs/durability.md), inspected at Runtime's 0.308.0 preparation commit, assigns supervised journals and coordinator fencing to Runtime, durable sleeping event/timer waits to Platform Workflows, and workspace recovery to the sandbox stack. It also distinguishes an in-process delegation queue from recoverable supervised work. Use the [checked dependency cohort](../docs/04-runtime-contracts.md#evidence-baseline) for Braid's current integration boundary.

Braid already uses Runtime's retained-run start, recovery, and reconnect APIs. Current upstream supervision has child-outcome wakeups, inherited budget reservations, and cancellation. A normal Braid conversation does not yet start a supervised root; its supervisor viewer and controls observe separately created Runtime work. The first integration must bind that conversation to the existing supervisor, preserve its exact identity across recovery, and prove root re-entry when a child returns. Reimplementing sandbox persistence, budget accounting, or a worker scheduler in Braid would duplicate the owners we need to compose.

Topology pause remains a separate gap. Runtime 0.308.0 accepts root pause, resume, and ask signals without applying an effect; only cancel acts. [Runtime PR #1649](https://github.com/tangle-network/agent-runtime/pull/1649) removes those unsupported signals and rejects stale calls explicitly; that source fix is merged and awaiting package adoption. Do not advertise topology pause until its admission and acknowledgement semantics exist and pass the lifecycle tests below. Existing `deliver` steering and cancellation remain the supported controls.

Stage 0 must check published exports, compatible versions, and actual consumer behavior. Reuse those owners for the lifecycle requirements. In particular, "Runtime/Cloud" below names a composition of existing owners; it does not propose moving Platform Workflows' scheduler into Runtime or Braid. The audit prompts retain their original proposal snapshots so later corrections remain traceable.

## Sequence and completion evidence

| Stage | Concrete deliverable | Primary owner | Completion evidence |
| --- | --- | --- | --- |
| 0. Establish the real execution path | Inventory the pinned contracts, identify published upstream reuse, and restore a working root and cloud-worker route. | Runtime/providers and Tangle Cloud; Braid integrates | Exact profile admission and usable artifacts through the served Braid path. Catalog discovery and fake providers are insufficient. |
| 1. Ship one starting root profile | A versioned canonical profile and referenced skills define conversation, objective discovery, profile authoring, and learning policy. Use existing profile selection. | Profile content; Interface only for demonstrated contract gaps | Same seed handles a clear task, an ambiguous need, and conversation needing no new objective. No fixed domain hierarchy is added to Braid. |
| 2. Close one recursive delegation flow | Root authors a child profile, delegates through maintained Runtime coordination, receives an artifact, checks it, and explains its contribution. | Runtime/provider coordination; Braid visibility | Inspect exact parent/child profile receipts and resource bounds. Exercise a child creating a useful grandchild. Compare with staying solo. |
| 3. Close the durable event and control flow | Compose retained child outcomes, root wakeups, steering, cancellation, reservations, and coordinator recovery. Extend the owner contract for topology pause and resume only where the existing controls cannot express it. | Runtime and Cloud; Braid reconnect/control | The [lifecycle failure matrix](root-lifecycle.md#failure-tests-that-earn-the-durability-claim) passes, including a real cloud topology. No lost wake, duplicate admission, budget multiplication, or fabricated control acknowledgement. |
| 4. Add bounded continuation | Wake on an authorized external event, scheduled obligation, or new user input using the same durable delivery path. | Runtime/Cloud event and recovery contracts | Stable subscriptions, catch-up and cancellation rules; bounded bursts; no invented objective simply because the agent is idle. Braid can be closed. |
| 5. Close one personal learning flow | Distinguish remembered facts, active commitments, preferences, and reusable profile behavior. Propose an exact root revision, test it, apply under the update policy, and allow rollback. | Profile policy, knowledge owner, Runtime/Eval; Braid review | Two users diverge usefully from the same seed; a correction can be withdrawn; restart retains the right revision; a held-out comparison supports the claimed benefit. |
| 6. Learn capability investment | Compare direct work, native delegation, cloud workers, reusable code, skills, or a trained specialist where justified. | Root policy and artifacts, Runtime execution, Eval comparison | One investment beats the best simpler approach on relevant held-out work after acquisition, evaluation, maintenance, and failure costs. |
| 7. Prove portability and reuse | Export the profile and permitted resources; let a second client direct the same durable work. Add starter catalogs only when they solve a demonstrated need. | Interface/catalog owners, Runtime/Cloud consumers | Clean-environment replay of the claimed capability, explicit incompatibilities, private-state separation, and no terminal dependency in the second client. |

Stages 1 and upstream route repair can proceed independently. The first integrated demonstration spans stages 1 through 3. Personal evolution follows a proved durable root, event delivery, and shared budget. Each intermediate stage must provide a useful, inspectable result. Reliable event-driven continuation precedes an always-on product promise.

## Decisions the audits must settle

- Can current canonical fields and resource references express the root's methods and evolution policy, or is a narrow upstream extension necessary?
- Which durable identity and event contracts are published and proved on the intended path, rather than only present in later source?
- What is the smallest reliable distinction between a preference, a tentative inferred need, an adopted objective, and execution authority?
- Which changes may activate automatically under a user-selected update policy, and which require a separate decision?
- How can objective discovery and useful restraint be evaluated without rewarding engagement, agreement, or manufactured tasks?
- What evidence justifies preserving an expensive learned capability rather than returning to a simpler method?

Do not introduce a Braid optimizer, profile dialect, scheduler, domain taxonomy, or universal team architecture. Reuse published owner contracts, extending their source only when a demonstrated consumer need cannot be expressed.

## First comparison

Use a small varied pilot to validate instrumentation, then repeat on held-out cases. Include a checkable task, a changing user preference, an ambiguous request, a stale objective, and a conversation where delegation would be wasteful. Technical tasks are convenient initial cases, not the definition of generality.

Compare with a well-configured native harness and its own delegation features. Freeze acceptance, starting state, and granted authority. Record model/tool differences and count all children, retries, analysis, verification, integration, cloud cost, and user effort. Keep unknown costs unknown.

The first success is useful user-specific behavior, one verified delegated result, truthful recovery, and one justified profile revision. Thousands of workers, a profile marketplace, specialist-model training, and universal domain coverage are not prerequisites.

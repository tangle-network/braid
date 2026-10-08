I’ll form an independent view from the supplied drafts, inspect the repository and upstream contracts I can access, and then check the native-harness comparisons. I’ll distinguish what Braid ships from later source and proposed guarantees, and keep the review read-only.

Current Braid main is ahead of the supplied commit, but it still pins Runtime 0.263.0 and Interface 2.13.1. Its source makes a useful distinction: profile learning produces an **unmeasured draft**, and worker controls report requested or acknowledged effects. I’m now checking which later Runtime contracts can support the proposed lifecycle without adding another coordinator.

The later source changes the ownership question: Runtime now explicitly rejects root pause/resume/ask signals, while its durability docs assign sleeping timers and event waits to Platform Workflows. Platform already has recovery logic for a settled child whose parent has not been requeued. The remaining question is how to connect those contracts into a durable root inbox, with one admission authority and honest native-control limits.

The canonical profile contract appears sufficient for the behavioral part. It already supports skills and capabilities; stronger preparation and candidate contracts also bind exact resource bytes and activation identities. That makes the first build primarily an integration task. One significant caveat: a native subagent definition is narrower than a full `AgentProfile`, so those two delegation paths cannot promise interchangeable behavior.

One release distinction changes the audit: the latest GitHub release I could verify is Braid 0.3.3, and its source lacks the profile-learning and runner-advice modules now on main. I’ll classify those as committed source whose public shipment is unverified. The recommendation is a staged path: prove useful profile-directed work first, then connect the existing durability owners and test the cloud lifecycle before enabling autonomous revisions.

## Decision

**Keep one canonical `AgentProfile` as the root’s behavioral configuration. Build durable execution by composing the existing owners, with Braid remaining a client. Do not build a root-specific profile dialect, a Braid scheduler, or a universal orchestration layer.**

The central claim is sound when “one profile” means one definition of the agent’s methods. It becomes unsound if that profile also becomes the authoritative store for commitments, permissions, event consumption, budgets, or activation decisions.

The smallest delivery path has two stages: first demonstrate useful profile-directed work and reviewed personalization using the strongest native baseline; then connect Runtime’s admission, recovery, and accounting to Platform’s durable waits. Autonomous revision comes after that lifecycle works.

**A material correction to the proposal:** current Runtime documentation assigns sleeping timers and event waits to **Platform Workflows**. Runtime owns execution and recovery. Reintroducing sleeping orchestration inside Braid—or a second Runtime scheduler—would duplicate an existing owner.

I read both complete drafts and their committed counterparts, inspected the named repositories and primary comparison sources, and consulted no other review of this proposal. This audit executed no tests or cloud workloads and made no repository changes.

## Evidence and status

“Inspected” below means source, release records, or retained logs read during this audit. It does not mean independently reproduced deployment behavior.

| Layer | Inspected evidence | Status and consequence |
|---|---|---|
| **Released Braid** | The latest GitHub release returned was [v0.3.3](https://github.com/tangle-network/braid/releases/tag/v0.3.3), identifying source `afc8380e06dbb164532d6d7af753394375c81c42`. Its source lacks `profile-learning.ts` and `runner-advice.ts`. | The release records package installation checks. **Public shipment of the later learning/advice features was not verified.** Absence of a v0.3.4 tag does not prove npm 0.3.4 is absent. |
| **Committed Braid** | Main was `5932e0d45507af9cad6b8918496b864d52f79be7`, two documentation-only commits beyond the supplied baseline. [Package pins](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/package.json) remain Runtime 0.263.0, Interface 2.13.1, Eval 0.187.2. [Learning source](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/src/app/profile-learning.ts) explicitly returns `status: 'unmeasured'`. | Profile editing, snapshots, feedback-derived drafts, observational advice, and shared application/headless operations exist in inspected source. They do not establish autonomous root evolution. |
| **Reusable pinned upstream** | Interface 2.13.1 already provides canonical profiles, preparation receipts, candidate resources, diffs, and activation contracts. Runtime 0.263.0 already documents [proposal, review, and activation](https://github.com/tangle-network/agent-runtime/blob/93690289acd6eb7aeacc48cfe73473dc143cdd4e/docs/improve.md#L247-L307). | Improvement machinery is not wholly a later invention. Reuse these contracts before designing replacements. Their existence does not establish Braid’s activation integration. |
| **Later, publication-evidenced Runtime** | Runtime `849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7` declares 0.309.0; its [publisher log](https://github.com/tangle-network/agent-runtime/actions/runs/37699621051/job/113064084659) reports publication. It requires Interface `^3.1.1`, Eval `>=0.209.1 <0.210.0`, and Sandbox `>=0.58.4 <0.61.0`. | This is a dependency-cohort migration, not one pin change. It includes fenced SQL contexts and stronger coordination/recovery, but **root pause/resume remain unsupported**: [noncancel root signals throw](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/supervisor.ts#L1149-L1156). |
| **Platform durability source** | At `agent-dev-container@838373b73e2e3457550054f1d3720a8c04ffb170`, [`workflow-suspensions.ts`](https://github.com/tangle-network/agent-dev-container/blob/838373b73e2e3457550054f1d3720a8c04ffb170/products/platform/api/src/lib/workflow-suspensions.ts#L677-L793) reconciles missed child-terminal hooks and crashes between suspension settlement and parent requeue. | Strong existing reuse point. It currently speaks workflow/run/node identities; arbitrary Braid root events are not thereby integrated. Deployment behavior was not verified. |
| **Discovery** | Default branch is `master`; inspected revision `9e6118f764bae60017dc3fc99c90fb93bd6dbf0f`. Its [architecture](https://github.com/tangle-network/discovery/blob/9e6118f764bae60017dc3fc99c90fb93bd6dbf0f/docs/02-architecture.md) calls `supervise(profile, task, runtimeOptions)` directly and rejects a Discovery coordinator. | Reuse its architectural discipline and run artifacts. There is no Discovery execution package to import. |
| **Still unestablished** | The inspected components do not demonstrate one cross-run root inbox, durable consumption/admission transaction, hosted active-profile binding, complete subtree controls, and real cloud consumer proof together. | These are the delivery gaps. Describing them as already solved by “journaling” or “recursive execution” would overstate the evidence. |

Two qualifications matter. Runtime’s durability inventory calls fenced SQL contexts production, while their [source annotation remains `@experimental`](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/sql-run-context.ts#L45-L64). Also, Interface 3.1.1 has [publication evidence](https://github.com/tangle-network/agent-sdk/actions/runs/37595597226/job/112707330956), but its associated cloud evidence run stopped on revoked-key preflight; that proves neither successful cloud integration nor a contract defect.

Registry retrieval returned “URL … is not accessible via this tool”; no fresh npm installation was performed. `agent-runtime@93690289…:docs/durability.md` returned GitHub API **404 Not Found**; the current document and pinned implementation sources were inspected instead.

## 1. What belongs in the profile

**Design proposal:** maintain six distinct responsibilities.

| Concern | Correct home |
|---|---|
| Behavioral configuration | Canonical `AgentProfile`: instructions, model/harness preferences, requested tools, skills, resources, and permissions. |
| Executable methods | Versioned skills, programs, workflow scripts, datasets, and other artifacts referenced through supported contracts. Code admission remains a real execution boundary. |
| User knowledge | Access-controlled, sourced records with scope, correction, and withdrawal semantics. The profile specifies how to use them. |
| Active commitments | Accepted tasks, objective revisions, pending decisions, subscriptions, and worker bindings in their durable owner records. |
| Evaluation policy | A task- or experiment-specific frozen acceptance contract, checker identity, and retained verdicts. |
| Execution/update authority | Trusted host policy and provider enforcement, independent of writable profile content. |

Existing [`AgentProfile`](https://github.com/tangle-network/agent-sdk/blob/34fe83e6cb3af69e701c6cc3ecb9c6f848c652c7/packages/agent-interface/src/agent-profile.ts) can express objective discovery, listening, capability selection, profile authoring, and revision proposals through instructions and referenced skills. It does not need fields such as `root`, `organization`, or `selfImprovementLoop`.

However, a frozen declaration is not necessarily frozen execution. Generic resource references permit mutable Git refs. Use the existing [preparation receipt](https://github.com/tangle-network/agent-sdk/blob/34fe83e6cb3af69e701c6cc3ecb9c6f848c652c7/packages/agent-interface/src/agent-execution-preparation-receipt.ts#L65-L124), activated-file evidence, and content-addressed candidate resources to bind the resolved bytes, backend, harness version, effective model, and workspace preparation.

**No necessary AgentProfile schema extension was demonstrated.** If a provider cannot retain that evidence, extend its materialization/receipt implementation. If durable activation is missing, implement Runtime’s existing application transaction/reconciliation port.

Private personalization deserves particular care: the Interface explicitly treats profile content as caller-declared public data participating in unsalted identity. “Ask before creating a recurring commitment” can be reusable behavior; a user’s private circumstances belong in scoped knowledge, not an exported profile.

A direct user correction also does not require a fabricated improvement experiment. Apply an authorized canonical diff with truthful provenance. Reserve measured-improvement claims for actual comparisons.

## 2. Architecture alternatives and recommendation

| Architecture | Integration cost and coupling | Usability and native behavior | Durability | Reversibility |
|---|---|---|---|---|
| **A. Strong native baseline:** one profile, native goal/workflow, Braid presentation | Lowest; mostly profile materialization and capability exposure | Preserves native conversation, workflow, and session behavior | Only what the native/provider path proves; no general cross-host root guarantee | Highest |
| **B. Native execution within a durable Runtime pursuit; Platform wakes it** | Moderate; requires explicit contracts between existing owners | Preserves native execution while adding cloud delegation and an honest cross-client view | Can satisfy the proposal after integration and fault proof | High if profiles/artifacts remain portable and clients remain thin |
| **C. Everything becomes a generic Runtime agent graph** | Highest migration cost; strong coupling to generic control semantics | Uniform interface, but substantial native workflow and continuation loss | Centralized state is attractive; correctness still requires the same effect and recovery contracts | Lowest |

**Recommend B, built from A.** Do not make every ordinary conversation pay the cost of a durable pursuit. A conversation becomes continuing work when the user or an existing grant adopts a commitment.

Native baselines are already substantial. Claude workflows run scripts in the background while conversation remains responsive, but the workflow cannot receive mid-run user input, and replay may rerun later agents. Codex Goals are persisted thread-scoped completion contracts whose continuation occurs only at idle boundaries. These are different execution semantics. 

Pi Durable is explicitly experimental and distinct from Pi’s coding agent. Deep Agents persists asynchronous task metadata, but updating a task interrupts its run and starts another. Neither description establishes the proposed cross-system root lifecycle. 

I would choose A permanently if native improvements satisfy the actual continuity requirements and B adds no meaningful user benefit. I would reconsider B if adapting Platform’s workflow-bound waits requires importing a business-workflow interpreter into every root.

### Control hierarchy

The division should be precise:

- **Profile/selected artifact:** decides what work is worthwhile and which method to try.
- **Native goal or workflow:** controls continuation inside its admitted native execution.
- **Runtime:** admits exact executions, coordinates Runtime workers, fences ownership, and conserves delegated resources.
- **Platform:** retains subscriptions/timers and makes an eligible Runtime continuation discoverable.
- **Cloud/provider:** owns processes, sessions, environments, and actual control effects.
- **Frozen checker or authorized user:** accepts the artifact and objective outcome.

A native goal’s completion ends its assigned native scope. It does not independently establish acceptance of the enclosing product objective.

Native children must not be mirrored as Runtime workers merely to obtain a uniform tree. Interface’s [`AgentSubagentProfile`](https://github.com/tangle-network/agent-sdk/blob/34fe83e6cb3af69e701c6cc3ecb9c6f848c652c7/packages/agent-interface/src/agent-profile.ts#L299-L310) is narrower than a full `AgentProfile`. A child needing independent resources, MCP configuration, or another harness requires a path that can admit that complete profile.

Keep transport retries under the same operation identity; keep native retries inside their admitted execution; allow semantic retries only after the prior attempt is reconciled. Never replace an `in-doubt` execution blindly.

Runtime already has [atomic reservations and bounded nested subpools](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/scope.ts#L773-L815). Extend that mechanism rather than creating Braid budgets. Include root reasoning, checking, retries, tools, and infrastructure; avoid charging both an aggregate and its constituent children. Missing dollar usage can close further admission, but the [pool does not independently meter providers](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/budget.ts#L29-L62). An admission ceiling is not automatically a hard invoice cap.

Do not normalize detach, admission pause, process suspension, cancellation, native resume, workspace restoration, and transcript transfer into one “resume” abstraction. Likewise, process termination, artifact delivery, acceptance, and objective completion must remain separate.

## 3. Complete boundary flow

The following is the **proposed end-to-end contract**, using existing components where identified above. It is not a claim that the complete flow currently works.

| Boundary | Owner, immutable inputs, and durable identity | Side effect, failure state, and user evidence |
|---|---|---|
| **Seed → first conversation** | Braid resolves canonical profile source/revision; provider preparation binds effective profile, resource bytes, capabilities, and execution plan. Retain conversation, branch, operation, and run IDs separately. | Admission may start execution. Invalid or unsupported materialization blocks it. Show authored/effective differences and the exact receipt. |
| **Ambiguous need → adopted work** | Braid retains the user exchange; the execution owner commits the authorized task, objective revision, acceptance criteria, authority reference, and allowance against existing pursuit/run references. | Conversation alone creates no continuing obligation. A proposed objective remains proposed until covered by authorization. Show what was adopted and its limits. |
| **Capability choice → authored child** | Root-selected authoring skill produces canonical profile bytes, exact task/context, checker reference, resource closure, and narrowed grants. Runtime binds assignment/key, parent node, and child identity. | Writing a candidate does not authorize executing it. Validation/refusal must identify the failed capability or resource dimension. |
| **Admission → native/cloud dispatch** | Runtime journals intent and reserves capacity before provider effects; retained-run records bind operation, run, session, execution, and environment IDs. | Cloud creation and dispatch are effects. Timeout becomes reconciliation or `in-doubt`; no blind replacement. Show the original binding and admission status. |
| **Child return → accepted artifact** | Runtime retains artifact hashes, terminal evidence, usage completeness, and lineage. The selected independent checker receives frozen artifact/input/criteria versions. | Successful exit can still yield rejection. Show delivery and verdict separately; repair requires remaining allowance. |
| **Evidence → root revision proposal** | Existing `AgentProfileDiff`/candidate contracts bind baseline, candidate, rationale, evidence references, and any comparison policy. | Produces a draft, not an active root. Show exact changes, private-data handling, and whether benefit was measured. |
| **Proposal → activation** | Trusted application transaction checks expected baseline digest, current authority, expiry, operation identity, and review. Runtime already supplies [activation/reconciliation contracts](https://github.com/tangle-network/agent-sdk/blob/34fe83e6cb3af69e701c6cc3ecb9c6f848c652c7/packages/agent-interface/src/agent-candidate.ts#L1023-L1112). | Atomically change the active binding and record the receipt. Conflict or indeterminate outcomes reconcile. Existing runs retain their admitted profiles; the new version governs eligible future admissions. |
| **Disconnect → return** | Braid restores its journal and owner references; Runtime reconciles executions and unconsumed outcomes; Platform retains wake eligibility. Native continuation requires the recorded context-boundary proof. | Detachment preserves authorized remote work only where supported. Missing native continuation becomes an explicit fresh-session transfer or unavailable state. Show active, blocked, scheduled, cancelled, and unknown work with next wake conditions. |

For conflicting user and worker events, use committed order within the logical root and explicit expected objective/profile/authority revisions. Revocation updates the admission fence immediately; it must not wait for the model to read a message. A stale coordinator’s database writes **and dispatch/spend attempts** must fail.

### Where always-on lives

It lives in a hosted event/wait owner, durable accepted-work records, recoverable execution bindings, and a process capable of claiming the next continuation after failure.

Runtime’s [coordination log](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/coordination-log.ts#L1-L65) deliberately retains uncertain delivery as evidence without automatically replaying old instructions. Its live coordination delivery tracking is not by itself a cross-run inbox. Connect it to the existing Platform reconciliation path with durable event identity, consumption state, and idempotent continuation admission.

Another product should consume the same profile/task execution, owner projections, artifact references, and acknowledged controls. It need not import Braid’s TUI. Braid already exposes [application and protocol entry points](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/src/index.ts); that is useful client reuse, not proof of a hosted always-on service. Avoid extracting another “agent core” package before a second consumer demonstrates a missing shared contract.

## 4. Ordered implementation batches

These are proposals, with dependencies rather than unsupported dates.

| Batch and owner repository | Existing contract to reuse/extend | User-visible result | Dependency and acceptance proof | Delete or defer |
|---|---|---|---|---|
| **0 — Braid: bounded prototype** | Canonical profiles, native execution, feedback/diff preview, artifact references | A clarified need produces useful work and a reviewable revision | Start with inspected compatible pins. Two differing needs plus a conversation-only case; inspect exact materialization and result quality | Defer autonomous activation, new registry, and permanent roles |
| **1 — agent-sdk: execution conformance** | Preparation receipts, resource activation, provider capability contracts | Exact capabilities or explicit refusal on each selected path | Batch 0 identifies required axes. Test pinned bytes, stale resources, native/full-profile differences, continuation, and control acknowledgements against published packages | Delete compatibility guesses and lossy adapters |
| **2 — agent-runtime: durable admission and control** | `Scope.spawn`, retained admission, fenced run context, budget pool, coordination log | No duplicate child; durable root-admission pause/cancel; accountable descendants | Batch 1. Deterministic crashes, stale-owner dispatch, last-capacity races, and cancellation/grandchild races | No second worker ledger or budget owner |
| **3 — agent-dev-container: durable wake integration** | Platform suspensions, guarded run transitions, child-terminal reconciliation | A child outcome resumes eligible work after clients/coordinator disappear | Batch 2 identity contract. Crash between result commit and wake; duplicate ingress; cancelled subscription and catch-up tests | No Braid polling scheduler; no domain strategy in workflow defaults |
| **4 — Braid: lifecycle consumer** | Existing application core, JSONL protocol, Runtime supervisor/read APIs | Inspect, steer, detach, reconnect, and see pending/unsupported controls honestly | Batches 1–3 plus a compatible published cohort. Same work IDs and outcomes through TUI and non-TUI consumer | No supervisor-private-file parsing or simulated pause |
| **5 — Hosted application in agent-dev-container, with Braid UI** | Runtime activation transition/reconcile ports; existing canonical diffs and Braid save/recovery behavior | Reviewed root revision survives interruption and affects future admissions only | Batch 4. Atomic baseline comparison, duplicate activation, expired authority, withdrawal, and rollback tests | Defer autonomous behavioral revision and invented improvement scores |
| **6 — Braid consumer proof, upstream fixes at their owners** | The assembled contracts above | First defensible durable-root claim | Pass the real cloud scenario below; record exact builds, receipts, faults, and gaps | Defer larger fleets until this passes |

The hosted active-profile binding is a **missing application integration**, not something supplied merely by `executeAgentImprovementActivation`. Runtime explicitly leaves the atomic write to its caller.

Also reject `pursuit-versions.ts` as the default personal-evolution engine. It implements a particular [incumbent hill-climbing strategy](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/durable/pursuit-versions.ts#L1-L10). Its unknown-cost floors and empirical reservation fallback do not establish a lifetime hard spending limit. Research strategies belong in selected profiles and run artifacts.

## 5. First-slice acceptance and failure injection

### Useful prototype versus production promise

For the prototype, give two interactions the same seed profile and a frozen document bundle containing a stale instruction and a contradiction. One user wants an onboarding checklist; another wants help deciding whether to undertake the project. Permit a useful child profile or deterministic extraction program. Require traceable claims and a justified revision proposal. Include a case that ends with clarification or listening and creates no objective.

That answers whether the profile can express useful methods. It proves no autonomous improvement or cloud durability.

For the production slice, use the checklist task with **two real cloud children and one bounded grandchild**. Disconnect Braid; finish one child; pause root admission; restart the coordinator; resume; revise the objective; cancel a subtree; reconnect from Braid and a non-TUI consumer.

Pass only if identities remain stable, every effect and unresolved descendant is accounted for, a deliberately bad artifact is rejected, accepted work uses the correct criteria version, and profile activation changes only future admissions. Record the maximum observed recovery delay, backlog, cancellation delay, and accounting uncertainty. The supplied packet’s failed advice authorization attempt contributes no recommendation-quality evidence.

### Compact deterministic fault matrix

| Injected failure | Required externally observable state |
|---|---|
| Crash immediately before/after child admission acknowledgement | One original child or explicit unresolved admission; same operation key; no replacement until reconciliation. |
| Root offline; result committed; crash before wake; duplicate delivery | Outcome remains discoverable. One committed continuation decision for that event, even if transport delivery repeats. |
| Two recovering coordinators; user steering and child completion race | One current owner; stale dispatch refused. Accepted steering remains effective; obsolete results cannot overwrite it. |
| Crash around profile activation | Old or new active binding with a reconcilable operation; no implicit approval, duplicate activation, or altered historical receipt. |
| Cancelled parent with live descendants; concurrent grandchild creation | Future admission fenced. Each descendant is terminated, pending, unsupported, or unknown. Reservations remain accountable. |
| Unavailable native continuation | Explicit unavailable state or approved fresh-session transfer; no claimed native resume. |
| Missing/late costs | Usage remains unknown; configured resource enforcement blocks unsafe further admission. No zero-cost substitution or double-counted rollup. |
| Stale skill/resource or expired preparation receipt | Refuse execution or create a new preparation requiring applicable authorization; never silently fetch replacement bytes under the old receipt. |
| Withdrawn preference | Future retrieval and derived guidance exclude it; queued proposals invalidate. Active sessions are steered/stopped where supported, with limitations visible. |
| Successful child exit, failed independent checker | Artifact delivered but rejected; objective incomplete; repair consumes the existing allowance. |
| Expired checkpoint or lost sandbox | Report captured state, missing resources, and later effects. No implied rollback of the external world. |

Use fake providers for exhaustive interleavings, then real providers for control, continuation, and cloud-consumer semantics. Neither test class substitutes for the other.

## 6. Five expensive mistakes, ranked

1. **Creating competing coordinators.** A Braid root loop, Runtime manager, native goal, and Platform workflow cannot all decide the next action for the same scope. Delete duplicate planning, completion, and retry ownership.

2. **Advertising durability from retained evidence.** A saved transcript or journal does not prove crash-safe wake consumption, external-effect deduplication, or cancellation. Build the admission/wake/fencing proof before fleet scale.

3. **Letting self-revision rewrite authority, memory, or success.** Keep private knowledge scoped, acceptance criteria frozen, and activation outside writable profile policy. Build reviewed canonical diffs first; defer autonomous evolution.

4. **Flattening native semantics into a lowest-common-denominator graph.** Preserve native goals, workflow scripts, prompt privileges, sessions, and child controls. A canonical profile is portable intent, not evidence that every backend can execute every field equivalently.

5. **Building routing and optimization before proving marginal value.** Better native harnesses may remove much of the routing opportunity. The revised coordination study finds benefits and severe regressions depending on task structure; its architecture-selection results do not establish a universal router. Keep comparisons matched to actual tasks and budgets. 

The smallest things to build now are the bounded profile/artifact prototype, exact capability evidence, and one durable child-to-root continuation through existing owners. Explicitly defer universal role systems, a new profile language, global research policies, fleet-scale demonstrations, and automatic capability acquisition without maintenance and verification costs.

## Strongest objections to this recommendation

1. **The integration may cost more than its benefit.** Even existing Runtime/Platform components introduce operational coupling. A strong native workflow may satisfy most users more simply.

2. **Platform’s workflow-shaped waits may be the wrong abstraction for an open-ended root.** If integration requires encoding the agent’s strategy into a second workflow model, the recommended composition has crossed its own architectural boundary.

3. **Strict portability may suppress the best native behavior.** Exact profile materialization and uniform accounting may lag native extensions, goals, or session features. The team must accept explicit capability differences rather than quietly weakening them.

**Next experiment:** implement the smallest authorized consumer of the existing owner contracts: one exact-profile root, one real cloud child, and one independently checked artifact. Kill the coordinator after the child result is durable but before wake delivery; restart two contenders and inject the same outcome twice. Require one child, one committed continuation, stable profile/artifact/checker identities, and conserved allowance. If that cannot be achieved without another coordinator or policy interpreter, revise the architecture before building the broader lifecycle.

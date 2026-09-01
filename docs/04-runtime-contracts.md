# Runtime contracts

## Purpose

This document separates capabilities available in Braid's installed packages from actions that remain unavailable.

Braid must not turn a type declaration, capability flag, or planned method into a product claim without a real Braid flow proving it.

When a current package blocks a real Braid flow, Braid records the unavailable action, preserves the rest of the product, and files an upstream issue with the exact reproduction.

## Evidence baseline

The following published versions were resolved in this worktree, and their installed manifests, declarations, and implementations were inspected directly on 2026-09-01.

| Package | Installed version | Braid boundary |
| --- | ---: | --- |
| [`@tangle-network/agent-interface`](https://github.com/tangle-network/agent-sdk/tree/main/packages/agent-interface) | `2.0.0` | Canonical profile, capabilities, environment, stream, portable context, native continuation, interaction, and explicitly based workspace contracts |
| [`@tangle-network/agent-runtime`](https://github.com/tangle-network/agent-runtime) | `0.185.2` | Sole execution layer; exact executor, retained-run, interactive-run, environment-provider, and terminal-monitor exports |
| [`@tangle-network/agent-eval`](https://github.com/tangle-network/agent-eval) | `0.171.0` | Run records, judges, trace analysts, comparisons, and feedback trajectories |
| `@tangle-network/agent-provider-cli-bridge` | `1.0.0` | CLI Bridge environment adapter with capability discovery, native retained sessions, bounded terminal results, live streaming, replay, retry-safe turns, retained control, durable interaction response, explicit cancel, and host cwd support |
| `@tangle-network/agent-provider-tangle` | `1.0.2` | Tangle environment adapter over Sandbox, including deployment-gated retained control, interaction response, repository-relative cwd support, workspace branching, and interactive-agent operations |
| `@tangle-network/sandbox` | `0.36.1` | Tangle cloud client used by the provider, including keyed checkpoint/fork and interactive-agent operations |

The effective local Runtime installation resolves `agent-eval >=0.171.0 <0.172.0`, `agent-interface 2.0.0`, and `sandbox >=0.36.1 <0.37.0` through the exact workspace lockfile.

Published Runtime `0.185.2` declares `agent-interface ^2.0.0`, `agent-eval >=0.171.0 <0.172.0`, and `sandbox >=0.36.1 <0.37.0`.

The published Runtime compatibility rerelease now matches Braid's Interface and provider dependency contracts.

The Runtime compatibility blocker is resolved by `0.185.2`; remaining release requirements stay defined by `docs/08-verification.md` and `docs/09-delivery-plan.md`.

The installed Tangle provider publishes `sandbox >=0.34.6 <1.0.0` as a peer range.

Sandbox `0.36.1` publishes peers `@mastra/core ^1.36.0`, `@modelcontextprotocol/sdk ^1.30.0`, `ai ^6.0.175`, `openai ^6.36.0`, and `viem ^2.0.0`.

Braid exercises the exact dependency cohort in the table above through the workspace lockfile.

This cohort is a peer-compatible public package set; release acceptance still requires the checks in `docs/08-verification.md`.

The lockfile pins the registry integrity for every installed package.

`pnpm peers check` reports no peer dependency issues for this installed set.

`pnpm outdated --format json` returns `{}` for this worktree.

The workspace overrides pin Interface `2.0.0` and Knowledge `11.0.0`, keeping the public Runtime peer ranges compatible with Braid's dependency graph.

Historical snapshot: [Agent-runtime issue 803](https://github.com/tangle-network/agent-runtime/issues/803) records the interface peer mismatch fixed in Runtime `0.132.11`.

Historical snapshot: [Agent-runtime issue 737](https://github.com/tangle-network/agent-runtime/issues/737) records the Sandbox peer mismatch fixed in Runtime `0.132.11`.

Braid imports only the canonical root `agent-interface` entry point behind two local modules.

An exact parity test compares every local export with the root package export and rejects path escapes.

[Agent-sdk issue 135](https://github.com/tangle-network/agent-sdk/issues/135) requests supported narrow entry points to remove the root import cost.

### Installed package boundary

Braid composes the current provider packages through `agent-runtime` and keeps all provider-specific construction in adapters.

The CLI Bridge and Tangle providers remain transport implementations rather than alternate application shells.

The installed Interface carries requested interactions, portable context transfer, and native continuation on `AgentTurnInput`.

The map is not a capability declaration.

Braid derives it only after exact per-run environment capabilities are admitted, and sends an explicit empty map when response idempotency is absent or unknown.

The installed Runtime projects the interaction map into Sandbox prompt options.
The installed Tangle provider preserves the map through retained dispatch.

The Tangle provider exposes response operations only when the deployment reports `interactions.responseDedupe`; Braid still requires that per-run capability and a real deployment check.

At implementation start and before every release, rerun `pnpm outdated --format json` and inspect the installed manifests and declarations because these packages change frequently.

## Existing canonical profile contract

`AgentProfile` is Braid's complete agent configuration object.

It currently covers identity, version and tags, system prompt and instructions, default and small models, provider and reasoning effort, optional harness preference, permissions, tools, MCP servers, Hub connections and capabilities, subagents, files, tools, skills, agents, commands, instructions, hooks, modes, confidentiality, metadata, and extensions.

The inspected interface also defines tagged `AgentProfilePublicConfigValue`, opaque `AgentProfileSecretRef`, and the private `AgentProfileSecretProvider` resolution port for secret-capable configuration fields.

Braid stores and hashes the public reference key, while only the prepared private executor may resolve its value after profile identity is fixed.

Braid must preserve unknown extension fields and must not create a reduced copy that loses canonical dimensions.

The current harness set includes Claude Code, Nanoclaw, Codex, OpenCode, Kimi Code, Pi, Gemini, Hermes, OpenClaw, Amp, Factory Droids, Forge, Cursor, ACP, and CLI Base.

This list is descriptive evidence, not a Braid compatibility table.

Braid must call the current canonical helpers for all compatibility decisions.

- `harnessSupportsModel`
- `preferredHarnessForModel`
- `snapModelToHarness`
- `snapHarnessToModel`
- `reasoningEffortsFor`
- `harnessHonorsModel`
- `harnessHonorsEffort`
- `harnessHonorsSelectors`

If helper names change in a compatible release, Braid changes its adapter rather than pinning stale behavior in product code.

## Existing interaction contract

`agent-interface` defines a generalized `InteractionRequest` and `InteractionResponse`.

The request envelope has a stable identifier, open interaction kind, prompt, optional subject, answer specification, defaults, timeout behavior, and allowed response shape.

Known kinds include question, permission, and plan, but the kind is open for extension.

The answer specification supports text, number, boolean, select, and secret values.

Permission responses support once, session, persistent allow, and deny outcomes where offered.

The canonical stream includes `interaction`, `interaction.cancel`, and `plan.submitted` events in addition to message-part, status, warning, raw, and session updates.

`SdkProviderAdapter`, `AgentEnvironment`, and `AgentSession` have optional typed interaction-response methods.

Therefore the existence of interaction types or methods does not prove that a Braid user can answer a waiting run; the effective capability and a real flow remain required.

## Existing environment-provider contract

An `AgentEnvironmentProvider` reports profile, streaming, session, workspace, branching, placement, usage, and confidentiality capabilities.

An environment can stream or dispatch turns, expose provider sessions, read and write, execute commands, checkpoint, fork, report placement, refresh, and destroy when its adapter implements those operations.

An `AgentSession` can report status, replay events, return a result, accept a new prompt, and cancel when implemented.

Capabilities are the only supported source for Braid feature availability.

Method presence remains a second defensive check because a false capability must fail visibly rather than throw from a hidden action.

## Existing runtime contract

`streamAgentTurn` accepts only a Runtime-owned executor paired with one exact `AgentProfile`.

Historical snapshot: its published `0.135.0` API did not accept a per-turn interaction posture.

Braid therefore does not claim interaction delivery for the ephemeral `AgentRuntimeExecutionPort` path.

It normalizes the terminal result into `RuntimeStreamEvent` and guarantees one final event.

The current runtime event union includes lifecycle, text delta, reasoning delta, tool call, tool result, LLM call, artifact, proposal, error, and final events.

It does not currently preserve every canonical interface event, including generalized interaction and interaction-cancel events.

Braid creates Runtime's Bridge, Router, or sandbox executor only after durable run admission.

Runtime validates the exact profile, materialization evidence, execution binding, usage, and terminal result.

The durable receipt stores a redacted profile snapshot and the canonical digest of the exact private profile.

A metadata-only profile change invalidates admission reuse and provider-session continuation.

After restart, Braid keeps the reloaded exact profile only when its exact digest matches durable selection state.

Braid preserves Runtime's aggregate token record, including its optional prompt-cache counters and explicit unknown markers.

A known prompt-cache split must contain all three counters and sum to total input tokens.

A partial or inconsistent positive-input split must set `cacheBreakdownKnown: false`.

Braid rejects unknown fields and inconsistent totals under token-bearing record names.

Historical snapshot: Runtime `0.132.12` buffered executor output until the executor settled.

Braid therefore receives terminal text, tool calls, usage, and result evidence but cannot render provider text deltas live through this path.

[Agent-runtime issue 762](https://github.com/tangle-network/agent-runtime/issues/762) tracks incremental executor events.

The Runtime provider executor currently lacks the terminal materialization evidence required by exact execution.

[Agent-runtime issue 761](https://github.com/tangle-network/agent-runtime/issues/761) tracks that failure.

Braid does not bypass exact execution.

Its Tangle sandbox adapter converts the environment provider to Runtime's sandbox client, then uses the Runtime sandbox executor.

The provider and remote environment remain lazy until execution starts after durable admission.

### Current Braid cancellation path

`PreparedExecution.cancellation` enables Braid cancellation for the ephemeral Runtime executor path.

Retained CLI Bridge, retained Tangle, and native interactive-agent runs use their exact retained control handle when the effective run capabilities advertise cancellation.

The capability is a typed Runtime-executor tag, not a provider-specific callback or a UI branch.

`AgentRuntimeExecutionPort` wraps the Runtime `AgentTurnBackend.factory` only to retain the executor that Runtime creates for that run.

When the tag is present, `/cancel` calls Runtime `Executor.cancel` with the stable operation identifier, reason, and caller signal.

Braid accepts cancellation only when Runtime reports the `cancelled` effect.

An accepted Runtime request becomes `accepted` only with that terminal effect.

Another Runtime status with the `cancelled` effect becomes `already-applied`.

An explicit refusal remains `rejected`.

`cancel_requested`, `not_live`, `unknown`, a missing method, a thrown error, or a deadline remains `unknown`.

Braid may abort its local iterator after an accepted or unknown result to release local resources, but local abort never proves provider cancellation.

Runtime `Executor.teardown` remains a cleanup operation.

Its `destroyed` result never becomes a cancellation acknowledgement.

The direct Tangle inference adapter uses Runtime's Router executor cancellation operation.

The Router API has no remote cancellation operation, so Runtime aborts the local request and returns `unknown` with `cancel_requested`.

Braid preserves that unknown result and warns that remote work can continue or incur cost.

The CLI Bridge and retained Tangle production adapters supply cancellation through their exact retained control paths.

The ephemeral Tangle sandbox adapter omits the cancellation tag.

Its turn path does not receive the exact remote execution reference required for cancellation.

Braid therefore reports that path as unsupported instead of treating environment destruction or local stream closure as provider cancellation.

### Runtime cancellation contract

Runtime `0.185.2` publishes the following provider-neutral operation:

```ts
cancel(request: {
  operationId: string
  reason?: string
  signal?: AbortSignal
}): Promise<{
  status: 'accepted' | 'rejected' | 'already-terminal' | 'unknown'
  effect: 'cancel_requested' | 'cancelled' | 'not_live' | 'unknown'
  observedAt: string
  detail?: string
  evidence?: unknown
}>
```

`test/run-admission-architecture.test.ts` uses the real Runtime Router executor and proves that its local abort remains unknown.

### Live root handle

`createRootHandle` returns an in-process `SteerableRootHandle` with tree view, raw delivery, signal, and abort operations while it is bound to one live supervised run.

The handle fails loudly before binding and after release, which is correct for an in-process capability.

`RootSignal` includes pause, resume, cancel, and ask.

The current signal sink acts only on cancel; pause, resume, and ask are accepted for observation but have no runtime behavior.

Braid must not advertise pause, resume, or ask as runtime controls until each signal has an acknowledged effect contract.

Raw `deliver` can support live steering only after a typed runtime adapter defines the accepted message and acknowledgement.

### Runtime supervisor interface

The published runtime exports an experimental `@tangle-network/agent-runtime/tui` module and an `agent-runtime-top` binary.

The module owns snapshot loading and presentation types for runtime supervisor state, including workers, spend, tokens, latency, and logs.

That read model belongs in runtime because the on-disk layout is runtime-owned.

Braid adapts `loadTopSnapshot` into its own worker view, but it does not copy the runtime file layout or embed the separate terminal application.

The runtime kernel exports `writeWorkerSteer` for worker inbox delivery.

Braid supplies a stable operation identifier.

Runtime replays the same request body and rejects a different body for the same identifier.

An explicit parent reference stays visible when no worker resolves it, and Braid does not create a replacement supervisor edge.

The snapshot has no Braid run identifier, so Braid does not infer a run binding from snapshot order, current selection, or time.

The snapshot reports completeness and bounded diagnostics for unreadable or partial sources.

The runtime kernel exports `cancelWorker` and `cancelRun` as idempotent cancellation operations.

Braid supplies the runtime state directory, exact runtime target, and caller operation identifier.

An `unknown` effect means the request awaits acknowledgement and never becomes local success.

Runtime stores each worker's exact interactive binding outside its presentation snapshot.

Braid passes the supervisor state directory, exact worker identifier, and selected provider source to Runtime `attachWorker`.

Runtime reconstructs the retained process and returns an opaque handle or a named unavailable reason.

Braid never persists the provider reference or reads Runtime files directly.

The shared stream has no stable provider-native child-task lifecycle.

[agent-runtime issue 756](https://github.com/tangle-network/agent-runtime/issues/756) tracks the normalized identity and replay contract.

## Existing CLI Bridge server contract

CLI Bridge accepts OpenAI-compatible `POST /v1/chat/completions` requests with model identifiers shaped as `<runner>/<model>`.

Braid strips the leading runner from discovered catalog routes before creating an `AgentProfile`, then restores it only in the CLI Bridge adapter so the profile retains a portable provider/model identifier.

Requests can include an inline `agent_profile`, reasoning effort, session identifier, caller run identifier, working directory, execution placement, metadata, and MCP configuration according to the backend path.

The bridge owns exact runner-specific profile materialization and returns a receipt with digest, generated files, and unsupported dimensions.

Pi materialization uses native flags and disables ambient profile discovery so the submitted profile remains exact.

A caller-supplied run identifier is idempotent and bound to the original request identity.

The server retains durable run state in memory, emits SSE identifiers, accepts `Last-Event-ID`, supports `GET /v1/runs/:id?wait_ms=…`, and supports explicit `POST /v1/runs/:id/cancel`.

A network disconnect detaches the server run, while explicit cancellation changes it toward a terminal cancellation result.

Braid does not impose a hidden wall-clock limit on an interactive turn; user cancellation and explicitly configured provider limits are the only normal duration controls.

The current run registry is process-memory state, so a bridge restart may produce `404` for a formerly running identifier.

That result means unknown, not stopped.

The bridge's proposed `SessionRunner` design correctly seeks native bidirectional runner channels and session event replay, but its proposed `BridgeEvent` union lacks generalized interactions and would create another event vocabulary if implemented unchanged.

The implementation should evolve that design to emit or losslessly map canonical `agent-interface` events.

### Current backend blockers

The ACP backend currently answers `session/request_permission` by selecting the first offered option automatically.

The ACP backend currently emits message text but intentionally skips thought, plan, and tool chunks.

The OpenCode headless configuration currently defaults external directory, shell, edit, read, write, web fetch, task, plan entry, plan exit, and question permissions to allow unless the submitted profile overrides them.

Print-mode runners cannot stop and ask a Braid user unless they are replaced or supplemented by a native bidirectional session channel.

These behaviors may be suitable for isolated benchmark automation under an explicit policy, but they are blockers for an interactive product default.

## Existing CLI Bridge provider contract

The installed CLI Bridge provider resolves the bridge model from a turn override, provider default, or profile harness and model.

It sends stable `executionId` values as bridge run identifiers when they satisfy the bridge identifier rules.

It sends a prior event cursor as `Last-Event-ID` and maps SSE frames to canonical environment events.

It reports live streaming, replay, detach, turn idempotency, session continuation, and exact retained-run control.

It reports no session listing, session messages, workspace operations, checkpoint, fork, or confidentiality.

Its retained environment path dispatches detached turns and reconstructs control from the exact run reference.

Stopping a retained stream reader detaches the reader without cancelling the bridge run.

Explicit exact cancellation remains separate from reader detach and binds to the server-issued request digest.

Its public turn type accepts requested interactions through Interface, and its retained turn body carries them to the Bridge.

It reads the exact capability document for one model route from `GET /v1/capabilities?model=…` before it admits a run.

Its Pi route publishes native retained sessions and permission interactions; every other route publishes the durable one-shot run contract without them.

It answers an interaction through `POST /v1/runs/:runId/interactions/:interactionId/respond` on the retained environment and session, and advertises `interactions.responseIdempotency` for the routes that record every acknowledgement.

The Braid retained CLI Bridge boundary test catches an interaction posture the route never advertised.

## Existing Tangle provider contract

The installed Tangle provider wraps Sandbox as an `AgentEnvironmentProvider`.

Its default document is an upper bound, not a claim about one client or deployment.

Its provider-level surface includes deployment-gated retained control, interaction response, workspace branching, and interactive-agent operations.

The composed environment narrows those claims against the concrete Sandbox client and deployment capability document.

The provider accepts an explicit capability declaration and narrows it against the concrete client and environment methods.

Braid does not inject positive retained capabilities into the provider.

It requires client `get`, exact control, replay, detach, turn idempotency, retry-safe cancellation, and provider-backed dispatch lookup.

The provider-level report alone does not satisfy that requirement; Braid also requires per-environment capability evidence and live deployment proof.

The adapter exposes environment stream and dispatch, provider sessions, workspace methods, refresh, and destroy only when the sandbox instance implements them.

It requires an inline profile rather than a profile reference.

It narrows its declared interaction kinds to the backend catalog the Sandbox client serves, and answers an interaction through the session when the deployment records its own response.

The Braid retained Tangle adapter supplies the requested map to Runtime's retained turn input.

The provider exposes workspace branching only when Sandbox supplies keyed checkpoint and fork operations, operation lookup, inventory recovery, and explicit cleanup.

The provider exposes an interactive agent only when the deployment reports the exact native-TUI fact and the linked SDK supplies all required start, status, attach, reattach, control, prompt, input, resize, and stop operations.

Braid maps that surface to Runtime's retained interactive handle and records `surface: interactive-agent` without creating a second Sandbox during admission.

The provider rejects `contextTransfer` and `nativeContinuation` until Sandbox supplies native support for those operations.

Historical snapshot: Runtime `0.135.0` dropped that field in its retained-turn copier before the Tangle provider received it. Runtime `0.143.0` preserves it.

The Braid retained Tangle boundary test catches this loss at the provider dispatch boundary.

Its capability claims must still be proven against a real current Tangle deployment because a TypeScript adapter cannot prove server support or deployment policy.

## Current usage and execution observation contract

Braid preserves each Runtime `llm_call` and the terminal cumulative usage.

It records input, output, reasoning, prompt-cache values, reported cost, estimated cost, model, model-call count, and model-call latency when present.

Each token and cost total retains complete, observed-minimum, estimated, or unknown status.

An incomplete cost record keeps its observed minimum and its separate estimate when both exist.

Conversation usage has three independent groups: direct turns, trace analyses, and explicitly bound Runtime worker trees.

Braid does not add those groups together until Runtime provides stable model-call identity across them.

The current Runtime supervisor TUI snapshot omits completeness flags and several usage dimensions.

Braid therefore labels every supervisor and worker total from that surface as an observed minimum.

Braid records one secret-free execution environment for CLI Bridge, direct Tangle inference, and Tangle sandbox paths.

CLI Bridge records the configured endpoint location, retained provider session policy, and unavailable subscription quota.

Direct inference records the service endpoint host and unavailable Router account spend.

Tangle sandbox records provider sandbox identity, lifecycle, cleanup, continuity, requested resources, public endpoint host, placement, cgroup CPU and RAM use, GPU lease billing, and sandbox account usage when available.

New Tangle sandbox connections default to ephemeral lifecycle.

That path deletes its environment after one turn and rejects session continuation.

An explicit retained lifecycle requires an idle limit from 60 through 604,800 seconds.

The resolver rejects retained execution before resource creation unless exact control and dispatch lookup are both available.

The retained adapter composes Runtime `startRetainedRun`, `reconnectRetainedRun`, and exact native cancellation after that check passes.

Its saved control reference contains provider, environment, session, execution, provider run, and request-digest identity.

Headless run state exposes that secret-free reference so a fresh controller can inspect the exact recovered execution without replaying old events.

Headless native-context follow-up turns remain disabled because the current provider rejects `nativeContinuation` until Sandbox supplies a matching context boundary.

Native interactive-agent turns support follow-up prompts through the retained TUI session when the exact interactive-agent capability is present.

An ambiguous retained start failure does not destroy its environment because an idempotent create can return a pre-existing workspace.

Safe compensation requires a provider-issued receipt that distinguishes a new create from an idempotent replay.

Retained headless Tangle runs may request an answer when the effective environment advertises the interaction kind and response operation.

Braid binds that response to the exact runtime run, provider session, interaction, and operation identifiers.

The ephemeral Tangle path and the native interactive-agent path do not expose the generic Braid interaction-response operation, so Braid reports it as unsupported instead of auto-answering.

Braid displays a resumable interaction only after the provider exposes a durable response operation and the deployment reports response deduplication.

Braid does not admit retained Tangle execution without lookup for the crash window before its exact reference commits.

The local retained test proves that lookup recovers and cancels a run after a simulated process loss in that window.

The observation record never contains API keys, bearer tokens, SSH credentials, secret values, credential-bearing URLs, Docker host strings, or internal listener addresses.

The following historical upstream issues motivated these shared contracts; current package support does not replace live deployment proof:

- [Runtime issue 799](https://github.com/tangle-network/agent-runtime/issues/799) requires a creation receipt and exact cleanup when retained dispatch fails.
- [Runtime issue 800](https://github.com/tangle-network/agent-runtime/issues/800) requires crash-safe exact run admission or deterministic discovery.
- [Agent SDK issue 146](https://github.com/tangle-network/agent-sdk/issues/146) requires retained Tangle control, recovery, interactions, and workspace branching.
- [Sandbox issue 5249](https://github.com/tangle-network/agent-dev-container/issues/5249) requires a missing completed turn to return a cache miss instead of throwing.
- [Sandbox issue 5251](https://github.com/tangle-network/agent-dev-container/issues/5251) requires the exact retained-run revision to reach staging and production.
- [Sandbox issue 5277](https://github.com/tangle-network/agent-dev-container/issues/5277) requires valid Sandbox keys to authorize internal model-key provisioning.
- [Sandbox issue 5278](https://github.com/tangle-network/agent-dev-container/issues/5278) requires the npm `latest` tag to satisfy current Runtime peers.
- [Runtime issue 808](https://github.com/tangle-network/agent-runtime/issues/808) requires permanent provisioning rejections to fail without the ten-minute retry.

- [Runtime issue 763](https://github.com/tangle-network/agent-runtime/issues/763) requests one stable execution tree with complete usage provenance.
- [Agent SDK issue 136](https://github.com/tangle-network/agent-sdk/issues/136) requests normalized provider observations and account usage.
- [Sandbox issue 5076](https://github.com/tangle-network/agent-dev-container/issues/5076) requests resolved placement, effective resources, and per-sandbox billing.

The current published cohort carries the interaction response contract through the shared types and provider adapters, while Braid still gates each action on effective deployment capabilities.

- Interface publishes the interaction, checkpoint/fork, and interactive-agent contracts.
- Runtime preserves `AgentTurnInput.interactions` and projects it into Sandbox prompt options.
- CLI Bridge forwards the requested map and implements the durable response operation ([Agent SDK issue 204](https://github.com/tangle-network/agent-sdk/issues/204)).
- The Tangle provider narrows interaction kinds to the deployment catalog and exposes keyed workspace branching and interactive-agent operations when their deployment flags and methods are present.

Braid does not cast around these gaps or duplicate provider dispatch.

## Existing `agent-eval` contract

`defineAgentEval` records the scenario, agent, judge, execution result, evidence, score, and cost for each run.

Paired comparisons retain outcomes and costs across two frozen candidates.

`analyzeTraces`, `buildDefaultAnalystRegistry`, `runExact`, and `runExactStream` provide bounded trace-analysis workflows with exact citations, findings, cost, and latency.

The current DSPy RLM engine accepts a caller-owned model function, stable public call reference, and execution recorder instead of a provider URL or credential.
Braid invokes this engine through its bundled `uv` binary and an isolated managed Python 3.12 runtime.
The invocation pins `agent-eval-rpc[dspy]` to the installed `@tangle-network/agent-eval` version and fixes the dependency resolution cutoff.

If the managed runtime cannot resolve that exact cohort, Braid reports analysis as unavailable and does not use host Python packages.
Braid never sends model credentials to the managed Python process.
Braid gives each analyst invocation one explicit runtime transport attempt by default so its recorded usage and cost cannot hide additional paid retries.

Braid binds that function to the selected profile, connection, effective model, and runtime package version.

For direct inference, `agent-runtime` executes each canonical text-message request through `streamAgentTurn`.

For CLI Bridge, Braid uses Runtime's `startRetainedRun` with the selected provider and exact run identity.

Braid returns normalized output, measured token usage, priced cost, terminal status, and finite redacted execution evidence to `agent-eval`.

Historical snapshot: the callback rejected multimodal and request-level thinking controls because Runtime `0.132.12` did not expose those fields on that exact turn input.

Reasoning remains an `AgentProfile` setting, and unsupported callback shapes fail before a provider call rather than being silently dropped.

Default analysis can combine deterministic checks with failure-mode, knowledge-gap, knowledge-poisoning, and improvement analysts when an engine is configured.

`FeedbackTrajectory` can represent user approvals, rejections, edits, and selections as evaluation data.

Braid consumes these capabilities and does not reimplement trace parsing, analyst registries, judges, comparison records, or release records.

## Required shared target contract

The shared packages must expose one run-bound, replayable, bidirectional control path.

The exact exported names should match each repository's conventions, but the target semantics are normative.

```ts
interface RuntimeRunHandle {
  readonly runId: string
  readonly sessionId?: string
  events(options?: { after?: string; signal?: AbortSignal }): AsyncIterable<RuntimeEventEnvelope>
  status(options?: { waitMs?: number; signal?: AbortSignal }): Promise<RuntimeRunSnapshot | null>
  respondToInteraction(
    response: InteractionResponse,
    options: { operationId: string; signal?: AbortSignal },
  ): Promise<InteractionResponseAck>
  cancel(options: { operationId: string; reason?: string; signal?: AbortSignal }): Promise<RuntimeRunSnapshot>
}
```

A handle may be in-process or durable, but method behavior and terminal outcomes remain the same.

Durable implementations can be recreated from a persisted run reference after Braid restart.

An implementation that cannot detach or recreate a handle reports that through capabilities before admission.

### Runtime event envelope

```ts
interface RuntimeEventEnvelope {
  runId: string
  eventId: string
  sequence: number
  cursor?: string
  occurredAt?: string
  receivedAt: string
  event: RuntimeStreamEvent
}
```

`RuntimeStreamEvent` must preserve canonical message-part, interaction, interaction-cancel, plan, status, warning, raw, and session events in addition to its existing event types.

Stable event identity and sequence must survive replay and runtime adaptation.

A provider without a native event identifier receives a stable identifier from the durable layer that records the mapping before delivery.

### Environment and session interaction response

`AgentEnvironment` and `AgentSession` expose optional typed interaction-response operations bound to a stable execution or session reference.

The operation accepts canonical `InteractionResponse`, caller operation identifier, and cancellation signal.

The operation binds the request by runtime run, provider session when present, and interaction identifier; the interaction identifier is not treated as globally unique.

The acknowledgement distinguishes accepted, already resolved with the same response, already resolved differently, expired, cancelled, unknown interaction, unknown run, and transport failure.

Response retry with the same operation identifier is idempotent.

An interaction capability object must report supported kinds, answer specifications, response scopes, secret answers, concurrent requests, replay, and response idempotency.

### Portable conversation context

The installed environment turn input carries explicit `contextTransfer` and `nativeContinuation` requests in addition to a native session identifier.

The shared interface defines portable conversation context built from existing canonical message and part types, with source boundary, completeness, digest, and selected attachments.

Runtime start or resume must distinguish native same-session continuation from fresh-session context transfer.

Context transfer is split into a side-effect-free planning operation and an execution operation.

The plan names every included message, transformed part, omitted part, token estimate when available, destination runner, and a digest over the complete proposed transfer.

Braid records explicit acceptance of that digest before destination dispatch whenever the plan contains a transformation or omission.

Execution accepts the approved plan digest, and the destination adapter returns a receipt that matches the digest and names the new provider session.

No adapter may flatten history into an untyped prompt without recording that transformation and obtaining explicit caller acceptance.

The runtime must expose context-size planning before dispatch or return a typed over-limit result that allows Braid to select a shorter boundary or cited summary.

Native continuation also needs a provider boundary token, revision, digest, or message listing that proves the provider session still ends at Braid's recorded boundary.

If a provider cannot prove that boundary, runtime must use a fresh-session context transfer instead of submitting a new turn into an unverified native session.

### Typed control

Runtime supervisor control needs typed `steer`, `cancel`, and watch operations addressable by stable supervisor and worker identifiers.

Each operation returns an acknowledgement with operation identifier, target, accepted state, and eventually observed effect or explicit unknown result.

In-process root handles may implement the same port, but durable clients cannot depend on a JavaScript object retained by the original process.

Pause, resume, and ask remain unavailable until their state transitions and effects are implemented and tested.

### Native terminal handoff target

Normalized execution remains Braid's default interaction path.

An attachable execution may also expose one Runtime-owned interactive terminal reference.

`/attach` must suspend Braid, connect the user to the exact existing process, forward input and resize, and restore the same Braid state after detach.

Attaching to an existing process and launching a new process that resumes logical context are different operations.

Braid must never label the second operation as attachment.

The same reference can identify an attachable Runtime worker or provider-native child only when Runtime reports a stable parent relation.

The shared interface exposes terminal input, output events, resize, detach, close, and exact control claims.

Runtime exposes retained interactive handles for Braid runs and exact supervised workers.

Braid owns only terminal presentation and restores its screen after detach or remote exit.

The Sandbox platform provides authenticated PTY transport and the current Tangle provider also exposes a deployment-gated native interactive-agent surface.

CLI Bridge currently provides logical session continuity without a retained terminal process.

[Agent SDK issue 138](https://github.com/tangle-network/agent-sdk/issues/138) owns the portable terminal-session contract.

[CLI Bridge issue 140](https://github.com/drewstone/cli-bridge/issues/140) owns retained local terminal processes.

Braid consumes the Runtime contract and contains no runner-specific attachment code.

## CLI Bridge target transport

The existing OpenAI-compatible one-shot route remains compatible for non-interactive clients.

Interactive Braid runs use the bridge's native bidirectional session work rather than attempting to answer through standard chat-completions fields.

The bridge needs one canonical event stream per run with live and `Last-Event-ID` replay.

The bridge needs an idempotent response operation bound to run identifier, interaction identifier, and Braid operation identifier.

The bridge needs typed input injection for steering and queued next-turn input, with separate semantics.

The bridge needs status, explicit cancel, session list, session messages, a context-boundary proof, and transcript routes consistent with the evolved `SessionRunner` design.

Native runner adapters translate their private bidirectional protocols to canonical message, reasoning, tool, plan, question, permission, status, usage, and terminal events.

No adapter may auto-answer an interactive request unless the submitted profile and explicit execution mode select a matching automation policy.

One-shot print mode remains available for non-interactive runs and reports interaction support as false.

The provider package maps the bridge surface into the shared environment and runtime run-handle contract and reports detach only after reattachment is proven.

## Tangle target transport

The installed Sandbox carries canonical interaction requests in its replayable event stream.
It accepts canonical responses bound to session, interaction, and operation identifiers when the deployment reports response deduplication.

The installed Tangle provider maps that operation into `AgentEnvironment`, `AgentSession`, and Runtime retained run control.

Cloud interaction responses must remain valid after Braid reconnect when the sandbox session is still waiting.

The installed Tangle provider exposes checkpoint and fork requests when the linked Sandbox surface is complete.
It binds caller idempotency keys to canonical request digests.

Retrying the same key and digest returns the original checkpoint or destination environment, while reusing a key with changed input returns a conflict.

The provider exposes lookup by idempotency key so restart can reconcile a remote success that occurred before Braid committed its reference.

Checkpoint and fork operations return immutable source and destination references and preserve placement and confidentiality metadata.

The provider exposes explicit checkpoint deletion and destination-environment destruction with terminal acknowledgement so recovered or failed operations can be cleaned up.

Environment cancellation and run cancellation remain distinct actions.

Destroying an environment requires a separate confirmation and cannot be an implementation of cancel run.

## Capability matrix Braid must derive

Braid builds the following view from live provider capabilities and method presence.

| Product action | Required shared capability |
| --- | --- |
| Live streaming | `streaming.live` and event stream |
| Reconnect | `streaming.replay`, stable cursor, and durable run reference |
| Detach on exit | `streaming.detach` and recreateable run handle |
| Retry-safe send | `streaming.turnIdempotency` |
| Continue native session | `sessions.continue` plus a matching provider context-boundary proof |
| Browse provider messages | `sessions.messages` |
| General question | interaction question kind and response operation |
| Permission approval | interaction permission kind, allowed response scope, and response operation |
| Plan review | interaction plan kind and response operation |
| Secret answer | secret answer support and non-persisting transport |
| Read or edit workspace | corresponding workspace methods |
| Conversation fork | Always available as a Braid transcript operation |
| Workspace fork | retry-safe checkpoint and fork methods, lookup by idempotency key, and explicit cleanup |
| Confidential run | confidential capability plus compatible profile and placement |
| Usage and cost | usage capability and normalized events |
| Supervisor steer | typed runtime worker control |
| Supervisor cancel | typed runtime cancellation with effect confirmation |

Capabilities are captured with every run because provider support may change between runs.

## Identifier and replay rules

A Braid conversation identifier never becomes a provider session identifier.

A Braid turn maps to exactly one admitted runtime run unless the user explicitly retries, in which case each attempt has a new run identifier and a retry edge.

The caller supplies stable execution and operation identifiers when shared contracts permit it.

A reconnect reuses the same runtime run identifier and provider binding.

A cross-runner handoff always creates a new provider session identifier.

A replay cursor advances only after Braid durably commits the associated event.

An SSE connection ending without a terminal event triggers status reconciliation and replay, not a locally invented terminal state.

Duplicate event identifiers produce no duplicate transcript part, tool row, usage total, interaction, or terminal result.

Terminal run status is immutable except for an explicit correction from unknown when external evidence becomes available.

## Version and release order

Shared changes land and publish in dependency order.

1. `agent-interface` publishes the interaction, portable-context, context-boundary, retry-safe checkpoint and fork, acknowledgement, and run-control-supporting types.
2. CLI Bridge and sandbox APIs implement canonical bidirectional interaction and event behavior.
3. CLI Bridge and Tangle provider packages publish adapters against the new interface version.
4. `agent-runtime` publishes event preservation, durable run control, and supervisor control against compatible interface, provider, and eval versions.
5. Braid updates to the published versions, runs contract and live smokes, and commits the exact lockfile.

Local workspace links are allowed for upstream development but cannot constitute Braid release proof.

The release manifest records package names, versions, integrity hashes, source commits, server versions, runner versions, and exact live-test commands.

## Upstream completion checks

| ID | Required proof |
| --- | --- |
| UP-01 | `agent-interface` contract tests validate interaction capability negotiation and every response acknowledgement outcome. |
| UP-02 | Environment and session interaction responses are idempotent by operation identifier and reject wrong run, session, or interaction bindings. |
| UP-03 | Runtime contract tests prove every canonical event kind survives adaptation with stable event ID, sequence, and replay cursor. |
| UP-04 | A runtime run handle can start, reconnect, report status, answer an interaction, and explicitly cancel through one public contract. |
| UP-05 | CLI Bridge native-session tests carry text, reasoning, tools, plan, question, permission, usage, and terminal events for every runner advertised as interactive. |
| UP-06 | CLI Bridge removes unconditional ACP and OpenCode auto-approval from interactive mode and proves explicit automation remains opt-in and profile-scoped. |
| UP-07 | CLI Bridge response retry returns the same acknowledgement for the same operation and a conflict for a different response after resolution. |
| UP-08 | The published CLI Bridge provider proves replay, detach, recreateable run control, interaction response, status, and terminal cancel against a real bridge server. |
| UP-09 | The published Tangle provider proves exact retained create, dispatch lookup, replay, interaction response, cancel retry, and cleanup against a real deployment. |
| UP-10 | Runtime supervisor tests prove watch, typed steer, and typed cancel effects in-process and after control-client reconnect; no production path relies on an unread request file. |
| UP-11 | Published shared package versions install together with no ignored peer mismatch and Braid's contract suite passes against tarballs rather than workspace links. |
| UP-12 | Capability conformance tests deliberately disable each capability and prove Braid does not expose or call the corresponding action. |
| UP-13 | Context planning is side-effect free; rejected transformations dispatch zero runs; an accepted digest produces one fresh provider session and an exact matching receipt; native continuation proceeds only with a matching provider boundary and sends no duplicate history. |
| UP-14 | Checkpoint and environment-fork retries are idempotent by key and request digest, survive process death before local commit through lookup, reject key conflicts, and expose confirmed cleanup against a real Tangle sandbox. |

No Braid work item that depends on an upstream check is complete until that check passes against the published artifact or the exact release candidate tarball that will be published.

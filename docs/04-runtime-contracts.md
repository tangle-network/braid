# Runtime contracts

## Purpose

This document separates capabilities available in Braid's installed packages from capabilities that must remain disabled.

Braid must not turn a type declaration, capability flag, or planned method into a product claim without a real Braid flow proving it.

When a current package blocks a real Braid flow, Braid records the unavailable action, preserves the rest of the product, and files an upstream issue with the exact reproduction.

## Evidence baseline

The following published versions were queried from npm and their installed declarations were inspected directly on 2026-08-04.

| Package | Installed version | Braid boundary |
| --- | ---: | --- |
| [`@tangle-network/agent-interface`](https://github.com/tangle-network/agent-sdk/tree/main/packages/agent-interface) | `0.43.0` | Canonical profile, capabilities, environment, stream, portable context, and interaction contracts |
| [`@tangle-network/agent-runtime`](https://github.com/tangle-network/agent-runtime) | `0.128.0` | Sole execution layer; public box, executor, chat, environment-provider, and terminal-monitor exports |
| [`@tangle-network/agent-eval`](https://github.com/tangle-network/agent-eval) | `0.144.1` | Run records, judges, trace analysts, comparisons, and feedback trajectories |
| `@tangle-network/agent-provider-cli-bridge` | `0.3.4` | CLI Bridge environment adapter with live streaming, replay, retry-safe turns, and explicit cancel |
| `@tangle-network/agent-provider-tangle` | `0.4.10` | Tangle environment adapter over the sandbox client |
| `@tangle-network/sandbox` | `0.18.0` | Tangle cloud client used by the provider |

The installed runtime publishes `agent-eval >=0.143.0 <0.144.0`, `agent-interface >=0.43.0 <0.44.0`, and optional `sandbox >=0.17.2 <0.18.0` as peer ranges.

Braid exercises runtime `0.128.0` with eval `0.144.1` and sandbox `0.18.0`, explicitly allows those tested combinations in pnpm, and tracks the stale runtime peer declarations in [agent-runtime issue 734](https://github.com/tangle-network/agent-runtime/issues/734) and [agent-runtime issue 737](https://github.com/tangle-network/agent-runtime/issues/737).

### Installed package boundary

Braid composes the current provider packages through `agent-runtime` and keeps all provider-specific construction in adapters.

The CLI Bridge and Tangle providers remain transport implementations rather than alternate application shells.

The current interface exposes optional interaction-response methods, but neither installed provider declaration exposes that operation and the runtime turn API does not add one.

Braid therefore renders interactions but disables response actions for those providers until a real run proves support.

At implementation start and before every release, rerun `npm view @tangle-network/<package> version` and inspect the installed declarations because these packages change frequently.

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

`SdkProviderAdapter` has an optional `respondToInteraction(response)` method.

The higher-level `AgentEnvironmentProvider` and `AgentSession` path does not currently expose an equivalent response method.

Therefore the existence of interaction types does not prove that a Braid user can answer a waiting CLI Bridge or Tangle run.

## Existing environment-provider contract

An `AgentEnvironmentProvider` reports profile, streaming, session, workspace, branching, placement, usage, and confidentiality capabilities.

An environment can stream or dispatch turns, expose provider sessions, read and write, execute commands, checkpoint, fork, report placement, refresh, and destroy when its adapter implements those operations.

An `AgentSession` can report status, replay events, return a result, accept a new prompt, and cancel when implemented.

Capabilities are the only supported source for Braid feature availability.

Method presence remains a second defensive check because a false capability must fail visibly rather than throw from a hidden action.

## Existing runtime contract

`streamAgentTurn` normalizes box, executor, and chat inputs into `RuntimeStreamEvent` and guarantees one final event.

The current runtime event union includes lifecycle, text delta, reasoning delta, tool call, tool result, LLM call, artifact, proposal, error, and final events.

It does not currently preserve every canonical interface event, including generalized interaction and interaction-cancel events.

`AgentExecutionBackend` currently exposes start, resume, stream, and stop but no interaction-response operation.

`resolveAgentBackend` can select router, Tangle cloud, and CLI Bridge execution paths, but backend selection alone does not guarantee provider sessions, replay, interactions, or workspace controls survive the abstraction.

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

Braid may adapt `loadTopSnapshot` into its own worker view, but it must not copy the runtime file layout or embed the separate terminal application.

The module does not export its write-side steer and cancellation operations as a reusable API, so Braid does not advertise those controls through this surface.

## Existing CLI Bridge server contract

CLI Bridge accepts OpenAI-compatible `POST /v1/chat/completions` requests with model identifiers shaped as `<runner>/<model>`.

Requests can include an inline `agent_profile`, reasoning effort, session identifier, caller run identifier, working directory, execution placement, metadata, and MCP configuration according to the backend path.

The bridge owns exact runner-specific profile materialization and returns a receipt with digest, generated files, and unsupported dimensions.

Pi materialization uses native flags and disables ambient profile discovery so the submitted profile remains exact.

A caller-supplied run identifier is idempotent and bound to the original request identity.

The server retains durable run state in memory, emits SSE identifiers, accepts `Last-Event-ID`, supports `GET /v1/runs/:id?wait_ms=…`, and supports explicit `POST /v1/runs/:id/cancel`.

A network disconnect detaches the server run, while explicit cancellation changes it toward a terminal cancellation result.

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

The published `@tangle-network/agent-provider-cli-bridge@0.3.4` resolves the bridge model from a turn override, provider default, or profile harness and model.

It sends stable `executionId` values as bridge run identifiers when they satisfy the bridge identifier rules.

It sends a prior event cursor as `Last-Event-ID` and maps SSE frames to canonical environment events.

It reports live streaming, replay, turn idempotency, and session continuation.

It reports no detach, session listing, session messages, workspace operations, checkpoint, fork, or confidentiality.

It explicitly rejects detached turns.

Stopping its stream consumer before drain cancels the active bridge run, and destroying its environment cancels tracked runs and waits for terminal cancellation.

This differs from the bridge server's disconnect-detach behavior and means Braid cannot obtain safe detach merely by using the current provider adapter.

It exposes no generalized interaction response.

## Existing Tangle provider contract

The published `@tangle-network/agent-provider-tangle@0.4.10` wraps `@tangle-network/sandbox` as an `AgentEnvironmentProvider`.

Its default capabilities report full canonical profile dimensions, live and replay streaming, detach, turn idempotency, session continuation, session list and messages, workspace read/write/exec/git/upload/download, checkpoint and fork, placement, usage, and confidentiality.

The adapter exposes environment stream and dispatch, provider sessions and event replay, session prompt and cancel, workspace methods, checkpoint, fork, placement, refresh, and destroy when the sandbox instance implements them.

It requires an inline profile rather than a profile reference.

It currently exposes no generalized interaction response through the environment or session adapter.

Its capability claims must still be proven against a real current Tangle deployment because a TypeScript adapter cannot prove server support or deployment policy.

## Existing `agent-eval` contract

`defineAgentEval` records the scenario, agent, judge, execution result, evidence, score, and cost for each run.

Paired comparisons retain outcomes and costs across two frozen candidates.

`analyzeTraces`, `buildDefaultAnalystRegistry`, `runExact`, and `runExactStream` provide bounded trace-analysis workflows with exact citations, findings, cost, and latency.

The current DSPy RLM engine accepts a caller-owned model function, stable public call reference, and execution recorder instead of a provider URL or credential.
Braid gives each analyst invocation one explicit runtime transport attempt by default so its recorded usage and cost cannot hide additional paid retries.

Braid binds that function to the selected profile, connection, effective model, and runtime package version.

`agent-runtime` executes each canonical text-message request through `runAgentTaskStream`; Braid returns normalized output, measured token usage, priced cost, terminal status, and finite redacted execution evidence to `agent-eval`.

The callback rejects multimodal and request-level thinking controls because runtime `0.128.0` does not expose those fields on its OpenAI-compatible backend.

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

`AgentEnvironment` and `AgentSession` need optional typed interaction-response operations bound to a stable execution or session reference.

The operation accepts canonical `InteractionResponse`, caller operation identifier, and cancellation signal.

The operation binds the request by runtime run, provider session when present, and interaction identifier; the interaction identifier is not treated as globally unique.

The acknowledgement distinguishes accepted, already resolved with the same response, already resolved differently, expired, cancelled, unknown interaction, unknown run, and transport failure.

Response retry with the same operation identifier is idempotent.

An interaction capability object must report supported kinds, answer specifications, response scopes, secret answers, concurrent requests, replay, and response idempotency.

### Portable conversation context

The current environment turn input can name a native session but cannot carry canonical prior messages into a fresh provider session.

The shared interface must add a portable conversation context built from existing canonical message and part types, with source boundary, completeness, digest, and selected attachments.

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

The sandbox session API must carry canonical interaction requests in its replayable event stream and accept canonical responses bound to session, interaction, and operation identifiers.

The Tangle provider maps that operation into `AgentSession` and runtime run control.

Cloud interaction responses must remain valid after Braid reconnect when the sandbox session is still waiting.

Checkpoint and fork requests require caller idempotency keys bound to canonical request digests.

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
| UP-09 | The published Tangle provider proves replayed interaction request, post-reconnect response, run cancel, checkpoint, and environment fork against a real sandbox deployment. |
| UP-10 | Runtime supervisor tests prove watch, typed steer, and typed cancel effects in-process and after control-client reconnect; no production path relies on an unread request file. |
| UP-11 | Published shared package versions install together with no ignored peer mismatch and Braid's contract suite passes against tarballs rather than workspace links. |
| UP-12 | Capability conformance tests deliberately disable each capability and prove Braid does not expose or call the corresponding action. |
| UP-13 | Context planning is side-effect free; rejected transformations dispatch zero runs; an accepted digest produces one fresh provider session and an exact matching receipt; native continuation proceeds only with a matching provider boundary and sends no duplicate history. |
| UP-14 | Checkpoint and environment-fork retries are idempotent by key and request digest, survive process death before local commit through lookup, reject key conflicts, and expose confirmed cleanup against a real Tangle sandbox. |

No Braid work item that depends on an upstream check is complete until that check passes against the published artifact or the exact release candidate tarball that will be published.

# Product contract

## Definition

Braid is the terminal home for a portable agent.

The user chooses an `AgentProfile`, chooses a connection and optional run overrides, and gets one consistent conversation experience across local runner subscriptions, Tangle inference, and Tangle cloud sandboxes.

The profile defines who the agent is.

The connection defines where requests go and which credentials are used.

The runner defines which coding program executes one run.

Braid defines how the user sees, directs, forks, analyzes, approves, and audits that work.

The `AgentProfile` is portable intent, while an admitted run stores an immutable receipt for the effective runner, model, reasoning effort, maximum output, connection, and execution environment.

Changing the selected profile for a future run never rewrites the receipt or identity of an existing run.

## The problem

Modern coding runners each ship their own terminal interface, session format, model selector, permission dialog, and fork semantics.

A user who moves from Pi to Codex or from a local subscription to a cloud sandbox must also move to a different product model and lose a coherent graph of the work.

Tangle already has the portable profile, execution runtime, local CLI bridge, cloud sandbox provider, inference route, and trace-analysis package needed to separate the interface from a runner.

The missing product is a fast, legible terminal client that composes those capabilities without hiding their differences.

## Product thesis

A runner-neutral terminal can be better than a runner's native terminal because it can make execution location, branching, analysis, worker activity, and permission policy explicit across every run.

Braid wins if changing the runner feels like changing a compiler target rather than changing the agent or abandoning the conversation.

## Users and jobs

### Individual developer

The developer wants to use existing Codex, Claude, Kimi, Pi, Gemini, OpenCode, Hermes, or other local subscriptions through CLI Bridge without learning a new terminal product for each one.

They need fast streaming, readable tools and reasoning, precise cancellation, profile and model selection, searchable history, and useful forks.

### Tangle cloud user

The cloud user wants the same profile and conversation experience in an isolated Tangle sandbox, with reconnect, workspace operations, checkpoints, environment forks, and placement visibility.

They need to know what persisted, what moved to the cloud, and the exact state a fork copied.

### Agent operator

The operator launches or supervises agents that may create worker trees.

They need live status, spend, tokens, latency, logs, steering, cancellation, and a graph connecting worker activity to the originating conversation.

### Agent researcher

The researcher wants to ask why a run failed, compare branches, retain cited findings, and turn approvals, rejections, corrections, and selections into evaluation data.

They need analyses to remain separate from the conversation they analyze unless explicitly promoted.

## User-visible objects

| Object | User meaning | Owner |
| --- | --- | --- |
| Profile | The portable definition of one agent | `agent-interface` contract; user or profile catalog content |
| Connection | Credentials and transport to local bridge, Tangle inference, or Tangle sandbox | Provider package plus Braid reference |
| Conversation | A durable user-visible graph of work | Braid |
| Branch | One path through a conversation | Braid, with optional provider or environment binding |
| Turn | One user input and resulting activity | Braid and runtime |
| Run | One idempotent execution admitted for a turn | `agent-runtime` and provider |
| Interaction | A question, permission, or plan awaiting a response | `agent-interface` contract and provider |
| Analysis | A cited review of a frozen run or branch | `agent-eval` and Braid graph |
| Environment | A local or cloud workspace | Provider |
| Supervisor tree | Runtime-owned parent and worker state | `agent-runtime` |

## Core journeys

### Use a local subscription

1. The user starts Braid in a project directory.
2. Braid discovers or prompts for a CLI Bridge connection.
3. The user selects an existing profile.
4. Braid shows the effective runner, model, reasoning effort, maximum output, connection, execution location, and any unsupported profile dimensions before sending.
5. CLI Bridge materializes the exact profile and starts the selected local runner.
6. Braid streams normalized events, records the materialization receipt, and reconnects from the last event identifier after a transport loss.
7. Explicit cancellation waits for a terminal cancellation result instead of treating a closed stream as success.

### Move the same profile to Tangle cloud

1. The user opens the connection picker and chooses a Tangle sandbox connection.
2. Braid validates the profile against reported cloud capabilities.
3. The user confirms workspace source, placement, resource policy, confidentiality, and estimated execution context.
4. The Tangle provider creates or resumes the environment and the runtime starts the run.
5. Braid can detach, reconnect, inspect the workspace, checkpoint it, and create an environment fork when capabilities permit.
6. The branch graph records which environment and checkpoint back each branch.

### Change runner without changing agent

1. The user opens the runner selector for the next turn or branch.
2. Braid asks canonical `agent-interface` helpers whether the profile's model and effort are honored by the selected runner.
3. Braid presents a valid snapped model or effort as an explicit proposed change rather than silently mutating the profile.
4. The run starts a new provider session with normalized conversation context when native resume is not portable.
5. The graph records the handoff and preserves the original profile snapshot and run receipts.

### Fork work honestly

1. The user selects a message or run node and invokes `/fork`.
2. Braid previews the exact transcript boundary, profile snapshot, runner override, provider-session behavior, and workspace behavior.
3. A conversation-only fork always creates a new Braid branch and provider session.
4. A workspace fork additionally checkpoints and forks the environment only when the provider reports both capabilities.
5. The resulting branch displays provenance back to the source node.

### Analyze a run without contaminating it

1. The user selects a run or branch and enters `/ask why did this fail?`.
2. Braid freezes the selected trace references, run metadata, profile digest, and branch boundary.
3. `agent-eval` runs the configured trace analyst in a separate analysis execution.
4. Braid creates a child analysis node with citations, findings, uncertainty, latency, token use, and cost.
5. The active branch remains unchanged until the user explicitly sends selected findings into it or forks from the analysis.

`/ask` is a free-form question over one frozen source.

`/analyze` selects a named `agent-eval` recipe such as failure, cost, tools, or improvement.

`/compare` freezes two sources, retains every measured asymmetry, and produces a paired result without choosing a branch winner automatically.

## Product principles

### Portable identity

The profile is the only object that defines the agent's prompt, instructions, models, tools, permissions, skills, commands, hooks, modes, resources, subagents, and metadata.

Braid stores profile references and immutable run snapshots but does not invent a reduced profile format.

### Honest capability differences

Braid shows a feature only when the active provider and runtime path can carry it correctly.

A disabled action explains the missing capability and, when possible, names a compatible connection.

Braid never simulates a workspace fork by changing a label or simulates an approval by auto-allowing it.

### Durable, explainable execution

The interface always distinguishes running, detached, reconnecting, cancelling, cancelled, completed, failed, expired, and unknown states.

An unknown provider run remains unknown until the provider proves a terminal outcome.

Every branch and analysis exposes its source, profile digest, runner, model, connection, run identifier, and relevant environment identifiers.

Activity also keeps direct turn usage, analysis usage, and runtime-worker usage separate, and labels values that the provider did not report as unknown.

### Fast default, full depth on demand

The default composer keeps profile, connection, runner, model, effort, branch, run state, and cost visible without occupying the transcript.

Advanced profile fields, event details, receipts, traces, and environment operations live behind focused overlays.

The first-run path asks only for the minimum configuration needed to complete a real turn.

### Safe interaction

Permission requests fail closed, identify their subject, show sanitized detail, and offer only scopes allowed by the shared request.

Automation is explicit, narrowly scoped, reviewable, revocable, and recorded.

### One behavior in every interface

The terminal, JSONL headless mode, and deterministic test driver use the same controllers, reducers, validation, persistence, and execution ports.

Headless mode is not a second implementation and the visual interface is not allowed to bypass the tested behavior.

## Required product scope

The first public release includes all of the following capabilities.

- Interactive full-screen terminal mode and scrollback-friendly inline mode.
- A JSONL headless control mode over the same application core.
- Profile discovery, import, validation, inspection, editing, selection, and immutable per-run snapshots.
- Connection setup for CLI Bridge, Tangle inference, and Tangle sandbox execution.
- Capability-aware runner, model, and reasoning-effort selection.
- Streaming text, reasoning, tools, results, usage, artifacts, proposals, warnings, errors, and terminal outcomes.
- Durable replay and reconnect with duplicate-event protection.
- Explicit cancellation that waits for a terminal provider result.
- General questions, permissions, plan review, timeout, cancellation, and queued concurrent interactions.
- Conversation creation, open, search, rename, archive, export, clone, branch, conversation fork, and environment fork.
- Cross-runner handoff with new provider-session identity and explicit context provenance.
- `/ask`, specialized trace analysis, cited child nodes, comparison, promotion of findings, and graph navigation.
- Runtime supervisor status, worker activity, logs, steering, and real cancellation through runtime-owned APIs.
- Separate activity and usage views for direct turns, trace analyses, and runtime workers.
- Queue and steer behavior while a run is active.
- Local persistence, crash recovery, migrations, data export, retention controls, and secret separation.
- Keyboard-only operation, responsive layouts, Unicode and IME support, no-color and high-contrast modes, sanitized untrusted output, and plain-text rendering.
- Deterministic, terminal, live-provider, visual, semantic, security, installation, and performance proof.

## Explicit non-goals

Braid does not implement an LLM agent loop, prompt compiler, profile materializer, provider-native event parser, cloud scheduler, model gateway, sandbox, trace judge, or billing system.

Braid does not promise native process-memory continuity when moving a conversation between runners.

Braid does not expose unsupported runner-native commands by guessing their meaning.

Braid does not use a web application as the canonical interface for the first release.

Braid does not make third-party terminal applications dependencies beyond the narrow renderer package.

Braid does not call a visual graph a workspace fork or call a copied transcript a resumed native session.

## Product quality measures

The release measures product quality with the following denominators.

| Measure | Release requirement |
| --- | --- |
| Required verification checks | 100% linked to passing evidence in one release manifest |
| Supported reference terminal sizes | 4 of 4 pass visual and keyboard checks |
| Required live connection paths | CLI Bridge, Tangle inference, and Tangle sandbox all complete their specified smoke flows |
| Durable-run replay cases | 100% preserve ordered output with zero duplicate displayed parts |
| Interaction outcome cases | Acceptance, decline, cancel, timeout, restart, and concurrent queue all pass |
| Required fork cases | Conversation, cross-runner, and cloud workspace forks all show correct provenance |
| Security checks | 100% of required checks pass with no unresolved critical or high finding |
| Calibrated semantic cases | The judge separates seeded good and bad examples before scoring release cases |

Usage and retention metrics may be added only with explicit user consent and must never include prompt content, tool arguments, secrets, or raw traces by default.

## Naming and language

The product name is Braid.

Tangle is the company and cloud network, not the terminal product name.

User-facing copy says profile, connection, runner, conversation, branch, run, interaction, analysis, environment, and worker.

The word harness may appear in raw profile fields or developer diagnostics, but the default interface calls it a runner.

The interface never calls a connection an agent, never calls a runner a model, and never calls a provider session a conversation.

## Product acceptance

| ID | Required outcome |
| --- | --- |
| PR-01 | A new user completes one real CLI Bridge turn from an existing profile without editing a configuration file. |
| PR-02 | The same profile completes one real Tangle sandbox turn and the interface explains the changed placement. |
| PR-03 | The user changes runner for a new branch without changing the stored profile and can inspect both run snapshots. |
| PR-04 | A disconnected durable run resumes from its cursor with no missing or duplicated displayed event. |
| PR-05 | A permission request reaches the terminal, receives a scoped response, and the waiting run continues through the shared contract. |
| PR-06 | Conversation-only and environment forks display different, accurate copy semantics before confirmation. |
| PR-07 | `/ask` creates a separate cited analysis node and does not add a message to the analyzed branch. |
| PR-08 | A live runtime worker can be inspected, steered, and cancelled through a runtime API that confirms the effect. |
| PR-09 | Restarting Braid reconstructs the same conversation graph, interaction decisions, and run bindings from the local journal. |
| PR-10 | A keyboard-only user completes every primary journey at 80×24 and a narrow 40×12 terminal exposes no unreachable action. |
| PR-11 | Headless commands reproduce the same state transitions and validation results as the terminal interface. |
| PR-12 | One release manifest proves all required deterministic, terminal, live, visual, semantic, security, install, and performance checks against one immutable Braid build. |

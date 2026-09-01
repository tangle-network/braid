<div align="center">
  <h1>Braid</h1>
  <p><strong>One AgentProfile. Any supported coding runner.</strong></p>
  <p>
    <a href="https://github.com/tangle-network/braid/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/tangle-network/braid/actions/workflows/ci.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-7aa2f7"></a>
  </p>
</div>

Braid is a durable terminal client for coding agents.

A portable [`AgentProfile`](https://github.com/tangle-network/agent-sdk/tree/main/packages/agent-interface) defines one agent's identity, instructions, model, runner preference, tools, and permissions.

Braid sends each turn through [`agent-runtime`](https://github.com/tangle-network/agent-runtime) and keeps the conversation, branches, runs, interactions, activity, graph, supervisors, and trace analyses together.

Braid is a terminal client, not another agent loop.

The [component design map](docs/components/README.md) links each visible surface to its owning contract and source component.

## Install

Braid requires Node.js 22.19 or newer.

The published package currently targets Linux and macOS.

```bash
npm install --global @tangle-network/braid
braid
```

The first-run flow selects an `AgentProfile` and a connection.

A connection supplies transport and credential references.

Credential values stay in the operating-system credential facility or their bounded response path.

Use these launch forms when needed:

```bash
braid --inline                 # keep normal terminal scrollback
braid --plain                  # readable non-interactive output
braid rpc                      # JSON Lines control interface
braid --conversation <id>      # open a durable Braid conversation
```

`--profile`, `--connection`, `--runner`, `--model`, and `--effort` select defaults for the opened or new branch.

They do not rewrite the profile source.

## Operating model

The profile defines who the agent is.

The connection defines where requests go and which credentials they use.

The runner defines which coding program executes one run.

The SDK field `harness` stores that runner preference.

Braid owns the user-visible conversation graph, durable event journal, branch choices, interaction decisions, activity views, and terminal/headless presentation.

The execution route is:

```text
AgentProfile + user turn
        │
        ▼
      Braid
        │  profile snapshot · connection · run limits
        ▼
  agent-runtime
        │
        ├── CLI Bridge ── selected local runner
        ├── Tangle inference
        └── Tangle sandbox ── remote workspace
        │
        ▼
normalized events, receipts, activity, and final output
```

Braid does not launch runner processes directly, parse private runner output, materialize profile files, schedule sandboxes, run trace judges, or implement billing.

An admitted run stores an immutable profile snapshot, effective runner, model, reasoning effort, configured output limits, connection, provider session, environment, and capability snapshot.

Configured limits are not measured usage.

This is the shape of a profile using the current routed model example:

```ts
import type { AgentProfile } from '@tangle-network/agent-interface'

const profile: AgentProfile = {
  name: 'Release engineer',
  harness: 'pi',
  model: {
    provider: 'tangle-router',
    default: 'tangle-router/glm-5.3',
    reasoningEffort: 'high',
  },
  prompt: {
    instructions: [
      'Inspect the repository before changing it.',
      'Run focused checks and report exact evidence.',
    ],
  },
  tools: { read: true, write: true, shell: true },
  permissions: { read: 'allow', write: 'ask', shell: 'ask' },
}
```

## Parallel work: Work Strip, activity, and focus

Braid admits one run per conversation branch at a time.

Different branches and conversations can stream concurrently while each branch preserves its own turn order.

Inputs for an active run queue by default.

`/queue <text>` always adds the next turn.

`/steer <text>` sends live steering only when that run reports steering support.

`Alt+S` switches between queue and steer when both actions are available.

The Work Strip appears when at least two active, queued, waiting, or detached work items need attention.

Each item shows its branch, state, runner and model, pending interaction count, and available actions.

Standard terminals show up to three items, wide terminals show up to eight, and narrow terminals show one bounded count with `/activity to switch`.

`/activity` opens a full-screen browser instead of adding a permanent side panel.

`Tab` cycles `all`, `runs`, `analyses`, and `workers` scopes.

In the `runs` scope, `Enter` opens details and focuses controls for that exact run.

Changing focus does not pause, cancel, detach, or reassign another run.

Controls carry the selected run identifier, so a background run cannot receive a focus-dependent action by accident.

Direct turns, trace analyses, supervisors, and workers remain separate activity records with separate usage totals.

An unbound supervisor remains workspace activity and is not attributed to the current turn.

## Continue, branch, and fork

### Native continuation

An ordinary follow-up uses the exact provider session only when the current branch tip has the same profile and connection, the provider reports session continuation, and the provider proves the recorded message boundary with retry-safe request identity.

Only the new user input is submitted because the provider session remains authoritative for its native context.

If the provider cannot prove that boundary, Braid does not submit to the native session.

Choose a fresh provider session with an explicit portable context transfer when that provider supports it.

The transfer lists included, omitted, and transformed parts and requires acceptance when it changes the context.

`--conversation <id>` attaches to Braid's durable record and recorded run bindings.

It does not take over an arbitrary native runner process.

`/interactive <prompt>` and `/attach [run-id]` are separate native-terminal operations.

They require an interactive TUI and a retained provider session with native terminal support.

### Conversation operations

`/branch [message]` creates a new branch at a message boundary in the same conversation.

It uses a new provider session and keeps the current environment shared.

Pending interactions and queued work after the boundary are not inherited.

`/clone` creates a separate conversation from the active branch tip with new conversation, branch, and execution identities.

It may retain a reference to the same workspace, but it does not copy provider process memory.

`/fork` opens a provenance preview before creating a branch.

The preview shows the transcript boundary, profile, run overrides, provider session, environment, checkpoint, working-tree state, queued input, and pending interactions.

The default is a conversation-only fork with a new provider session and shared environment.

`/fork --runner <name>` creates a cross-runner handoff with a new provider session and explicit portable context.

Hidden process memory, runner-specific todos, opaque tool state, and opaque tool identifiers do not transfer.

`/fork --workspace` requests a real provider checkpoint and destination environment.

It is available only when the provider reports retry-safe checkpoint and fork operations, lookup by idempotency key, and explicit cleanup.

The source environment remains unchanged, and a failed fork does not destroy its checkpoint or source.

The destination environment is not assumed to include external services, browser sessions, secrets, network connections, or provider process memory.

## Interactions and secrets

An interaction is a provider request with a stable identifier, kind, prompt, subject, timeout, allowed outcomes, and canonical `answerSpec`.

Known kinds include questions, permissions, and plans.

Unknown kinds render through the generic answer specification and fail closed if Braid cannot validate a response.

`/approve [scope]` accepts an allowed response.

`/reject [feedback]` declines it when the schema accepts feedback.

The terminal validates text, number, boolean, select, and secret answers before dispatch.

Permission controls expose only scopes declared by the provider.

Secret answers are masked and sent only through the bounded response path.

They are excluded from history, profiles, SQLite, logs, snapshots, screenshots, and trace artifacts.

`/automate` manages scoped non-secret response rules.

An answer specification containing a secret field cannot create or match an automation rule.

Concurrent interactions remain attached to their source runs and display in stable arrival order.

Response retries reuse the same operation identifier and never answer twice.

## Trace analysis

Trace analysis reads a frozen run or branch record in a separate execution.

It does not send a question to the active agent and does not append a message to the analyzed branch.

```text
/ask <question>                         cited free-form question about the last eligible source
/analyze failure,cost,tools             run selected named recipes
/analyze all                            run every available trace analyst
/compare <left> <right>                 compare two frozen sources
```

`/ask` uses the last completed or failed run unless a source is selected explicitly.

Each analysis records its source digest, analyst profile, model, recipe, progress, findings, citations, completeness, usage, latency, cost, and cancellation state.

The analysis activity scope uses `p` to promote a supported cited finding and `x` to cancel active analysis.

Promotion creates an explicit attachment or a branch fork; it never changes the source implicitly.

Comparisons show every measured field and asymmetry before any semantic interpretation.

## Runtime supervisors and workers

`/activity` reads runtime-owned supervisor snapshots through the shared Runtime API.

It does not read `.agent/supervisor` files or infer identity from display text, timestamps, or row order.

In the `workers` scope, `r` refreshes the snapshot, `s` opens a worker steering prompt, `x` requests cancellation, and `a` attaches to a running worker's retained terminal when available.

Worker steering sends the exact runtime worker identifier with a stable operation identifier and displays a queued or acknowledged effect.

Worker cancellation and supervisor cancellation use runtime-owned idempotent operations and display the acknowledged effect and terminated descendants when reported.

Worker attachment resolves the projected Braid supervisor and worker to exact Runtime identifiers, then claims the retained interactive handle for that worker.

It is available only in the interactive TUI when the selected worker is running and its provider exposes a retained terminal binding.

That worker action is different from `/attach [run-id]`, which targets a retained native terminal session.

When the runtime cannot acknowledge a control, Braid leaves the result queued or unknown.

It never displays delivered steering or cancellation without the matching runtime effect.

## Capability-aware commands

Braid asks the active provider and Runtime for capabilities before it enables an action.

Unavailable commands remain searchable and explain the exact missing capability.

Common reasons include:

| Action | Exact reason shown when the condition applies |
| --- | --- |
| Worker steer | `There is no running supervised worker to steer` |
| Worker cancel | `There is no running supervised worker to cancel` |
| Supervisor cancel | `There is no running supervisor to cancel` |
| Worker attach without an interactive TUI | `Worker terminals require an interactive TUI` |
| Worker attach without a running worker | `There is no running supervised worker to attach` |
| Worker attach with a stale selection | `The selected worker is not running` |
| Worker attach with a missing target | `The selected worker is not present under the selected supervisor` |
| Worker attach without a retained binding | `The worker has no retained terminal binding` |
| Worker attach without provider support | `The worker provider cannot attach a terminal` |
| Worker attach without a configured provider | `Select the worker's Tangle Sandbox connection first` |
| Native terminal | `Select a retained Tangle Sandbox connection with native terminal support` |
| Native session attach | `No retained native session is available` |
| Interaction response | `Interaction response is not exposed by the current runtime adapter` |
| Provider cancellation | `The current runtime does not acknowledge provider cancellation` |
| Live steering | `The current runtime does not report steering support` |
| Queued input | `The current runtime does not report queued input support` |

A missing capability never becomes a simulated success.

## Tangle Sandbox lifecycle

New Tangle Sandbox connections default to one ephemeral cloud turn and delete the environment after the turn.

Retained execution is an explicit connection choice.

Braid requires exact retained-run control and provider-backed lookup before it creates a retained environment, so restart can recover an uncommitted dispatch.

The provider reports lifecycle, replay, control, interaction, continuation, workspace, placement, resource, and usage capabilities per run.

Braid shows requested, verified, sampled, estimated, and unavailable values separately.

It never guesses machine identity, IP address, effective resources, storage, or cost when the provider does not report them.

## Commands at a glance

| Need | Command or key |
| --- | --- |
| Select profile and route | `/profile`, `/connection`, `/runner`, `/model`, `/effort` |
| Open activity and focus a run | `/activity`, `F2`, `Enter` on a run row |
| Navigate conversation work | `/graph`, `/branch`, `/clone`, `/fork` |
| Answer an interaction | `/approve`, `/reject`, `/automate` |
| Queue, steer, or cancel a run | `/queue`, `/steer`, `/cancel` |
| Detach and recover retained work | `/detach`, `/reconnect`, `/reconcile` |
| Use a native terminal | `/interactive`, `/attach` |
| Analyze or compare work | `/ask`, `/analyze`, `/compare` |
| Drive Braid from another process | `braid rpc` |

Run `/help [query]` for the complete command and key registry.

The command palette uses the same capability explanations as direct invocation.

## Headless mode

`braid rpc` exposes JSON Lines commands over the same application core as the terminal.

Headless clients can inspect state, send, queue, steer, cancel, detach, reconnect, reconcile, respond to interactions, manage automation, branch, clone, fork, analyze, compare, inspect activity, control workers, and export records.

Worker terminal attachment remains an interactive-TUI action.

Mutating requests carry stable operation identifiers, so retries can be recognized instead of dispatched twice.

Plain output and headless state contain no terminal control sequences.

## Ownership and safety boundaries

| Boundary | Owner |
| --- | --- |
| Portable agent definition and compatibility helpers | `agent-interface` |
| Run admission, lifecycle, normalized events, replay, and runtime control | `agent-runtime` |
| Local runner process and native profile materialization | CLI Bridge |
| Inference and remote workspace lifecycle | Tangle provider and sandbox packages |
| Trace analysis and paired comparison | `agent-eval` |
| Conversation journal, branches, graph, interactions, projections, and interfaces | Braid |

Components render immutable view models and emit typed intents.

Controllers own workflows, cancellation, event reduction, and side effects through ports.

Untrusted terminal content is sanitized before rendering, and OSC control sequences are suppressed by default.

No credential value, secret interaction answer, provider-private state, or raw secret-bearing trace enters a profile, SQLite record, log, snapshot, screenshot, or export.

## Development and proof

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm capture:visual
```

`pnpm check` runs the repository's formatting, lint, type, boundary, dependency, attribution, license, test, live, and release checks.

`pnpm capture:visual` records terminal state at 40×12, 80×24, 120×40, and 200×60 and exercises the keyboard path.

The [verification plan](docs/08-verification.md) defines the required live, headless, terminal, security, installation, and release evidence.

The [delivery plan](docs/09-delivery-plan.md) records dependency order and completion criteria.

The [product contract](docs/01-product-contract.md), [experience specification](docs/02-experience-specification.md), [runtime contracts](docs/04-runtime-contracts.md), and [conversation/fork/analysis contract](docs/06-conversations-forks-and-analysis.md) define the behavior and ownership boundaries.

## Open-source foundation

Braid uses the MIT-licensed [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) package for terminal rendering and input primitives.

See the [renderer decision](docs/decisions/001-pi-tui-renderer.md), [runtime boundary](docs/decisions/002-runtime-boundary.md), [upstream strategy](docs/10-upstream-strategy.md), and [third-party notices](THIRD_PARTY_NOTICES.md) for the reuse boundary.

## License

[MIT](LICENSE)

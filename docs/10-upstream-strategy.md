# Upstream strategy

## Decision

Braid depends on the published Pi TUI library, builds its own application core, selectively adapts presentation and interaction code from Pi and Kimi Code, and treats OpenCode and Hermes Agent as design references.

Braid imports the runtime-owned supervisor read and control surface instead of copying the runtime monitor.

This is a source-reuse plan, not a whole-application fork.

## Research method

The comparison used current source, package metadata, licenses, application instructions, architecture documents, interaction code, tests, and measured TypeScript surface at immutable commits on 2026-08-01.

Line count is only a coupling signal and not a quality score.

The deciding question was how much source can be reused while preserving `AgentProfile`, `agent-runtime`, provider, and `agent-eval` ownership.

## Sources inspected

| Source | Commit or version | License | Measured relevant TypeScript | Role in decision |
| --- | --- | --- | ---: | --- |
| [Pi TUI](https://github.com/earendil-works/pi/tree/master/packages/tui) | `53fa77ccd8a279eb87e92294ef3687b03ff80112`; npm `0.84.1` | MIT | 16,202 lines | Selected renderer dependency |
| [Pi coding-agent interactive mode](https://github.com/earendil-works/pi/tree/master/packages/coding-agent/src/modes/interactive) | `a6f7317dfca61e357aee65faafe012a1be6c3734` | MIT | 16,925 lines, including a 6,125-line coordinator | Selective behavior and component source |
| [Kimi Code terminal app](https://github.com/MoonshotAI/kimi-code/tree/main/apps/kimi-code/src/tui) | `e22479a62eed9c3b78a67b313f4332c2c0ba9670` | MIT | 39,688 lines; 65 files directly import Kimi Code SDK | Selective interaction and controller source |
| [Kimi private Pi TUI fork](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui) | package version `0.80.8` at `e22479a` | MIT | Included in repository inspection | Patch and regression reference only |
| [OpenCode terminal command](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/cli/cmd/run) | `32f278b48f1a495611165d8a9f1ace0b512933e2` | MIT | 18,492 lines | OpenTUI alternative and workflow reference |
| [Hermes Agent terminal app](https://github.com/NousResearch/hermes-agent/tree/main/ui-tui) | `f88ed6c71768cdc7ea3bfa8cf62d16654792fd2a` | MIT | No size claim used | Client/runtime and workflow reference |
| [`agent-runtime` terminal monitor](https://github.com/tangle-network/agent-runtime/tree/main/src/tui) | `9b2005d43186144cb7cbf606b98637434bee3c8f` | Project license | 1,657 lines | Runtime-owned supervisor source, not app base |

The count commands selected tracked `.ts` and `.tsx` files under each named directory and used `wc -l`.

The Kimi SDK coupling count selected terminal files that directly import `@moonshot-ai/kimi-code-sdk`.

## Pi TUI

### What the standalone package provides

Pi TUI provides main-screen and alternate-screen rendering, differential frame output, cell-width calculation, viewport and scrolling, containers, overlays, focus, editor input, autocomplete, history, undo, kill ring behavior, selection lists, settings lists, markdown, images, IME handling, keyboard decoding, and a public terminal interface.

The Pi repository includes a useful `packages/tui/test/virtual-terminal.ts` helper, but `@earendil-works/pi-tui@0.84.1` does not publish or export it.

Braid will adapt that test-only helper with attribution unless Pi first publishes a supported testing export.

Its production dependency surface is small relative to a complete application.

The package is independently versioned and published, which gives Braid a normal update path instead of a copied terminal framework.

### What the Pi application provides

Pi's coding-agent interface provides polished assistant, reasoning, tool, model, effort, session, tree, footer, command, and error presentation.

Its tree behavior distinguishes branching within session history, forking from a prior user message, and cloning an active branch.

Its application coordinator also directly manages Pi `AgentSession`, model registry, authentication, session storage, compaction, extensions, commands, and runner events.

That coordinator is the wrong ownership center for Braid.

### Reuse rule

Braid uses the library as a dependency.

Braid may adapt a Pi application component only after replacing Pi session, model, auth, and command inputs with immutable Braid view models and intents.

Braid does not import any `@mariozechner/pi-agent-core` or Pi coding-agent runtime module.

## Kimi Code

### Strong patterns

Kimi Code separates a terminal coordinator, controllers, command registry, presentation components, reverse-RPC interactions, theme, and utilities.

Its components are substantially presentation-oriented and its controllers own event and modal workflows.

The reverse-RPC approval views provide rich subject-specific previews for shell, diff, file, URL, search, agent, skill, and task-list operations.

The approval flow distinguishes one-time, session, reject, and feedback choices.

Its plan review and question flows serialize concurrent requests and arbitrate foreground modals.

Its selector, paging, terminal-theme, narrow-layout, CJK, keyboard, and streaming tests are valuable behavioral references.

### Coupling cost

The complete terminal application is 39,688 TypeScript lines and 65 files directly import Kimi Code SDK types.

It also depends on a private `@moonshot-ai/pi-tui` package fork and project aliases throughout the application.

Forking the whole app would require replacing session, auth, model, provider, SDK, command, configuration, update, and engine assumptions before Braid could exercise its real runtime path.

### Reuse rule

Braid may adapt interaction display blocks, approval panel presentation, question presentation, modal queue behavior, selector utilities, and associated tests.

The adapted controller accepts canonical `InteractionRequest`, `InteractionResponse`, and Braid view models instead of Kimi reverse-RPC types.

Braid does not copy Kimi authentication, provider, Kimi session, goal engine, update, plugin, MCP ownership, or SDK dispatch code.

Kimi's private Pi TUI changes are regression references.

If one fixes a Braid failure missing from published Pi TUI, Braid first reproduces the issue against current Pi, then upstreams or carries the smallest tested patch with attribution.

## OpenCode

OpenCode's current terminal application uses OpenTUI core and Solid bindings, plus its broader Bun, Solid, and Effect application stack.

It demonstrates a rich retained-mode terminal and useful permission, question, subagent, scrollback, and command surfaces.

Its source is coupled to OpenCode's server, session synchronization, configuration, storage, and command architecture.

Adopting OpenTUI would still require Braid to build its complete application core while replacing Pi's already suitable editor, renderer, and terminal interface.

OpenCode remains the renderer reversal candidate if Pi fails the vertical slice or becomes unmaintained.

Braid may copy no OpenCode source during the initial implementation without a separate component-level comparison and notice entry.

## Hermes Agent

Hermes Agent's terminal package validates the product shape of a TypeScript client over a separate execution runtime.

It provides useful references for modal permissions and clarification, session and model selection, queue, steering, interrupt, branches, forks, tools, and subagents.

Its React 19, Ink fork, nanostore, and Python JSON-RPC architecture would add a second rendering and runtime translation stack to Braid.

Braid uses Hermes as a workflow comparison and does not port its runtime protocol or application stack.

## Runtime monitor

`agent-runtime` source version `0.118.0` exports a diagnostic terminal module and `agent-runtime-top` binary.

The module understands runtime-owned supervisor files and shows worker state, spend, tokens, latency, logs, steering, shell action, and cancellation controls.

Its raw-ANSI interface is deliberately compact and does not provide the editor, overlays, transcripts, profiles, interactions, forks, or analyses Braid needs.

Braid imports stable runtime-owned snapshot and control APIs and renders the data in its own activity and graph views.

Braid never copies or independently parses `.agent/supervisor` layout.

The current monitor's unread cancellation request is treated as an upstream defect, not a reusable control.

## Reuse map

| Braid surface | Primary source | Reuse form | Explicit exclusion |
| --- | --- | --- | --- |
| Terminal lifecycle and differential render | Pi TUI | Exact-version dependency | No raw Braid ANSI renderer |
| Editor, selection, completion, history, undo, and paste | Pi TUI | Dependency plus Braid keymap adapter | No Pi session input coordinator |
| Overlay and focus primitives | Pi TUI | Dependency | No product state in component callbacks |
| Markdown, text width, and images | Pi TUI | Dependency with security wrapper | No implicit remote image fetch |
| Deterministic test terminal | Pi TUI test helper | Test-only adaptation with immutable attribution, or future public testing export | No production dependency on Pi test internals |
| Assistant, reasoning, tool, and footer presentation | Pi application | Selective adaptation or clean Braid component informed by source | No Pi message/session/model types |
| Session tree selection behavior | Pi application | Behavioral reference and selected presentation code | No Pi session store |
| Permission display blocks and plan review | Kimi Code | Selective adaptation with canonical interaction adapter | No Kimi SDK or reverse-RPC protocol |
| Interaction queue and modal arbitration | Kimi Code | Behavioral adaptation and tests | No Kimi session controller |
| Searchable selector and narrow-layout edge cases | Pi and Kimi Code | Reuse library primitive and port behavior tests | No duplicate selector systems |
| Permission and question workflow comparison | OpenCode and Hermes Agent | Design review only | No source copy or runtime protocol |
| Runtime activity and worker tree | `agent-runtime` | Stable data and control import | No supervisor file parsing |
| Conversation, branch, run, analysis, and environment graph | Braid | New domain component | No runner-native graph as canonical state |
| Profiles, connections, context transfer, replay, and persistence | Tangle packages and Braid core | Canonical contract integration | No upstream terminal application's product model |

## Adaptation procedure

Before adapting a source component, record the user-visible behavior and verify that Pi TUI cannot provide it directly.

Copy the smallest coherent component and its relevant tests, not a directory tree.

Add a source header with repository URL, immutable commit, source path, license, and summary of changes.

Add the same information to `THIRD_PARTY_NOTICES.md`.

Replace upstream domain types at the boundary before adding Braid behavior.

Remove source-specific authentication, session, model, provider, command, storage, update, and telemetry logic.

Convert styling to Braid semantic tokens and untrusted strings to sanitized view models.

Port source tests that prove subtle terminal or interaction behavior and add Braid contract tests for the new inputs.

Run the dependency-boundary check and copied-source notice check in the same commit.

A reviewer compares the adapted file with its immutable source and confirms license and intentional differences.

## Patch policy for Pi TUI

Braid initially consumes unmodified `@earendil-works/pi-tui` at an exact lockfile version.

A missing behavior begins with a minimal reproduction in Braid's virtual-terminal or PTY suite.

The preferred resolution is an upstream Pi contribution with a release.

If release timing blocks Braid, `pnpm patch` may carry a narrow patch with source reference, explanation, and regression test.

Every patch has an owner, upstream issue or pull request when appropriate, first version, affected files, removal condition, and last revalidation date.

Two simultaneous invasive patches or any patch touching Pi TUI's core render, input, and overlay paths triggers the OpenTUI reversal comparison.

Vendoring the package requires a new decision record and complete license preservation.

## Upgrade policy

Dependency updates are deliberate pull requests, never unattended merges.

The update records old and new versions, source commits, changelog, changed exported types, local patches, license, install scripts, and dependency graph.

The complete unit, virtual-terminal, PTY, Unicode, IME, resize, visual, security, and performance suite runs before merge.

Visual differences receive before and after captures and an explanation by state and dimension.

An upstream change that moves application ownership into the renderer is wrapped or rejected rather than allowed into Braid controllers.

Kimi, OpenCode, and Hermes are re-inspected before a major interaction redesign, not copied continuously.

## Design extraction rules

References supply concrete behavior, not branding or decorative imitation.

Braid retains a transcript-first layout, compact status, one modal system, consistent selectors, semantic state, and keyboard-first control.

Braid removes duplicate labels, procedural cards, giant default selections, fake readiness, repeated action words, dead panes, and controls that narrate their own obvious operation.

An adapted component must work at every reference size and in no-color mode before it is accepted.

Visual parity with a reference is insufficient when the Braid profile, capability, interaction, or fork semantics differ.

## Source-reuse risks

| Risk | Control |
| --- | --- |
| Pi API drift | Exact pin, adapter boundary, changelog review, and complete terminal suite |
| Kimi component imports domain assumptions | Component-level boundary replacement and dependency test |
| License or attribution omission | Source headers, notice table, automated inventory, and release check |
| Local Pi patch accumulation | Patch ledger, upstream-first policy, and reversal threshold |
| Visual inconsistency across adapted sources | One Braid theme, selector contract, spacing rules, and screenshot review |
| Duplicate application state | Components receive immutable Braid view models only |
| Hidden auto-approval copied from a runner | Shared interaction contract and live denial checks |
| Whole-app fork temptation | ADR 001 and measured decoupling killer test before reversal |
| Runtime monitor state leakage | Stable runtime imports and repository check forbidding file-layout access |

## Upstream-strategy acceptance

| ID | Required proof |
| --- | --- |
| US-01 | Production dependencies contain exactly one terminal framework and no complete third-party agent application or loop. |
| US-02 | Pi TUI is pinned, licensed, isolated behind Braid views, and passes the complete terminal conformance suite. |
| US-03 | Every copied or substantially adapted file has a matching immutable source header, notice row, license, and adapted behavior test. |
| US-04 | No Braid view or adapted component imports Pi coding-agent, Kimi SDK, OpenCode application, Hermes runtime, provider, storage, or runtime-control modules. |
| US-05 | Braid contains no direct `.agent/supervisor` file read or write and uses stable runtime-owned snapshot and control exports. |
| US-06 | Every Pi TUI patch has a reproduction, ledger entry, upstream disposition, regression test, and removal condition. |
| US-07 | Dependency upgrades include exact before and after visual, Unicode, input, security, performance, license, and package evidence. |
| US-08 | The OpenTUI reversal comparison runs before renderer replacement when either documented threshold is met. |
| US-09 | A source inventory script reproduces every measured local copied-source path and finds no unattributed substantial match. |
| US-10 | An independent review confirms the application state and execution ownership remain Braid and Tangle contracts rather than an upstream terminal application's domain. |

# Braid current terminal design audit

## Verdict

The packaged local and CLI Bridge product path passes the current terminal design audit.

The review used current reference source, not screenshots or old package releases.

Protected Tangle inference and sandbox paths remain unverified without their credentials.

Native runner attachment and normalized incremental tool events remain explicit upstream limits.

## Product basis

[`docs/01-product-contract.md`](../docs/01-product-contract.md) is the canonical product brief.

It defines four primary users: individual developers, Tangle cloud users, agent operators, and agent researchers.

The core job is one portable `AgentProfile` across runners and execution locations.

Braid owns the conversation, branch, analysis, interaction, and terminal experience.

The runtime and provider packages own execution.

## Current references

The source review in [`docs/10-upstream-strategy.md`](../docs/10-upstream-strategy.md) was refreshed on 2026-08-10.

| Reference | Inspected version | Braid use |
| --- | --- | --- |
| Pi TUI | repository `cd6852a`; TUI `87142a8`; npm `0.84.1` | Renderer, editor, focus, overlays, and terminal lifecycle |
| Kimi Code | commit `e22479a6` | Interaction, approval, queue, and narrow-layout patterns |
| OpenCode | commit `3a90639c`; npm `1.18.16` | Worker inspection and retained terminal patterns |
| Codex | repository `070a26a`; TUI `9742cc8e`; CLI `0.147.0` | Composer, status, worker navigation, and snapshot patterns |
| Hermes Agent | commit `f88ed6c7` | Workflow and client/runtime comparison |

No newer Pi TUI change exists after its inspected subtree commit.

No newer Codex terminal change exists after its inspected subtree commit.

## Surface coverage

The packaged proof contains 75 artifacts for 11 required states.

It covers empty, streaming, interaction, automation, fork, graph, analysis, comparison, profile, narrow, and recovery states.

The terminal proof covers 40 by 12, 80 by 24, 120 by 40, and 200 by 60 cells.

Stable top rows identify the workspace, conversation, branch, admitted profile, runner, model, connection, and reasoning level.

Stable bottom rows identify status, controls, direct usage, analysis usage, and worker usage.

Interactions and fork previews use one divided, full-screen focused surface instead of stacked floating panels.

The 40-by-12 layout preserves the question, validation failure, response input, outcome keys, and closing key.

The same identity and composer renderers drive startup preview and the live terminal.

The same application core drives the Pi terminal, plain output, and JSONL control mode.

Keyboard proof covers transcript paging, selection, completion, cancellation, approval, browser navigation, and return behavior.

Accessibility proof covers no-color output, high contrast, reduced motion, Unicode, grapheme editing, and sanitized terminal input.

## User complaint ledger

| Complaint | Resolution | Proof |
| --- | --- | --- |
| The design could be behind current terminal products. | The review uses current Pi, Codex, OpenCode, Kimi Code, and Hermes source versions. | `docs/10-upstream-strategy.md` |
| The screen hid profile, model, runner, and connection identity. | Stable chrome places the exact execution target above the transcript. | `test/terminal-responsive.test.ts` |
| Startup looked different from the loaded application. | Startup and live views share identity and composer renderers. | `test/cli-startup.test.ts` |
| The `/ask` surface looked layered and lacked a divider. | One divided activity browser replaces stacked analysis overlays. | `artifacts/verification/w6/states/analysis.png` |
| Permissions looked like floating cards over another screen. | Interactions use one full-screen focused surface with one header and footer. | `artifacts/verification/w6/states/interaction.png` |
| Small terminals could hide validation and decisions. | The shared layout keeps four response rows and drops secondary preview rows first. | `test/tui-core-workflows.test.ts` |
| Back navigation was unclear. | Left arrow and Escape return from analysis, activity, and fork detail views. | `test/tui-core-workflows.test.ts` |
| Analysis was a raw record dump. | The view groups question, findings, numbered evidence, next action, model use, and run receipt. | `test/tui-core-workflows.test.ts` |
| Runtime labels exposed internal names. | The transcript presents `agent-turn-result` as `run result`. | `test/w6-ui.test.ts` |
| Calls, tokens, costs, and latency were opaque. | Analysis and session views retain separate model-call and aggregate measurements. | `test/analysis-model-call-roundtrip.test.ts` |
| Estimated cost could look exact. | Estimated totals use `~`; partial observed totals use `>=`; missing values remain unknown. | `test/terminal-usage-status.test.ts` |
| Worker and direct-run usage could be mixed. | Direct, analysis, and worker totals remain separate. | `test/terminal-usage-status.test.ts` |
| The empty screen gave generic instructions. | The prompt names the selected profile and the command shortcut. | `test/w6-ui.test.ts` |
| Terminal chrome risked becoming one large controller. | Composition, identity, and usage live in separate 143-line, 200-line, and 177-line modules. | `src/views/tui/terminal-chrome.ts` |
| The public demo looked like a toy. | The packed demo uses a Product engineer profile through real Pi and Local CLI Bridge. | `artifacts/demo/braid-live-pi.gif` |

## Decisions and rejected alternatives

| Decision | Selected | Alternative 1 | Alternative 2 | Reason |
| --- | --- | --- | --- | --- |
| Renderer | Published Pi TUI package | Copy a complete runner application | Rewrite with OpenTUI | Pi supplies mature primitives without taking runtime ownership. |
| Focused workflow | One full-screen divided surface | Centered floating panel | Permanent side pane | One surface keeps context and controls legible at every supported size. |
| Execution identity | Stable top chrome from one exact target | Repeat identity in messages | Mix selected and active fields | One immutable run receipt prevents misleading route combinations. |
| Narrow layout | Preserve response rows and shorten secondary detail | Scroll controls below content | Add another permanent row | Users must always see the current decision and exit path. |
| Analysis presentation | Grouped complete document | Raw event fields | Hide detailed evidence | Users need conclusions and the records that support them. |
| Activity navigation | Context rail plus full browser | Layered modal stack | Permanent wide sidebar | One projection works at every width and preserves transcript space. |
| Public demo | Packed Braid through CLI Bridge and Pi | Fixture-only recording | Static mock | The real route proves identity, execution, analysis, and accounting together. |

## Measured proof

| Check | Result |
| --- | --- |
| Complete repository command | `pnpm check` passed |
| Repository tests | 615 passed, 0 failed, 2 protected checks skipped |
| Unit tests | 226 passed, 0 failed |
| Real terminal-cell tests | 122 passed, 0 failed |
| Performance tests | 15 passed, 0 failed |
| Dependency structure | 457 modules, 2,336 edges, 0 cycles |
| Production dependencies | 68 packages, 0 known vulnerabilities, 0 high or critical audit findings |
| Live-demo safety tests | 18 passed, 0 failed |
| Visual states | 11 of 11 captured |
| Reference terminal sizes | 4 of 4 captured |
| Packed visual artifacts | 75 written and inspected |
| Exact packed source | Commit `ab893af041e6d7d0efe670b9472af6a0d9bea651`, tarball SHA-256 `8dddc8d112dd142b8a11c5c08a4f7c59ed031fcae80a31081264de353988671a` |
| Real coding task | 8 passed, 0 failed in the retained Pi demo |
| Real coding route | Product engineer profile, Pi `0.83.0`, GLM 5.2, high reasoning, and Local CLI Bridge |
| Real coding usage | 12,804 input tokens, 2,173 output tokens, 1 call, and 63,300 ms model latency |
| Real analysis evidence | 7 of 7 calls retained across 2 pages in the retained Pi demo |
| Real analysis usage | 53,757 input tokens, 8,153 output tokens, estimated $0.0501908, and 210,327 ms wall time |

The retained visual capture is [`artifacts/verification/w6`](../artifacts/verification/w6).

It was generated from a clean install of the exact packed tarball through a real pseudo-terminal.

The retained Pi demo is [`artifacts/demo/braid-live-pi.json`](../artifacts/demo/braid-live-pi.json).

It ran the exact packed tarball through Local CLI Bridge and real Pi before it rendered the coding result and `/ask` analysis.

## Remaining external limits

[`agent-runtime` issue 762](https://github.com/tangle-network/agent-runtime/issues/762) must expose incremental normalized tool events.

[`agent-runtime` issue 773](https://github.com/tangle-network/agent-runtime/issues/773) must expose exact execution and worker attachment.

Protected Tangle inference and sandbox checks require their real credentials and service paths.

These limits are visible and fail closed.

They do not change the proven local Pi and CLI Bridge product path.

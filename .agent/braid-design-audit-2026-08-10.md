# Braid production terminal audit

## Verdict

The packaged local and CLI Bridge product path passes the production terminal audit.

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
| Pi TUI | npm `0.84.1`, commit `87142a8d` | Renderer, editor, focus, overlays, terminal lifecycle |
| Kimi Code | commit `e22479a6` | Interaction, approval, queue, and narrow-layout patterns |
| OpenCode | commit `3a90639c` | Worker inspection and retained terminal patterns |
| Codex | commit `9742cc8e` | Composer, status, worker navigation, and snapshot patterns |
| Hermes Agent | commit `f88ed6c7` | Workflow and client/runtime comparison |

## Surface coverage

The packaged proof contains 75 artifacts for 11 required states.

It covers empty, streaming, interaction, automation, fork, graph, analysis, comparison, profile, narrow, and recovery states.

The terminal proof covers 40 by 12, 80 by 24, 120 by 40, and 200 by 60 cells.

The same application core drives the Pi terminal, plain output, and JSONL control mode.

Keyboard proof covers transcript paging, selection, completion, cancellation, approval, browser navigation, and left-arrow or Escape return behavior.

Accessibility proof covers no-color output, high contrast, reduced motion, Unicode, grapheme editing, and sanitized terminal input.

## User complaint ledger

| Complaint | Resolution | Proof |
| --- | --- | --- |
| The demo looked stale and toy-like. | The public demo runs the packed product against real Pi and GLM-5.2. | `artifacts/demo/braid-live-pi.gif` |
| The screen hid profile, model, runner, and connection identity. | Stable chrome shows the admitted profile, Pi runner, GLM-5.2 model, and Local CLI Bridge. | `artifacts/demo/braid-live-pi.png` |
| The demo prompt did not prove useful coding work. | Pi completes a Unicode slug task and passes 17 of 17 external workspace tests. | `artifacts/demo/braid-live-pi.json` |
| The `/ask` overlay lacked structure. | One divided, full-screen activity browser replaces stacked analysis overlays. | `artifacts/verification/w6/states/analysis.png` |
| Back navigation was unclear. | Left arrow and Escape perform the same return action. | `test/workflow-components.test.ts` |
| Analysis calls and costs were opaque. | The browser shows all six calls, tokens, latency, observed cost, and estimated cost separately. | `artifacts/demo/braid-live-pi.gif` |
| Worker and direct-run usage could be mixed. | Direct, analysis, and worker totals remain separate. | `test/terminal-usage.test.ts` |
| A single analysis page omitted evidence. | The GIF visits every page, while the static hero keeps the strongest first page. | `scripts/live-demo.test.mjs` |
| Native runner attachment looked complete when it was not. | The action stays capability-bound and names runtime issue 773. | `docs/04-runtime-contracts.md` |
| Tool activity could be invented from plain text. | Braid reports zero normalized tools and names runtime issue 762. | `artifacts/demo/braid-live-pi.json` |

## Decisions and rejected alternatives

| Decision | Selected | Alternative 1 | Alternative 2 | Reason |
| --- | --- | --- | --- | --- |
| Renderer | Published Pi TUI package | Copy a complete runner application | Rewrite with OpenTUI | Pi supplies mature primitives without taking runtime ownership. |
| Activity navigation | Context rail plus full browser | Layered modal stack | Permanent wide sidebar | One projection works at every width and keeps transcript space. |
| Public demo | Packed Braid through CLI Bridge and Pi | Fixture-only recording | Static mock | The real route proves identity, execution, analysis, and accounting together. |

## Measured proof

| Check | Result |
| --- | --- |
| Repository check | 610 passed, 0 failed, 2 protected checks skipped |
| Performance checks | 15 passed, 0 failed |
| Live-demo checks | 18 passed, 0 failed |
| Real coding task | 17 passed, 0 failed |
| Visual states | 11 of 11 captured |
| Reference terminal sizes | 4 of 4 captured |
| Real analysis evidence | 6 of 6 calls retained across 2 pages |
| Package identity | SHA-256 `32dda757d252bff4e120a8c69d776cb76b3ee971e3f2649d661875e77a20f7b8` |

## Remaining external limits

[`agent-runtime` issue 762](https://github.com/tangle-network/agent-runtime/issues/762) must expose incremental normalized tool events.

[`agent-runtime` issue 773](https://github.com/tangle-network/agent-runtime/issues/773) must expose exact execution and worker attachment.

Protected Tangle inference and sandbox checks require their real credentials and service paths.

These limits are visible and fail closed.

They do not change the proven local Pi and CLI Bridge product path.

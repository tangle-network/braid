# Terminal UI base hypothesis

Date: 2026-08-01

Decision owner: Braid

Status: accepted for implementation, with explicit reversal checks

## Question

Which existing terminal interface gives Braid the fastest path to a polished multi-run agent product without importing a second execution architecture?

## Constraints that decide the answer

1. `AgentProfile` must remain the portable definition of an agent.
2. `agent-runtime` and provider packages must remain responsible for execution, replay, cancellation, sessions, and cloud workspaces.
3. The terminal layer must support streaming updates, overlays, a full editor, narrow terminals, Unicode, IME input, deterministic tests, and alternate-screen rendering.
4. Braid needs generalized questions, permissions, plan review, forks, trace analysis, and worker graphs rather than one runner's private event types.
5. Source reuse must be MIT-compatible and maintainable against an identifiable upstream.
6. A copied application must be cheaper to decouple than a small application shell is to build.

## Evidence collected

All line counts below were measured from tracked TypeScript source at the named commit and exclude generated files.

| Source | Measured surface | Result | Architectural finding |
| --- | --- | ---: | --- |
| Pi `a6f7317` | `packages/tui/src` | 14,184 lines | Small standalone renderer with editor, overlays, public terminal interface, Unicode, and image support; its virtual-terminal helper is test-only and not published |
| Pi `a6f7317` | coding-agent interactive mode | 16,925 lines | Polished behaviors, but its 6,125-line coordinator is coupled to Pi sessions, models, and auth |
| Kimi Code `e22479a` | `apps/kimi-code/src/tui` | 39,688 lines | Strong controller/component split and interaction dialogs, but 65 files reference Kimi SDK concepts |
| OpenCode `32f278b` | `packages/opencode/src/cli/cmd/run` | 18,492 lines | Rich OpenTUI/Solid application coupled to OpenCode's server and Effect-based application stack |
| `agent-runtime` `9b2005d` | `src/tui` | 1,657 lines | Useful runtime-owned supervisor read model, but only a narrow raw-ANSI monitor |
| Hermes Agent `f88ed6c` | `ui-tui` package | Not used as a size claim | Clean client/runtime precedent, but React/Ink plus a Python JSON-RPC runtime is the wrong execution stack for Braid |

The Pi TUI package is independently published as `@earendil-works/pi-tui@0.83.0` under MIT.

Kimi Code vendors an older Pi TUI lineage and adds useful fixes, but its fork is not published as a standalone npm package.

The current runtime supervisor interface is intentionally coupled to runtime-owned state and should be imported as a data/control feature rather than treated as Braid's application shell.

## Ranked candidates

Scores use five dimensions from 1 to 5, where 5 is best.

| Rank | Candidate | Time to useful shell | Decoupling | Terminal quality | Maintenance | Contract fit | Total / 25 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Depend on Pi TUI and build a thin Braid shell, selectively adapting Pi/Kimi components | 5 | 5 | 5 | 4 | 5 | 24 |
| 2 | Build a new OpenTUI application inspired by OpenCode | 3 | 4 | 5 | 4 | 4 | 20 |
| 3 | Strip Kimi Code down to Braid | 4 | 1 | 5 | 2 | 2 | 14 |
| 4 | Port Hermes Agent's React/Ink client | 3 | 2 | 4 | 2 | 2 | 13 |
| 5 | Grow `agent-runtime-top` into the whole product | 2 | 3 | 2 | 4 | 1 | 12 |

## Hypothesis 1: Pi renderer plus a Braid application shell

Mechanism: use Pi's standalone terminal primitives while replacing its application coordinator with Braid controllers over shared Tangle contracts.

Expected effect: the first complete editor, viewport, overlay, and resize experience arrives without importing Pi's agent loop or native session model.

Implementation cost: one small TypeScript application, adapter ports, and selective component adaptation with attribution.

Primary risk: a required terminal behavior may exist only in Pi's coding-agent layer or Kimi's private fork.

Killer test: a vertical slice must render a 10,000-event transcript, edit Unicode text, open a searchable overlay, resize between 40×12 and 200×60, and drive the same reducer through JSONL headless mode.

Reversal condition: abandon the package dependency only if two or more required primitives cannot be implemented or upstreamed without maintaining invasive patches to Pi TUI.

## Hypothesis 2: OpenTUI application

Mechanism: use OpenTUI's retained-mode renderer and Solid bindings to create a fresh Braid client.

Expected effect: rich component composition and a modern rendering model.

Implementation cost: adopt Bun/Solid/OpenTUI conventions and rebuild editor, interaction, and test behavior that Pi already exposes as a small package.

Primary risk: Braid inherits a larger application stack without receiving OpenCode's application components cleanly.

Killer test: reproduce the vertical slice with fewer Braid-owned lines and equal Unicode/IME behavior than the Pi candidate.

Reversal condition: promote this candidate if Pi TUI fails the vertical slice or its upstream becomes unmaintained before the first public release.

## Hypothesis 3: Kimi Code application fork

Mechanism: remove Kimi SDK, session, model, command, and authentication dependencies from Kimi's complete terminal application and replace them with Braid ports.

Expected effect: preserve highly polished dialogs and queues with less visual design work.

Implementation cost: untangle a 39,688-line application in which 65 terminal files refer to Kimi SDK concepts, then carry a long-lived fork.

Primary risk: hidden product assumptions survive the port and turn Braid into a disguised Kimi client.

Killer test: replace every Kimi runtime import while preserving its interaction tests and produce a dependency graph with no reverse edge from a view to execution.

Reversal condition: use only selective components unless an automated decoupling experiment proves that a whole-app fork has a smaller maintained diff than the thin shell.

## Hypothesis 4: Hermes Agent client fork

Mechanism: adapt Hermes Agent's React/Ink terminal client and replace its Python JSON-RPC endpoint with Braid's runtime port.

Expected effect: reuse proven permission, session, queue, branch, and subagent flows.

Implementation cost: carry React and an Ink fork while translating a runtime protocol designed around Hermes.

Primary risk: two indirection layers remain after removing the Python side, with no advantage over Pi's direct TypeScript renderer.

Killer test: show a smaller production dependency and render cost than the Pi candidate while retaining the same editor and resize behavior.

Reversal condition: retain as a workflow reference unless its client becomes a standalone protocol-neutral package.

## Hypothesis 5: expand the runtime monitor

Mechanism: add chat, editor, overlays, profiles, interactions, and graph navigation directly to the raw-ANSI runtime monitor.

Expected effect: minimal initial dependency count.

Implementation cost: recreate a terminal framework and merge product state into a runtime diagnostic surface.

Primary risk: runtime and product ownership collapse, making both harder to evolve and test.

Killer test: no valid test is expected to beat the renderer candidate because the architectural boundary is itself wrong.

Reversal condition: none unless Braid's product scope is reduced to a read-only runtime monitor, which contradicts the product contract.

## Decision

Implement Hypothesis 1.

Pin the exact current Pi TUI package version, build Braid's own state and controller layer, and selectively adapt only presentation or interaction code from Pi and Kimi Code.

Run the vertical-slice killer test before adapting a large component set.

Record every upstream source and local patch so the dependency can be updated or replaced without changing Braid's execution contracts.

## Unknowns to resolve during the vertical slice

- Whether Pi TUI's main-screen mode is stable enough for the optional scrollback-friendly interface.
- Whether terminal image support should be enabled by default or only after a capability probe.
- Whether Kitty keyboard reporting conflicts with any supported remote terminal.
- Whether the published package contains every Kimi fork fix Braid needs for wide characters and rapid resize.
- Whether native SQLite packaging materially increases install failures on any release platform.

None of these unknowns changes the execution boundary.

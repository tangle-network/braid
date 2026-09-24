# Braid 0.3.0 release notes

## Added

- **Retained multi-session terminal (#35).** Several conversations can stream at once.
  The Work Strip lists each active, queued, waiting, or detached run with its runner, model, and actions.
  `/activity` opens a full-screen browser.
  Focus changes never pause, cancel, or reassign another run.
- **Detach and reconnect for retained Tangle Sandbox runs (#35).** `/detach` leaves a run working in the cloud.
  `/reconnect` resumes the stream from the saved cursor, and `/reconcile` refreshes a run from provider state.
- **Native terminal passthrough (#35).** `/interactive <prompt>` and `/attach [run-id]` open the runner's own terminal UI inside a retained Tangle Sandbox session.
  Press Ctrl+] to return to Braid.
- **Confidential workspace fork request (#39).** `/fork --workspace --confidential <JSON>` asks for an attested confidential destination.
  Braid refuses the fork when the provider cannot prove confidential placement; it never downgrades to an ordinary fork.
  The current Tangle provider (1.6.0) reports no confidential placement, so today this request is always refused.
- **Tangle router attribution (#64).** Requests that Braid sends to the Tangle router carry `x-tangle-client: braid/<version>`.

## Fixed

- Retained Tangle runs no longer end `unknown` when the production sidecar ends a replay with an unnumbered terminal frame (#61).
- A failed retained run now records the provider's exact error, reason, and usage (#62).
- Braid exits cleanly after you detach a retained run and press Ctrl+C twice (#56).
- A CLI Bridge refusal during a retained start now reports the failure without terminating Braid (#66).
- `/reconnect` now acknowledges a retained Tangle run with a pending question after Braid restarts (#70).
  The stream stays active while the user answers it.
- Trace analysis resolves its pinned analysis runtime again (#45).
- A bare slash command submits on the first Enter while its completion row is visible (#39).
- Pi first-run validation sends the total token cap supported by CLI Bridge (#72).
- Selecting a completed run or switching to a focused run now opens the intended conversation (#73, #74).
- One-time Pi tool permission grants send the selected value the runner expects (#75).
- Trace analysis preserves large source ranges, accepts Pi responses without optional model metadata, and closes one-shot native analyst sessions (#78, #79, #82).
- Trace analysis includes its pinned RPC release in managed cutoff checks and honors profiles with only a total output-token limit (#76, #84).
- `/ask` retrieves exact spans from long Pi traces and reads normalized file-write inputs (#86, #88).
  It checks the latest completed test result before citing source or tests.
- Pi connection setup bounds its total validation time (#85).

## Changed

Braid pins this dependency set: agent-interface 2.11.0, agent-runtime 0.252.1, agent-provider-tangle 1.6.0, agent-provider-cli-bridge 1.1.0, sandbox 0.45.0, agent-eval 0.183.0 (#36, #38, #40, #43, #49, #61).
The release also includes CLI Bridge proof fixes and a verified Pi-to-Codex handoff (#67, #68).

## Upgrade notes

- When npm lists 0.3.0, install with `npm install --global @tangle-network/braid@0.3.0`.
  Node.js 22.19 or newer is required; Linux and macOS only.
- **Upgrade from 0.2.2 if you use Tangle Sandbox.** Since 2026-09-17 the production sidecar ends every replay with a terminal frame that has no event id.
  0.2.2 bundles agent-provider-tangle 0.13.1, which throws `Tangle session event arrived without a stable id` on that frame.
  The production sidecar fix (agent-dev-container #7817) is deployed as of 2026-09-23.
  0.3.0 also accepts the frame, so its replay path does not depend on that sidecar fix.
- New Tangle Sandbox connections are ephemeral: one turn, then the environment is deleted.
  Retained runs need `"providerOptions": {"lifecycle": "retained", "idleTtlSeconds": 1800}` on the connection in `.braid/config.json`.
  First-run setup cannot create a retained connection yet.

Tangle Sandbox and Tangle Inference need a Tangle key.
[Create a Tangle account and key](https://sandbox.tangle.tools/?utm_source=github&utm_medium=release&utm_campaign=braid-0.3.0&ref=braid) before selecting either connection.

## Current limit

- Tangle Sandbox currently reports no confidential placement capability, so Braid refuses confidential workspace forks.

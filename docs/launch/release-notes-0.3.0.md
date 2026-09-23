# Braid 0.3.0 release notes (draft)

> Draft for Drew's review. Not published.
> Status on 2026-09-23: `@tangle-network/braid@0.3.0` is not on npm; `latest` is still `0.2.2`.
> The release workflow holds publication until the protected live evidence passes.
> Candidate run [35850968583](https://github.com/tangle-network/braid/actions/runs/35850968583) passed Linux x64 and macOS arm64 install smoke tests.
> Protected Live Evidence run [35912417993](https://github.com/tangle-network/braid/actions/runs/35912417993) passed LIVE-08, LIVE-09, and LIVE-10. LIVE-06 and LIVE-07 were unavailable because the protected configuration lacked required keys.
> A newer [run 35914271870](https://github.com/tangle-network/braid/actions/runs/35914271870) stopped at the LIVE-06 proof's cancellation-capability check. The full gate remains open.

Braid 0.3.0 covers pull requests #35 through #68 (0.2.2 shipped #31 through #34).

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
- Trace analysis resolves its pinned analysis runtime again (#45).
- A bare slash command submits on the first Enter while its completion row is visible (#39).

## Changed

Braid pins this dependency set: agent-interface 2.11.0, agent-runtime 0.252.1, agent-provider-tangle 1.6.0, agent-provider-cli-bridge 1.0.3, sandbox 0.45.0, agent-eval 0.183.0 (#36, #38, #40, #43, #49, #61).
The release also includes CLI Bridge proof fixes and a verified Pi-to-Codex handoff (#67, #68).

## Upgrade notes

- Install with `npm install --global @tangle-network/braid@0.3.0` after it publishes. Node.js 22.19 or newer is required; Linux and macOS only.
- **Upgrade from 0.2.2 if you use Tangle Sandbox.** Since 2026-09-17 the production sidecar ends every replay with a terminal frame that has no event id.
  0.2.2 bundles agent-provider-tangle 0.13.1, which throws `Tangle session event arrived without a stable id` on that frame.
  The production sidecar fix (agent-dev-container #7817) is deployed as of 2026-09-23.
  0.3.0 also accepts the frame, so its replay path does not depend on that sidecar fix.
- New Tangle Sandbox connections are ephemeral: one turn, then the environment is deleted.
  Retained runs need `"providerOptions": {"lifecycle": "retained", "idleTtlSeconds": 1800}` on the connection in `.braid/config.json`.
  First-run setup cannot create a retained connection yet.

Tangle Sandbox and Tangle Inference need a Tangle key: `<signup URL>`.

## Current limit

- Tangle Sandbox currently reports no confidential placement capability, so Braid refuses confidential workspace forks.

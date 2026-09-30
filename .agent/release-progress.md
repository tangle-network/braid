# Braid 0.3.4 release progress

## Goal

Deliver the exact reviewed Braid 0.3.4 candidate through protected live evidence, authorized publication, registry-byte verification, and installed-consumer proof.
Keep provider outcome separate from CLI correctness.

## Current candidate

- Candidate source commit: `3b627e9199186ccfb523f07d8c52effe02e46281` on `main`.
- Candidate Release workflow: run `36562109729`, successful.
- Candidate artifact: `11029649998`; endorsement artifact: `11030732466`.
- Archive: `/tmp/braid-release-3b627e-official/candidate/tangle-network-braid-0.3.4.tgz`.
- Archive SHA-256: `f13e3bea3bbdda567cc125cde9cbbe1889625e0972fa2303da17210c47e102d9`.
- Package manifest digest: `dbc7574683f08e95d2a6a01353421ebc4408250108671e169b92e1a52cc642c2`.
- Exact source, build, `pnpm check`, `pnpm release:prepare`, endorsement, Linux x64 smoke, and macOS arm64 smoke passed in run `36562109729`.
- The candidate source has not passed the formal protected live workflow identity step. Local `verify-candidate-identity.mjs` preflight passed at `/tmp/braid-0.3.4-delivery-20260929/candidate-identity-preflight.log`.
- `release-live-evidence.yml` runs identity verification immediately before live collection and has no preflight-only mode. No protected live run has been started for this candidate.
- `scripts/` is excluded from the npm archive. The current CLI proof helper edits do not alter this candidate tarball.

## Maintained CLI proof

- Reproduced the SQLite descriptor-open failure on the parent scratch: 1 of 20 security tests failed at the third native open. The fix passed 20 of 20 security tests, 200 of 200 scoped sibling tests, and the candidate build. Logs: `/tmp/braid-0.3.4-delivery-20260929/fixed-security.log` and `/tmp/braid-0.3.4-delivery-20260929/candidate-build.log`.
- Exact packed archive consumer check passed on Node `v22.23.2`: 37 RPC records and 31 events at 40x12, 80x24, 120x40, and 200x60, with flow parity and terminal restoration. Command: `BRAID_RELEASE_TARBALL=/tmp/braid-release-3b627e-official/candidate/tangle-network-braid-0.3.4.tgz node scripts/verify-package.mjs --record /tmp/braid-0.3.4-delivery-20260929/installed-package-proof-node22.json`. Log: `/tmp/braid-0.3.4-delivery-20260929/installed-package-proof-node22.log`.
- Installed exact candidate binary: `/tmp/braid-3b627e-installed/node_modules/@tangle-network/braid/dist/bin/braid.js`, version `0.3.4`.
- Final installed CLI proof command pattern: `taskset -c 12-15 nice -n 19 env PATH=/home/drew/.nvm/versions/node/v22.23.2/bin:$PATH BRAID_PROOF_COLUMNS=<columns> BRAID_PROOF_ROWS=<rows> BRAID_PROOF_CAST=artifacts/verification/braid-0.3.4/media/<size>-original.cast node scripts/proof-cloud-setup-cli.mjs /tmp/braid-3b627e-installed/node_modules/@tangle-network/braid/dist/bin/braid.js`.
- All four dimensions passed on the exact installed binary, version `0.3.4`. Each harness and both CLI processes exited 0. Logs, PIDs, media, and marker timing are recorded in `artifacts/verification/braid-0.3.4/media/media-manifest.json`.

| Terminal size | Harness PID | CLI PIDs | Log | Original / 4x copy |
| --- | ---: | --- | --- | --- |
| 40x12 | 2354201 | 2355008, 2359249 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-media-final-40x12.log` | `40x12-original.cast` / `40x12-4x.cast` |
| 80x24 | 2354270 | 2354676, 2359098 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-media-final-80x24.log` | `80x24-original.cast` / `80x24-4x.cast` |
| 120x40 | 2354245 | 2354900, 2358716 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-media-final-120x40.log` | `120x40-original.cast` / `120x40-4x.cast` |
| 200x60 | 2354233 | 2354723, 2358797 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-media-final-200x60.log` | `200x60-original.cast` / `200x60-4x.cast` |

- Each loopback run captured 26 requests, two tasks with five bounded sandbox-create attempts apiece, final statuses `unknown`, persistence after encrypted reopen, continuation refusal with no creates or run/message changes, exact rejected-draft clearing, fresh `/new` transcript, and temporary-state cleanup.
- Both task submissions observed authenticated GETs to `/v1/backends`, `/v1/me`, `/usage`, and `/subscription` before the first sandbox-create POST. The continuation attempted only those four authenticated read-only GETs.
- Credential canaries were absent from request URLs, bodies, non-Authorization headers, snapshots, and terminal output. No cloud task or resource was created.
- Uncut originals use asciicast v2 output events and labeled process-start/exit markers. The `-4x.cast` copies preserve event order and payloads while dividing timestamps by four. All copies were compared event-by-event; each contains 141–221 events and no input events.
- The casts omit key events, but terminal output can display the synthetic prompt text. Each output is a private mode `0600` file created at a new path. Media playback with `asciinema play --speed=1 artifacts/verification/braid-0.3.4/media/120x40-4x.cast` exited 0.
- This is a local CLI and storage proof with a loopback fixture. It is not proof of live Tangle execution or provider behavior.
- Luna's final independent read-only review found no remaining helper or recording findings. Media index: `artifacts/verification/braid-0.3.4/media/README.md`.

## Protected live evidence

- Protected run `36551284049`, source `4ad0a8992b60f282ae80c63744ea504cda1132ca`, admitted Braid run `run-1cadda3e-a8eb-4c71-8867-8f4b2681f5ac` for `glm-5.3` and ended `RUNTIME_FINAL_ERROR`.
- The live span ended about 2.497 seconds after send acknowledgement; workflow failure surfaced about 5.308 seconds after send. `LIVE-07` through `LIVE-10` had no spans.
- Retained evidence does not include a provider HTTP status/body, generation ID, usage, cost, or resource-cleanup census. The provider result and cleanup outcome are unknown; do not label this a confirmed refusal or a pass.
- Existing Router diagnostics under `security@tangle.tools` queried the four-second window `2026-09-29T09:46:46Z` to `2026-09-29T09:46:50Z`. The filtered and unfiltered admin queries returned zero rows; both Router origins had no matching app log lines. These empty results do not establish whether the provider request occurred.
- The October 5 Codex quota belongs to the superseded `hello@tangle.tools` docs session. It does not describe the active root or explain the GLM provider result. Inbox note `root-braid034-quota-distinction-20260930T0017` was read and acknowledged.
- No existing authorized bounded provider path is identified. Do not buy credits, raise caps, add keys, run uncapped inference, waive required live outcomes, or start a workflow that enters live collection without that path.

## Publication and deployment

- Public npm and GitHub release remain `0.3.3`.
- No `0.3.4` package publication, registry archive comparison, installed registry consumer proof, or deployment has occurred.
- Do not publish until the exact candidate has complete protected live evidence, including required cleanup proof.
- After release authorization is satisfied, publish the exact candidate archive, compare the registry tarball bytes and provenance, install that registry artifact on supported Linux and macOS targets, and retain consumer receipts.
- Rollback before publication is to leave `latest` unchanged. After publication, restore the prior release only through the maintained release procedure; do not mutate the candidate archive.

## Ownership and next action

- Root owns Braid source integration, helper changes, release record, PR, and publishing surfaces.
- `braid-claude` retains its separate acquisition/prewarm/G1 lane. The closed docs lane is superseded. Preserve canonical `.agent` edits and peer work.
- `proof_review_luna` completed read-only independent review of the helper and recordings; no concrete findings remain.
- `release_zerospend_luna` completed release workflow and candidate audit. `glm_owner_status_luna` completed the read-only Router diagnostic.
- `security@tangle.tools` performed the Router lookup. The provider-account log owner remains unidentified; the missing input is a retained provider trace/status/usage record and an already authorized bounded path for the exact protected live gate.
- The source helper/release record/media changes are reviewed and ready for a single source PR. Run normal hooks, commit, fetch and merge-check against `origin/main`, open that PR with `gh-drew` identity `drewstone`, resolve applicable review findings, and merge normally.
- Release publication and registry proof remain pending until the missing protected live evidence path is available.

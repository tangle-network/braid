# Braid 0.3.4 release progress

## Goal

Deliver the exact reviewed Braid 0.3.4 candidate through protected live evidence, authorized publication, registry-byte verification, and installed-consumer proof.
Keep provider outcome separate from CLI correctness.

## Current candidate

- Candidate source commit: `88a0fcfc46977c8ed2b6c5d3f4da43688d8bf7fe` on `main`, including the reviewed dependency update from PR #119.
- Candidate Release workflow: run `36666003696`, dispatched against that exact SHA with `publish=false` and no live-evidence run ID; completed successfully.
- Candidate artifact `11076377093` and endorsed artifact `11075679255` identify this run. The endorsed artifact digest is `sha256:c93dc6fe395e0c0149609c9489475797fc0293f15ad411b1d7dfb0288a99e9d0`.
- Exact candidate archive SHA-256: `c76f4be3f1c00ca158d1e8b2bd4ac65e4be418f339601d1d544333b8c9763e06`.
- Candidate and endorsed tarballs independently hash to that same exact archive SHA-256. Linux smoke artifact `11076720017` and macOS arm64 smoke artifact `11075274879` also record that digest and report successful plain flow, encrypted storage, and temporary-state cleanup.
- Package file manifest digest: `c34276ab0c8a4fcf4272be5a366e70c1edf038ee62b0fe875b95289ca39d5ca0`; package `package.json` SHA-256: `f6a4fd86db74038301f380e0f24d936aa7615a11a7be8ba0a9e01534a2baf21f`.
- The signed endorsement index SHA-256 is `b53595dd1d71ef4c2448afd63ee20d5b5b13e1f643124df73ae044e5de2fdc8b`; signature verification and `sha256sum -c endorsement/candidate/files.sha256` passed after extraction.
- The candidate artifact retention is seven days, through `2026-10-07T03:47:45Z`; retain the reviewed proof before expiry.
- The prior candidate run `36562109729` built source `3b627e9199186ccfb523f07d8c52effe02e46281`; its artifact `11029649998` and archive hash `f13e3bea3bbdda567cc125cde9cbbe1889625e0972fa2303da17210c47e102d9` are historical and do not identify this candidate.
- PR #119 merged normally as `88a0fcfc46977c8ed2b6c5d3f4da43688d8bf7fe`. Required CI run `36665326937` passed all four jobs on reviewed head `af1e4f61604ca57c7d621fe0b588390e123515d8`, including source and installable-package verification.
- Candidate job `109730700059`, endorsement job `109732181532`, hosted Linux x64 smoke `109732217421`, and hosted macOS arm64 smoke `109732217383` all passed in run `36666003696`.
- `verify-live-10`, publish, post-publish smoke, final endorsement, and tag/report jobs were skipped because this candidate-only run used `publish=false`; this is not a failed check or a live result.
- The formal protected live workflow has not run for source `88a0fcf`. Local `verify-candidate-identity.mjs` preflight for old source `3b627e9` does not satisfy this gate.
- `release-live-evidence.yml` runs identity verification immediately before live collection and has no preflight-only mode. Do not dispatch it without an existing authorized bounded provider path.
- Hosted macOS smoke ran in GitHub Actions; no local Mac build or install was performed.
- The exact archive's packed and installed CLI proofs are complete below; they use the new dependency cohort and supersede earlier package evidence for delivery claims.

## Dependency update and CI

- PR #119 aligned `@tangle-network/agent-provider-cli-bridge` to `1.1.1`, `@tangle-network/agent-interface` to `2.13.1`, and Undici to `8.11.2`; it also rejects unsupported workspace checkpoint requests before snapshotting or provider dispatch.
- Luna independently reviewed the dependency, source, test, and documentation diff and found no remaining findings. GitHub showed `APPROVED`; no inline review comments remained.
- CI run `36665326937` passed `verify`, macOS and Windows process cleanup, and portable storage. The source and installable-package verification ran 6m41s.
- Local full `pnpm check` passed format, lint, typecheck, boundary, dependency/security, attribution, license, and 911/913 regular tests (two skipped), but the 10k-worker changed-revision performance test reported p90 `658.2ms` against `250ms`. The performance gate and source were not changed; host contention remains a hypothesis.
- Credential-stripped `test:live:required:self` passed 170/170, fake-loopback Live Bridge matrix passed, `check:release` passed four registry-collision tests, and the checkpoint regression passed 8/8. Their receipts are in the fleet status record and `/tmp/braid-0.3.4-delivery-20260929/`.

## Exact candidate package and installed CLI proof

- The endorsed tarball is `/tmp/braid-release-88a0fc-official/candidate/tangle-network-braid-0.3.4.tgz`, version `0.3.4`, built from `88a0fcfc46977c8ed2b6c5d3f4da43688d8bf7fe`.
- The endorsed artifact signature verified, and every file matched its signed manifest. The tarball SHA-256, package manifest digest, package JSON hash, artifact IDs, and endorsement index hash are recorded above and in `artifacts/verification/braid-0.3.4/media/88a0fc/media-manifest.json`.
- Exact packed consumer command: `BRAID_RELEASE_TARBALL=/tmp/braid-release-88a0fc-official/candidate/tangle-network-braid-0.3.4.tgz node scripts/verify-package.mjs --record /tmp/braid-0.3.4-delivery-20260929/packed-package-proof-88a0fc.json`.
- It passed on GTR Linux x64 with Node `v22.23.2`: 37 RPC records; 31 events at 40x12, 80x24, 120x40, and 200x60; all RPC, terminal, and plain-text flows matched. Alternate-screen and SIGINT restoration, symlink-safe state writes, keyboard-to-RPC mapping, and event-ledger matching passed.
- Packed proof record SHA-256 is `aa5aece0d92211e30e34d81f3e3ddee3279d104cc4767eb5ccbba2babd9c0bbe`; source digest is `ae40782803c05cdca6ca298b50af9398d607756db2e2ee911638157a1e8bdb02`. Log and record paths are in the media manifest.
- Installed the exact archive at `/tmp/braid-88a0fc-installed` with npm, then ran `scripts/proof-cloud-setup-cli.mjs` against its installed `dist/bin/braid.js`, under `taskset -c 12-15 nice -n 19` and Node `v22.23.2`.
- At all four terminal sizes the real installed CLI completed setup A to B to A, loopback RPC, encrypted-state reopen, persistence of the task message, continuation refusal, and temporary-state cleanup. Each harness captured 26 loopback requests; both CLI processes exited `0`; all five task-write attempts per task received loopback refusal, both run statuses and the reopened status remained `unknown`, and no cloud task or resource was created.
- The continuation read only `/v1/backends`, `/v1/me`, `/usage`, and `/subscription`; it did not mutate runs or messages. Rejected continuation text remained in the draft and then cleared. Credential canaries were absent from request URLs, bodies, non-Authorization headers, snapshots, and terminal output.

| Terminal size | Harness PID | Installed CLI PIDs | Log |
| --- | ---: | --- | --- |
| 40x12 | 353091 | 353293, 357587 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-88a0fc-40x12.log` |
| 80x24 | 372430 | 372513, 375857 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-88a0fc-80x24.log` |
| 120x40 | 382154 | 382475, 388549 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-88a0fc-120x40.log` |
| 200x60 | 403028 | 404425, 409179 | `/tmp/braid-0.3.4-delivery-20260929/installed-cli-setup-loopback-88a0fc-200x60.log` |

- Uncut originals and labeled 4x copies for all four terminal sizes are under `artifacts/verification/braid-0.3.4/media/88a0fc/`; each copy preserves event order, output, and process markers while dividing timestamps by four.
- `asciinema play --speed=1 artifacts/verification/braid-0.3.4/media/88a0fc/120x40-4x.cast` displayed successfully and exited `0`. The casts are terminal output, not videos, and contain no input events.
- This is exact-package CLI and storage evidence against a loopback refusal fixture. It establishes no live provider response, cloud task, resource creation, or provider cleanup outcome.

## Previous candidate CLI proof — superseded source

The proofs below are bound to source `3b627e9199186ccfb523f07d8c52effe02e46281` and its old dependency cohort.
They remain useful historical CLI evidence, but they do not establish the correctness of the new `88a0fcf` package.

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
- The earlier Luna helper and recording review found no findings for source `3b627e9`; that history is indexed at `artifacts/verification/braid-0.3.4/media/README.md`.
- The current exact-candidate media index is `artifacts/verification/braid-0.3.4/media/88a0fc/README.md`; Luna verified its archive, logs, process markers, cast hashes, and 4x event transformations with no other findings.

## Protected live evidence

- Protected run `36551284049`, source `4ad0a8992b60f282ae80c63744ea504cda1132ca`, admitted Braid run `run-1cadda3e-a8eb-4c71-8867-8f4b2681f5ac` for `glm-5.3` and ended `RUNTIME_FINAL_ERROR`.
- The live span ended about 2.497 seconds after send acknowledgement; workflow failure surfaced about 5.308 seconds after send. `LIVE-07` through `LIVE-10` had no spans.
- Retained evidence does not include a provider HTTP status/body, generation ID, usage, cost, or resource-cleanup census. The provider result and cleanup outcome are unknown; do not label this a confirmed refusal or a pass.
- Existing Router diagnostics under `security@tangle.tools` queried the four-second window `2026-09-29T09:46:46Z` to `2026-09-29T09:46:50Z`. The filtered and unfiltered admin queries returned zero rows; both Router origins had no matching app log lines. These empty results do not establish whether the provider request occurred.
- The October 5 Codex quota belongs to the superseded `hello@tangle.tools` docs session. It does not describe the active root or explain the GLM provider result. Inbox notes `root-braid034-quota-distinction-20260930T0017` and `047d490dfe9844c391d458ee516124fc` were read and acknowledged.
- The `router-spend` reply confirms `glm-5.3` maps to direct Z.AI. Its admin and app-log queries found no matching rows, and no provider status/body, generation ID, usage, cost, or cleanup census was found. Empty logs do not prove that no provider request occurred.
- The only account-owner clue is completed ops-board task #303 for a Z.AI/GLM top-up; it does not identify a current console-log owner or retrieval path. No read-only trace export path, spend bound, or Sandbox cleanup authorization was found. The release-live environment has `BRAID_LIVE_TANGLE_ENV_JSON` and main-only branch policy, but secret validity and limits remain unverified. No secret was read and no live workflow or replay was started.
- No existing authorized bounded provider path is identified. Do not buy credits, raise caps, add keys, run uncapped inference, waive required live outcomes, or start a workflow that enters live collection without that path.

## Publication and deployment

- Public npm `latest` and GitHub latest release remain `0.3.3`; npm lookup for `@tangle-network/braid@0.3.4` returned E404, and GitHub has no `v0.3.4` release.
- No `0.3.4` package publication, registry archive comparison, installed registry consumer proof, or deployment has occurred.
- Do not publish until the exact candidate has complete protected live evidence, including required cleanup proof.
- After release authorization is satisfied, publish the exact candidate archive, compare the registry tarball bytes and provenance, install that registry artifact on supported Linux and macOS targets, and retain consumer receipts.
- Rollback before publication is to leave `latest` unchanged. After publication, restore the prior release only through the maintained release procedure; do not mutate the candidate archive.

## Ownership and next action

- Root owns Braid source integration, helper changes, release record, PR, and publishing surfaces.
- `braid-claude` retains its separate acquisition/prewarm/G1 lane. The closed docs lane is superseded. Preserve canonical `.agent` edits and peer work.
- `proof_review_luna` is independently reviewing the exact `88a0fc` candidate proof, manifest, and release claims; prior helper review found no concrete findings.
- `release_zerospend_luna` completed release workflow and candidate audit. `glm_owner_status_luna` completed the read-only Router diagnostic.
- `release_gates` independently confirmed the candidate and endorsed tarballs match the recorded SHA, both platform smokes use that archive, and no exact-candidate protected-live run has passed. It independently checked npm `latest` and GitHub latest at `0.3.3`; npm `0.3.4` returned E404.
- `security@tangle.tools` performed the Router lookup. The provider-account log owner remains unidentified; the missing input is a retained provider trace/status/usage record and an already authorized bounded path for the exact protected live gate.
- Root owns source and publishing surfaces; this isolated GTR worktree is on `docs/braid034-release-progress-20260930`, based on exact `main` candidate `88a0fcf`. Git identity remains the existing `drewstone329@gmail.com`; `gh-drew api user --jq .login` returned `drewstone`.
- The maintained release record and exact candidate media are being packaged into one evidence PR after independent review. Before push, fetch `origin/main`, verify `git merge-tree --write-tree origin/main HEAD`, run normal hooks, refresh PR comments/reviews/threads, and merge normally.
- Release publication and registry proof remain pending until the provider owner, retained trace path, bounded inference spend, and Sandbox cleanup authorization are established for the exact candidate.

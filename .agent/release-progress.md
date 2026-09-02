# Release Progress

## Release record

This file tracks one candidate and its matching public release cohort.
Populate every `not recorded` value from the same release artifact and verification run.
Do not copy a version, integrity value, or live result from an earlier cohort.

### Current release attempt

- Target: Braid release proof with confidential workspace-fork and cancellation-safety evidence.
- Environment: local safety worktree, GitHub Actions, and protected live checks.
- Live URL: none; Braid is not being published in this attempt.
- Live service/process: none; the package is a terminal client and has no deployed service.
- Artifact path: `artifacts/verification/w6` contains the tracked W6 frames and receipts.
- Rollback path: keep npm `latest` unchanged and close or revert the pull request.
- Credential files: protected CI secrets and `gh-drew`; no credential values enter the repository.
- Current branch: `fix/release-publish-live-audit-separation`.
- Current commit: `3225b620844b23ad04f86c3e90aaad333cd0f0e5` (`fix(fork): finalize confidential workspace fork UX`).
- Worktree state: dependency, source, test, and capture updates remain uncommitted; this ledger records no candidate artifact yet.
- Current gates: record the candidate commit, run exact-head CI, and obtain the latest review before merge; LIVE-10 separately blocks publication.

- Candidate Braid package and version: `@tangle-network/braid@0.3.0`
- Candidate Braid commit: `3225b620844b23ad04f86c3e90aaad333cd0f0e5` from the package proof; dependency and capture updates remain uncommitted in the worktree.
- Runtime package and version: `@tangle-network/agent-runtime@0.190.0`
- Sandbox package and version: `@tangle-network/sandbox@0.36.4` (current published version; `0.36.5` is not published or locked)
- Agent Interface package and version: `@tangle-network/agent-interface@2.3.0`
- Agent Eval package and version: `@tangle-network/agent-eval@0.173.0`
- Tangle provider package and version: `@tangle-network/agent-provider-tangle@1.1.3`
- Runtime artifact commit and tarball integrity: `not applicable; Braid consumes the published Runtime from the exact lockfile`
- Braid artifact tarball integrity: `sha256 cb51febdbd1f5ba9a98e7248a54142debf157de7098383db1784157922e9e0f2` from the current W6 capture manifest.
- Runtime rollback package and version: `not recorded`
- Braid rollback package and version: `not recorded`
- Registry and live-service environment: public npm and public Tangle services
- Release credentials: protected release environments and `gh-drew`

## Public dependency cohort

- Agent Interface: `2.3.0`; exact lockfile resolution is recorded.
- Agent Eval: `0.173.0`; exact lockfile resolution is recorded.
- Tangle provider: `1.1.3`; exact lockfile resolution is recorded.
- Sandbox: `0.36.4`; exact lockfile resolution is recorded. `0.36.5` is not published or locked.
- Runtime: `0.190.0`; exact lockfile resolution is recorded.
- Runtime package integrity: `not recorded; no Runtime artifact is built by Braid in this attempt`.
- Braid has no file, link, or workspace production dependencies: verify against the final lockfile before publication.

## Prior cohort record

The entries below describe the 2026-08-28 checkpoint only.
They are historical evidence and do not describe the current release candidate.

- Agent Interface `1.7.1` passed 478 of 478 tests before publication.
- Tangle provider `0.14.1` passed 170 of 170 tests before publication.
- Sandbox `0.34.0` came from merged commit `c2abc576520f6303fb26528391c706a150419a33`.
- Runtime `0.177.0` came from merged commit `4b6ff007`.
- Runtime package integrity was `sha512-6UYAtUEmhzluJYe6VL4ECKyNCQD0HAx9sch2W5BTcA5R/ddrlANy5jJ3Sq7TPmm07JeeMq3iolTEfrGgbDPQEw==`.
- Runtime provenance, tag, source, workflow, and isolated installation were verified after publication.

## Completed Product Work

- The Work Strip supports concurrent runs, explicit focus, switching, and targeted cancellation.
- Native continuation resumes the selected provider session.
- Cross-runner and cross-workspace forks create new branches without changing agent identity.
- Interaction views support typed answers, acceptance, decline, timeout, cancel, and restart recovery.
- Analysis freezes one run, records cited findings, and preserves promotion decisions.
- Supervisor views project the Runtime worker tree and route steer, cancel, and exact terminal attach.
- Braid suspends its screen during worker attach and delegates terminal transport to Runtime.
- All 51 exported terminal components map to 25 component documents.
- Every component document states its best simple general implementation.
- The UI captures 23 product states and three recorded keyboard flows across the required terminal sizes.

## Current proof record

Record each result with its candidate commit, command, date, and artifact path.
Use `not recorded` until the check runs against the release record above.

- Local package and terminal checks: current-working-tree `pnpm check` passed 1,070 tests, skipped 2 by contract, and failed 0 on 2026-09-02; the CLI Bridge adversarial matrix also passed.
- Visual captures: current `pnpm capture:visual` generated 134 artifacts across 23 states on 2026-09-02 with the locked provider `1.1.3` and Sandbox `0.36.4`; the manifest records the current 0.3.0 tarball and the fork-preview flow at 40×12, 80×24, 120×40, and 200×60.
- Packed keyboard flow: `pnpm test:pty` exited 0 and passed at 40×12, 80×24, 120×40, and 200×60 at `b96b7129d`.
- Provider and Sandbox LIVE-07 check: passed on 2026-09-01 with `pnpm run test:live:tangle:sandbox:multirun`; artifact `artifacts/verification/live/tangle-sandbox-braid-multirun-production-1788260107206.json`.
- Restart and concurrent-session checks: passed in the LIVE-07 artifact above; it proves two independent runs, focus in both directions, targeted cancellation, stable restart replay, two provider executions, and exact cleanup.
- Interaction checks: included in the final 896-test suite; 0 failures.
- Package-to-candidate comparison: clean generated tarball install passed in `pnpm capture:visual`; tarball sha256 `cb51febdbd1f5ba9a98e7248a54142debf157de7098383db1784157922e9e0f2`, binary sha256 `141288e0fe917635d723b4b70d464dc49baff14cc356f54de1d3f8faa5d8254f`.
- Dependency audit and source graph: final check found no high or critical production vulnerabilities; module graph had 519 modules, 2,693 edges, and 0 cyclic components.

The full-check, LIVE-07, and dependency-audit rows above were recorded against earlier candidate commits; the current capture and focused confidential checks are current-working-tree evidence.

## Confidential workspace-fork evidence

- Focused current-working-tree checks passed: `pnpm test -- --scope unit` passed 326 of 326 tests, `pnpm test -- --scope rpc` passed 39 of 39 tests, and `pnpm test -- --scope virtual-terminal` passed 161 of 161 tests; no release artifact was produced by these runs.
- Those checks cover canonical request parsing, TUI and headless propagation, plan-digest and request rechecks, capability gates, attestation verification, ordinary workspace fallback, and safe preview serialization.
- The installed Tangle provider `1.1.3` with Sandbox `0.36.4` narrows `branching.confidential` to `false` when the deployed job lacks snapshot-restore inputs; this is package behavior, not a live observation, and new confidential workspace forks are refused before child creation on that path.
- LIVE-10 therefore has no current live artifact; deterministic tests are not evidence of a live TEE provider path.

## LIVE-10 status record

- Current LIVE-10 result: blocked; real AWS Nitro infrastructure is unavailable, so Braid is not published.
- The installed provider cohort also blocks new confidential forks when the deployed job lacks snapshot-restore inputs; Braid keeps the request unavailable rather than downgrading it.
- Current evidence path and artifact: no candidate or live artifact; publication remains blocked by the missing real Nitro path.
- Previous observation from 2026-08-28: Base Sepolia chain `84532` had one active blueprint-12 binary and zero blueprint-12 services.
- Previous observation from 2026-08-28: The advertised operator endpoint did not complete TLS or expose the required API.
- Previous observation from 2026-08-28: The operator host was ARM64, while the published Nitro binary was x86_64.
- Previous observation from 2026-08-28: The host had no Nitro process, Nitro routing, or AWS deployment credentials.
- Previous observation from 2026-08-28: Production Sandbox had no Nitro driver allowlist or Nitro target configuration.
- Previous observation from 2026-08-28: Four temporary host-agent sandboxes were deleted and excluded from confidential proof.
- Release decision: block publication until LIVE-10 passes against the release record above.

## Current LIVE-07 evidence

- Production LIVE-07 passed on 2026-09-01 from the release worktree.
- The artifact records two independent conversations, concurrent streaming, bidirectional focus, targeted cancellation, restart replay, two provider executions, and exact cleanup with active resource delta `0`.
- The artifact is retained at `artifacts/verification/live/tangle-sandbox-braid-multirun-production-1788260107206.json`.

## Remaining Sequence

1. Re-read the newest PR CI and review state, fix valid findings, and merge the exact green head.
2. Keep Braid publication blocked until LIVE-10 passes against real AWS Nitro infrastructure, then compare any published package with its approved candidate.

## Decision

- Keep npm `latest` on the last verified release while any required live check is unavailable.
- Merge reusable product and proof improvements when their exact checks pass.
- Do not replace provider proof with fixtures, local Sidecar runs, or host-agent sandboxes.
- Do not describe an unavailable confidential path as shipped.
- Do not publish Braid while LIVE-10 lacks real AWS Nitro infrastructure.

## Timeline

- 2026-08-28: Proved retained Tangle reconnect after forced Braid process termination.
- 2026-08-28: Implemented multi-run focus, continuation, forks, interactions, analysis, and supervisor controls.
- 2026-08-28: Published Agent Interface `1.7.1`, Tangle provider `0.14.1`, Sandbox `0.34.0`, and Runtime `0.177.0`.
- 2026-08-28: Proved the public Sandbox Sidecar input, detach, reconnect, replay, and interaction flow.
- 2026-08-28: Proved two retained Tangle multirun cohorts with exact cleanup.
- 2026-08-28: Confirmed that Base Sepolia has zero blueprint-12 services and no reachable Nitro operator.
- 2026-09-01: Passed production LIVE-07 with two concurrent Tangle Sandbox runs, restart replay, targeted cancellation, and exact cleanup.
- 2026-09-01: Earlier safety candidate passed 319 of 319 unit tests before proof-worker integration.
- 2026-09-01: Cherry-picked proof-worker release binding at `56c5e5d80`.
- 2026-09-01: Added mutually exclusive confirmed and unavailable LIVE-06 receipt validation; focused receipt checks passed 115 of 115.
- 2026-09-01: Added the provider-reported cancellation-unavailable visual fixture and captured four required sizes plus the packed keyboard flow.
- 2026-09-01: Earlier safety candidate used Agent Interface `2.1.1` with registry integrity `sha512-xSQUErolqpQIz9/ZWU/Gzg9OjolR5L3dxgl2GsfK1z5DJbjBF5uWwhLjSctqSVv5R2kuEh1z6LXOW7U4PUN+lg==`.
- 2026-09-01: Earlier candidate `pnpm check` passed with 894 of 896 tests passing, 2 skipped, and 0 failures.
- 2026-09-02: Current dependency cohort uses Agent Interface `2.3.0`, Runtime `0.190.0`, Tangle provider `1.1.3`, and Sandbox `0.36.4`; Sandbox `0.36.5` remains unpublished.
- 2026-09-02: Focused confidential workspace-fork checks passed in the current working tree; LIVE-10 remained blocked by provider and Nitro infrastructure limits.

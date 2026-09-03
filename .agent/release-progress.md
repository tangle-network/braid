# Release progress

## Release record

This file tracks the active Braid candidate and its public dependency cohort.
Use only evidence from the named source commit or its immutable release artifacts.

### Current release attempt

- Target: publish `@tangle-network/braid@0.3.0` after exact candidate and protected Tangle checks pass.
- Source branch: `chore/braid-release-current-deps-final`.
- Source pull request: `tangle-network/braid#49`.
- Source code commit: `6097da09305f58fe051cb3b20308bba3f36e5cf4` passed local checks and CI run `33710389130`.
- Candidate commit: not recorded; the source pull request must merge first.
- Candidate archive: not recorded; the candidate Release workflow must complete first.
- Live evidence: not recorded; the protected workflow must use that candidate archive.
- Public package: not recorded; publication remains blocked until the live evidence passes.
- Runtime service: none; Braid is an installed terminal client.
- Credential boundary: protected GitHub environments provide release and live credentials.
- Rollback: leave npm `latest` unchanged before publication, or restore the prior release after publication.

## Public dependency cohort

| Package | Version | Evidence |
| --- | ---: | --- |
| `@tangle-network/agent-interface` | `2.3.0` | Exact package and lockfile entry |
| `@tangle-network/agent-eval` | `0.173.1` | Exact package and lockfile entry |
| `@tangle-network/agent-provider-cli-bridge` | `1.0.0` | Exact package and lockfile entry |
| `@tangle-network/agent-provider-tangle` | `1.1.4` | Exact package, lockfile entry, and SDK release |
| `@tangle-network/agent-runtime` | `0.192.2` | Exact package and lockfile entry |
| `@tangle-network/sandbox` | `0.37.0` | Exact package and lockfile entry |

`pnpm outdated --format json` returned `{}` on 2026-09-02.
The production graph contains 95 packages and no file, link, or workspace dependency.

The Tangle provider release is commit `446273812a4fb2c31552dbc16c48e0e4c7983495`.
Release run `33709902215`, exact-main CI `33709902283`, and upstream evidence run `33710001054` passed.
The npm package has a registry signature and SLSA provenance.

## Product state

- Braid is a terminal client over `agent-runtime`; it does not implement another runner.
- `AgentProfile` remains the only agent configuration object.
- The work strip supports concurrent runs, explicit focus, switching, and targeted cancellation.
- Native continuation resumes one selected provider session.
- Cross-runner and workspace forks preserve separate conversation, run, session, and environment identities.
- Interaction views support typed answers, acceptance, decline, timeout, cancel, and restart recovery.
- Analysis freezes one run, records cited findings, and preserves promotion decisions.
- Supervisor views use Runtime-owned observation, steering, cancellation, and terminal attachment.
- All 52 exported terminal components map to 25 component documents.
- Every component document states its best simple general implementation.
- The visual set covers 23 product states and all four required terminal sizes.

## Current proof

- Focused contract checks passed 239 of 239 tests with the final dependency cohort.
- The complete local `pnpm check` command exited successfully with the final dependency cohort.
- CI run `33710389130` passed all four jobs for pull request 49.
- Formatting checked 828 files.
- The module graph contains 519 modules, 2,693 edges, and zero cycles.
- The dependency check found no known vulnerability and no high or critical finding.
- The license inventory covers 64 packages.
- The CLI Bridge adversarial matrix passed.
- The exact provider 1.1.4 production import resolves through the Tangle Sandbox backend.

The previous candidate run `33705006807` passed source and platform checks for commit `871954e132fc153130b3a463d39ccfe8dc72151c`.
That candidate did not contain provider 1.1.4 and cannot authorize publication of the new cohort.

Live run `33702738417` reached the real Sandbox and exposed the old per-frame control-validation limit.
The sidecar accepted 95 validation calls and five other session calls before returning HTTP 429.
The SDK release above removes that redundant request from terminal input, resize, and close.
The failed run is diagnostic evidence, not release evidence.

## Remaining release sequence

1. Merge pull request 49 after its current checks and review pass.
2. Build one immutable candidate from the merged commit.
3. Pass Linux x64 and macOS arm64 candidate installs.
4. Run protected `LIVE-06` through `LIVE-10` against that candidate.
5. Require the separate two-conversation `LIVE-07` artifact and exact resource cleanup.
6. Publish only the approved candidate archive.
7. Verify the registry archive on Linux x64 and macOS arm64.
8. Verify npm provenance, the source tag, release assets, and matching archive digests.

## Decision

Do not publish from the source checkout.
Do not reuse evidence from an earlier dependency cohort.
Do not turn an unavailable provider result into a pass.
Do not leave a billable live resource after a proof run.

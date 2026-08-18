# Braid release-completion program map

> **Reconstruction notice.** This map was reconstructed by the N1 seeding arm from `README.md`,
> `docs/08-verification.md`, and `docs/09-delivery-plan.md` evidence, because the round-1
> original program documents were not handed to this arm. Completion authority remains
> `docs/08-verification.md` and `docs/09-delivery-plan.md` (`AGENTS.md:71`); priorities are
> defined in `braid-VISION.md`.

**Verified baseline:** tangle-network/braid main `3d7b79f` = tag `v0.1.3` = npm `0.1.3`;
warmup PR pipeline proven on agent-knowledge#140: PR #142 merged.

## Nodes

| Node | Arm | Mandate | VISION priorities |
| --- | --- | --- | --- |
| N1 | This arm (seed `factory/release-completion`) | Seed the integration branch from the pinned base `3d7b79f`, reconstruct and commit the program documents (`docs/program/`), and open the standing **draft** PR. | P4+P1 |
| N2 | Live-matrix arm | Close `LIVE-01`–`LIVE-12` with real-provider records and confirmed cleanup: strict bridge gate `pnpm test:live:bridge:release` (`LIVE-01`–`LIVE-05`), Tangle inference/sandbox/interaction/fork/confidential rows, supervisor, and `agent-eval` analysis; run the retained-sandbox canary-plus-cohort; resolve or honestly route the CLI Bridge issue 130 aggregate-run blocker (`docs/08-verification.md:360-425`, `:383-413`, `:423`, `:479-492`). | P2 |
| N3 | Measurement arm | Land the full `PERF-01`–`PERF-10` distributions (W12) and the calibrated `EVAL-01`–`EVAL-06` judge records (11-of-12 calibration, trivial baselines rejected) so VR-03/VR-07/VR-09 hold for the exact build (`docs/08-verification.md:318-350`, `:516-547`, `:600-611`, `:740`). | P3 |
| N4 | Publication arm | Execute W13 on the frozen main commit: `pnpm check`, `pnpm release:prepare`, isolated code-free Ed25519 endorsement, npm publish with provenance, registry smoke on Linux x64 and macOS arm64, publication record, tag (`docs/09-delivery-plan.md:396-428`; `docs/08-verification.md:352-358`, `:627-639`, `:694-696`). | P5 |
| N5 | Audit-close arm | Assemble the comprehensive audit on demand (not an npm prerequisite), confirm zero unresolved externally billable live resources, and walk the final definition of done (`docs/08-verification.md:615-720`; `docs/09-delivery-plan.md:489-505`). | P6 |
| Final | `swe-final-integration-pr` | Flip the N1 draft PR to ready and merge it into `main` once N2–N5 land. **The draft stays draft until this node.** | P4 |

## Rules

- The base is pinned at the charter sha `3d7b79f`; every arm rebases cleanly on `origin/main`
  before landing (freeze only after all feature changes merge, `docs/09-delivery-plan.md:467`).
- Every arm keeps `pnpm check` green on the branch (`README.md:296-316`).
- An unavailable required live provider blocks the release and is reported unavailable — never
  skipped or simulated (`docs/08-verification.md:381`).
- No requirement identifier is marked complete without exact-build evidence
  (`docs/08-verification.md:789`, VR-01).

# Braid release-completion VISION

> **Reconstruction notice.** This document was reconstructed by the N1 seeding arm from
> `README.md`, `docs/08-verification.md`, and `docs/09-delivery-plan.md` evidence, because the
> round-1 original program documents were not handed to this arm. Where a claim below rests on
> repository evidence, the source file and line range are cited. Completion authority is not
> this document: per `AGENTS.md:71`, release completion is defined only by
> `docs/08-verification.md` and `docs/09-delivery-plan.md`.

## Completion frame

Braid is complete only when one immutable release build passes every required check and one
machine-readable evidence manifest links each requirement identifier to reproducible evidence
(`docs/08-verification.md:3-15`), and the work is complete only at package publication and
post-publication verification (`docs/09-delivery-plan.md:3-9`). The final definition of done is
the checklist at `docs/09-delivery-plan.md:489-505`. This VISION orders the remaining work into
numbered priorities; the program map in `braid-PROGRAM-MAP.md` assigns arms to them.

## Priorities

### P1 — Program baseline and scaffolding (executed by this arm)

Seed the `factory/release-completion` integration branch from the verified baseline
(main `3d7b79f` = tag `v0.1.3` = npm `0.1.3`) and reconstruct the program documents from
repository evidence before any release-completion arm launches.

- Evidence: the verification plan and the delivery plan are the proof authorities the README
  points to (`README.md:312-314`); `AGENTS.md:71` pins those two documents as the only
  definition of release completion; `docs/09-delivery-plan.md:457` requires the audit verifier
  to extract required identifiers from the committed specification, so the specification-side
  program documents must exist and stay grounded in that committed evidence.
- Done when: the branch exists at the pinned base, the three `docs/program/` files are
  committed with the reconstruction note, and the draft PR is open.

### P2 — Complete the required live matrix `LIVE-01`–`LIVE-12`

Close the gap between what the current observations prove and what the required live matrix
demands. The 2026-08-09 core-path observations explicitly "do not claim the broader
interaction, tool, replay-cursor, cancellation, Tangle, or analysis rows in the required live
matrix" (`docs/08-verification.md:415-425`); the 2026-08-15 retained cohort satisfies only the
retained create, process-loss recovery, replay, cancellation, and cleanup parts of `LIVE-07`
(`docs/08-verification.md:445-477`).

- Evidence: the full matrix `LIVE-01`–`LIVE-12` at `docs/08-verification.md:360-381`; a
  required live provider that is unavailable blocks the release rather than being reported
  skipped or simulated (`docs/08-verification.md:381`); the strict bridge gate is
  `pnpm test:live:bridge:release` for `LIVE-01`–`LIVE-05`, which "narrower bridge smoke cannot
  satisfy" (`docs/08-verification.md:744`); the retained-sandbox canary-plus-cohort command is
  defined at `docs/08-verification.md:383-413`; runner conformance flow before any interactive
  advertisement at `docs/08-verification.md:479-492`; the known aggregate-run blocker is
  CLI Bridge issue 130 (`docs/08-verification.md:423`), an upstream defect this arm family
  must resolve or route around honestly, not approximate.
- Done when: every `LIVE-*` identifier maps to a passing real-provider record with complete
  provenance and confirmed cleanup (`docs/08-verification.md:310-314`, VR-04 at
  `docs/08-verification.md:792`).

### P3 — Land the measured verification planes: `PERF-01`–`PERF-10` and `EVAL-01`–`EVAL-06`

The full performance matrix lands in W12 (`docs/08-verification.md:740`): all ten targets with
complete distributions, warm/cold separation, and both reference machines
(`docs/08-verification.md:516-547`; VR-07). Semantic evaluation requires the calibrated judge
(11-of-12 paired preference, trivial baselines rejected) before the six release cases are
admissible (`docs/08-verification.md:318-350`, `:600-611`; VR-09).

- Evidence: report-shape requirements at `docs/08-verification.md:520-528`; target-change rule
  requiring a decision record at `docs/08-verification.md:545`; requirement ownership placing
  `PERF-*` in W12 and `EVAL-*` in W11 (`docs/09-delivery-plan.md:452-453`).
- Done when: VR-03, VR-07, and VR-09 pass for the exact release build
  (`docs/08-verification.md:791-797`).

### P4 — One sustained integration draft PR, flipped ready only at the final node (executed by this arm)

The release-completion program lands on a single `factory/release-completion` integration PR
opened as a draft by this arm. The release candidate is frozen only after all feature changes
merge (`docs/09-delivery-plan.md:467`), and the program publishes only that frozen digest
(`docs/09-delivery-plan.md:468`), so the draft stays draft until the final integration node
(`swe-final-integration-pr`) flips it to ready. Every arm keeps the branch rebased clean on
`origin/main`; the base is pinned at the verified baseline `3d7b79f`.

- Evidence: upstream PR and release order at `docs/09-delivery-plan.md:459-473`; every push
  receives current CI and review reinspection before the package is treated as ready
  (`docs/09-delivery-plan.md:473`); `README.md:296-316` defines the development proof
  (`pnpm check`) every push must keep green.
- Done when: `swe-final-integration-pr` flips this draft to ready and it merges into `main`.

### P5 — W13 publication: build, endorse, publish, verify from the registry

Execute the direct acceptance path: `pnpm check` once on the exact main commit, build one
immutable package with `pnpm release:prepare`, endorse that exact package and manifest in an
isolated code-free Ed25519 job, publish `@tangle-network/braid` with npm provenance, repeat
the post-publication smoke from the registry on Linux x64 and macOS arm64, validate the four
platform records plus provenance in one publication record, endorse the fixed bundle, and only
then tag.

- Evidence: W13 deliverables and done-when at `docs/09-delivery-plan.md:396-428`; Layer 9
  installation and release checks at `docs/08-verification.md:352-358`; publication direct
  acceptance path and endorsement keys pinned in `release/endorsement-public-key.pem` at
  `docs/08-verification.md:627-639` and `:694-696`; VR-10 registry-matches-candidate rule at
  `docs/08-verification.md:798`; supported targets are Linux x64 and macOS arm64
  (`README.md:32`), and the package rejects Windows until encrypted state meets the required
  path-race boundary there (`README.md:34`) — Windows stays out of scope for this release.
- Done when: the W13 done-when checklist passes (`docs/09-delivery-plan.md:418-428`).

### P6 — Close the audit and cleanup ledger

Assemble the comprehensive audit manifest on demand (it is available when a product decision
needs every requirement record in one manifest and is not an npm publication prerequisite,
`docs/08-verification.md:615-617`), confirm every live resource is cleaned up — the release
cannot complete with an unresolved externally billable test resource
(`docs/08-verification.md:718-720`) — and walk the final definition of done
(`docs/09-delivery-plan.md:489-505`) with no unresolved critical or high finding.

- Evidence: manifest shape and verifier rules at `docs/08-verification.md:641-717`; rollback
  and failure policy at `docs/09-delivery-plan.md:475-487` (a publication failure stops before
  tag and preserves the approved candidate, `docs/09-delivery-plan.md:481`).
- Done when: the final definition of done holds line by line
  (`docs/09-delivery-plan.md:489-505`).

## Priority order and this arm's mandate

Priorities are ordered by dependency, not by importance: P1 scaffolds the program, P2 and P3
close the evidence planes, P4 is the standing integration vehicle, P5 publishes, P6 closes the
ledger. **This arm executes P4+P1** — it seeds the branch, the documents, and the standing
draft PR. Subsequent arms are assigned in `braid-PROGRAM-MAP.md`.

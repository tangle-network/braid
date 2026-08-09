# Release Progress

## Target

- Environment: npm public registry and GitHub Releases.
- Live package: `@tangle-network/braid@0.1.0`.
- Source repository: `tangle-network/braid`.
- Release archive: an immutable npm tarball stored outside the source checkout.
- Rollback: stop before publication on any failed check; after publication, deprecate the bad version and publish a corrected patch without mutating `0.1.0`.
- Credentials: GitHub Actions trusted publishing or a repository-scoped npm token; no credential value belongs in this file or the checkout.

## Local State

- Branch: `feat/release-pipeline`.
- Starting commit: `d743b03e8110c9b6a698471d8e56474f1b76090b`.
- Starting source state: clean.
- Current registry state: `@tangle-network/braid` is unpublished.
- Local npm state: `npm whoami` returned HTTP 401, so publication must use protected GitHub credentials or trusted publishing.
- Checks planned: focused collector tests, full repository check, packed install, isolated release dry run, GitHub CI, registry download, and post-publication smoke.
- Release implementation: one external candidate tarball, 64 signed check records for 154 requirements, pre-publication qualification without a final report, and final signing only after six platform smoke records are validated.

## Remote State

- Provider: npm public registry.
- Current live package: absent.
- GitHub `main`: `d743b03e8110c9b6a698471d8e56474f1b76090b`.
- Latest merged pull request: #3.
- Latest checked source and package flow: pull-request CI passed 1/1 job in 3m48s on commit `26be5e4b193a92115db0b5f54db07c4a8f2f1f52`.
- Repository publication secrets or variables: none are currently configured at repository scope.

## Decision

- Build path: create one tarball in isolated temporary storage, record its digest, run all checks against that digest, and publish those same bytes.
- Reason: the current collector writes into the checkout, recursively includes `verify:release`, and cannot satisfy its own clean-source rule.
- Expected duration: implementation and local dry run first, then one review/CI cycle; external npm authorization may be the final blocker.
- Fallback: preserve the signed candidate and checks without publishing until npm authorization is available.

## Timeline

- [2026-08-09T14:33:46.000Z] Pull request #3 merged continuous source and packed-package checks to `main` at `d743b03e8110c9b6a698471d8e56474f1b76090b`.
- [2026-08-09T14:35:10.000Z] Registry lookup found no published Braid package and local npm authentication returned HTTP 401.
- [2026-08-09T14:35:30.000Z] Repository-level GitHub secrets and variables were empty; organization-level or trusted-publisher authorization remains to be checked.
- [2026-08-09T15:04:04.493Z] The persisted-tarball smoke installed the exact candidate bytes, completed plain messaging and encrypted SQLite replay, and removed temporary state on Linux x64.
- [2026-08-09T15:08:00.000Z] Type checking and 141 unit checks passed with publication-proof rejection coverage for a mismatched registry digest.
- [2026-08-09T15:09:00.000Z] The release workflow separated candidate qualification from final signing and made Linux x64, macOS arm64, and Windows x64 registry results mandatory before tag creation.
- [2026-08-09T15:18:40.000Z] Independent Codex review requested changes for seven reproducible release defects: unreachable protected checks, permissive exact UP evidence, missing independent-review records, discarded generated evidence, nondeterministic final retry, late-only checkpoint upload, and absent npm-attestation validation.

# Audit: Braid release pipeline PR #4 — d743b03..f4bb417 — n=72 files, 0 unresolved findings

**Verdict:** APPROVE — 17 of 17 reproducible defects resolved · 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW
**Next:** `/ship`

## Scope

| Field | Value |
| --- | --- |
| Files | n=72 via `git diff --name-only d743b03..f4bb417` |
| Base..head | `d743b03e8110c9b6a698471d8e56474f1b76090b..f4bb417a7943cd134d8760d908ff4b369a9feb27` |
| Project type | TypeScript ESM package |
| Reviewers | A=operator correctness, B=operator security, C=Codex first pass, D=operator reproduction and fixes, E=Codex re-review · serial |
| Not inspected | Protected Tangle, supervisor, and analysis services because their release credentials are not present locally |

## Findings — 0 of 18 unresolved

17 prior defects were resolved, 1 incorrect platform finding was rejected, and 0 findings were dropped.

## Re-audit

| Prior # | Sev | Resolution | Evidence |
| ---: | --- | --- | --- |
| 1 | HIGH | resolved | Low-entropy redaction test passes without corrupting structured markers |
| 2 | HIGH | resolved | Exact LIVE/EVAL records require one matching measurement |
| 3 | HIGH | resolved | UP records require successful owning-repository output |
| 4 | HIGH | resolved | VR-03 executes and records 100,000 seeds |
| 5 | HIGH | resolved | Restored failed work is validated and retried |
| 6 | HIGH | resolved | Windows package-manager commands execute through Node |
| 7 | HIGH | resolved | Recorded Windows paths use portable separators |
| 8 | HIGH | resolved | Tracked and untracked source changes both fail qualification |
| 9 | HIGH | resolved | Candidate execution cannot access the endorsement key |
| 10 | HIGH | resolved | Child commands receive only their required provider credentials |
| 11 | HIGH | resolved | Credential values cannot survive structured output capture |
| 12 | HIGH | resolved | Packed package metadata cannot drift candidate identity |
| 13 | HIGH | resolved | Windows npm uses its JavaScript entry point |
| 14 | HIGH | resolved | Registry smoke uses native encrypted SQLite correctly |
| 15 | HIGH | resolved | Shared-command records and artifacts retry together |
| 16 | MEDIUM | rejected | GitHub documents `macos-15` as the selected arm64 runner |
| 17 | HIGH | resolved | Three-run interruption reproduction passes with immutable snapshots |
| 18 | MEDIUM | resolved | Current Corepack `pnpm.mjs` entry points are accepted |

The independent re-review of `f4bb417` reported no actionable correctness regression.
Its process-sandbox test failures were excluded because direct workspace execution passed the focused suite 16 of 16.

## Self-check

9/9 passed — failed: none.

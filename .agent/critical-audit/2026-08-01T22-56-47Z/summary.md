# Audit: Braid W0 — af60a1b..WORKTREE — n=64 files, 12 findings

**Verdict:** REQUEST_CHANGES — 5 reproducible HIGH defects block W0 · 0 CRITICAL / 5 HIGH / 7 MEDIUM / 0 LOW
**Worst:** #1 `src/bin/braid.ts:77` — forced SIGINT leaves terminal modes active · cost if shipped 1 of 1 interrupted sessions
**Next:** fix all 12 findings, then `/critical-audit --reaudit .agent/critical-audit/2026-08-01T22-56-47Z`

## Scope

| Field | Value |
| --- | --- |
| Files | n=64 via current W0 worktree |
| Base..head | `af60a1b1cbff1c6a901748075fb77bcc36cb675c..WORKTREE` |
| Project type | TypeScript ESM package |
| Reviewers | A=Codex correctness/security, B=operator architecture/quality, C=operator contracts/real-system coverage · serial |
| Not inspected | Live providers and W1+ behavior; they are not implemented in W0 |

## Findings — 12 of 12, ranked

| # | Sev | file:line | Defect | Failure scenario | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | HIGH | `src/bin/braid.ts:77` | SIGINT bypasses cleanup | external SIGINT -> terminal modes remain active | measured | PTY probe: 0 of 3 cleanup markers | shared signal shutdown | packed PTY signal test | 1/1 sessions | 1/1 restored |
| 2 | HIGH | `src/views/headless/rpc.ts:133` | request IDs execute twice | changed duplicate -> second command runs | measured | 2 responses for `same` | response ledger | duplicate JSONL test | 1/1 requests | 1/1 rejected |
| 3 | HIGH | `src/app/application.ts:130` | stale operation replay | A, B, replay A -> revision 8 instead of 15 | measured | three-send probe | current state after completion | replay test | 1/1 replays | 1/1 current |
| 4 | HIGH | `src/bin/braid.ts:19` | temporary path follows symlink | pre-created symlink -> target truncation | measured | deterministic path + nonexclusive write | random exclusive no-follow file | subprocess race test | 1 file/race | 1 protected/race |
| 5 | HIGH | `src/views/shared/sanitize.ts:1` | bidi controls survive | U+200E/U+200F/U+061C -> spoofing control rendered | measured | 3/3 survived | full Bidi_Control set | table test | 3/3 controls | 3/3 removed |
| 6 | MEDIUM | `src/app/view-model.ts:39` | statuses are wrong | aborted -> failed; blocked -> ready | measured | 2/2 wrong | explicit status mapping | view test | 2/2 states | 2/2 corrected |
| 7 | MEDIUM | `src/views/tui/terminal-app.ts:191` | Ctrl+C order wrong | active draft cancels; idle exits immediately | measured | 2/4 branches wrong | documented order + arming | TUI test | 2/4 branches | 2/4 corrected |
| 8 | MEDIUM | `src/views/headless/rpc.ts:42` | invalid params ignored | numeric branch -> send succeeds | measured | 1/1 accepted | strict keys/types | JSONL table | 1/1 accepted | 1/1 rejected |
| 9 | MEDIUM | `src/app/application.ts:67` | snapshots retained | n operations -> n full states retained | measured | WeakRef remains live | Promise<void> records | GC test | n snapshots | n removed |
| 10 | MEDIUM | `src/testing/deterministic-backend.ts:26` | blank lines lost | two newlines -> one | measured | 1/2 lost | code-point chunking | exact text test | 1/2 lost | 1/2 restored |
| 11 | MEDIUM | `src/app/composition.ts:8` | default connection mislabeled | unconfigured mode -> fixture label | measured | 1/1 wrong | separate profiles | view test | 1/1 modes | 1/1 corrected |
| 12 | MEDIUM | `scripts/verify-package.mjs:258` | only two packed sizes | size-only package defect -> proof green | measured | 2/4 launched | launch 4/4 | package proof | 2/4 untested | 2/4 added |

0 dropped.

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
| --- | --- | --- |
| Node exposes `O_NOFOLLOW` on supported Unix systems | #4 implementation detail, not defect | run the packed symlink test on Linux and macOS |

## Self-gate

9/9 passed — failed: none.

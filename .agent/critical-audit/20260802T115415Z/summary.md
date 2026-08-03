# Audit: Braid W6 terminal and headless interfaces — 603c08a..worktree — n=63 files, 0 unresolved findings

**Verdict:** APPROVE — all five reproducible findings were fixed and rechecked · 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW

**Worst:** #1 `src/views/tui/terminal-app.ts:353-359` — Escape could leave a provider interaction unanswered · cost if shipped 1 blocked interaction per affected action

**Next:** stop after the final release checks and commit

## Scope

| Field | Value |
|---|---|
| Files | n=63 via tracked diff plus untracked W6 files |
| Base..head | `603c08a48ff307d3f54b1c20e5a2e5b5f2ef3149..worktree` |
| Project type | TypeScript package with terminal UI and JSONL protocol |
| Reviewers | A, B, C · serial |
| Not inspected | Live providers, protected deployments, and sibling W5 storage |

## Findings — 0 of 5 unresolved, ranked

| # | Sev | file:line | Defect | Failure scenario | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
|---:|---|---|---|---|---|---|---|---|---:|---:|
| 1 | HIGH | `src/views/tui/terminal-app.ts:353-359` | Interaction Escape could dismiss without response | Focused interaction + Escape → provider remains blocked | fixed | `findings.jsonl#1` | Forward Escape to focused interaction | `node scripts/test-pty.mjs` → 4 of 4 sizes pass | 1 blocked interaction/action | 1 blocked interaction/action |
| 2 | MEDIUM | `src/views/tui/terminal-app.ts:338-350` | Late callback could touch stopped TUI | Response after stop → stale render/modal | fixed | `findings.jsonl#2` | Stop guard | `node scripts/run-suite.mjs all` → 9 of 9 pass | 1 stale callback/late response | 1 stale callback/late response |
| 3 | MEDIUM | `src/views/shared/models.ts:346-356` | Snapshots were shallowly frozen | Child mutates shared view data → later render changes | fixed | `findings.jsonl#3` | Recursive freeze | `node scripts/run-suite.mjs all` → 9 of 9 pass | 1 shared mutation/violating component | 1 shared mutation/violating component |
| 4 | MEDIUM | `src/views/headless/rpc.ts:253-288` | Wrong parameter types reached dispatch | Malformed JSON field → unrelated capability result | fixed | `findings.jsonl#4` | Type and required-field validation | `node scripts/test-rpc-packed.mjs` → 16 responses pass | 1 malformed request/client call | 1 malformed request rejected |
| 5 | LOW | `src/views/shared/sanitize.ts:136-155` | UTF-16 bound could split a pair | Supplementary character at bound → lone surrogate | fixed | `findings.jsonl#5` | Code-point truncation | `node scripts/run-suite.mjs all` → 9 of 9 pass | 1 malformed character/boundary hit | 1 malformed character/boundary hit |

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
|---|---|---|
| Live provider capabilities match the declared adapter contract | Provider-specific interaction or reconnect defect | Protected live matrix against published runtime/provider packages |
| W5 persists the contracts consumed by these views | Integration mismatch after merge | W5 application/storage tests against this controller |

## Self-gate

9/9 passed — failed: none.

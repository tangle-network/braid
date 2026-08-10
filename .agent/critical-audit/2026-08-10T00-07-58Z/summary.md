# Audit: Braid product presentation and runtime fixes — a34c7ff..0945f5f — n=78 files, 6 findings

**Verdict:** APPROVE — 6 of 6 measured defects resolved · 0 CRITICAL / 1 HIGH / 5 MEDIUM / 0 LOW, all resolved
**Worst:** #1 `src/adapters/storage/sqlite-lifecycle.ts:279` — duplicate descriptor close caused 1 crash in 9 two-process attempts · cost if shipped 1 crash per 9 attempts
**Next:** `/stop`

## Scope

| Field | Value |
| --- | --- |
| Files | n=78 via `git diff --name-only a34c7ff..0945f5f` |
| Base..head | `a34c7ff16ec9a26be3e4a5e97ec152bccc3db53c..0945f5f9cccbd3b129b7230e6a23b80a69ba5bd2` |
| Project type | TypeScript ESM package |
| Reviewers | A=correctness/security, B=architecture/quality, C=standards/real-system, D=Luna Max product/media pass · serial |
| Not inspected | Protected Tangle inference and sandbox services because their deployment credentials are absent locally |

## Findings — 6 of 6, ranked

| # | Sev | file:line | Defect | Failure scenario (input/state → wrong result) | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- | ---: | ---: |
| 1 | HIGH | `src/adapters/storage/sqlite-lifecycle.ts:279` | Live SQLite files were opened and closed for permission checks, cancelling POSIX locks. | Two processes secure one WAL database → 1 of 9 attempts faults in `braid.sqlite-shm` with SIGBUS. | measured; resolved | `test/effect-admission.test.ts:24-69`; pre-fix repetition 1/9 SIGBUS; strace fault in SHM | Inspect and chmod without another descriptor; recheck inode, owner, and mode. | coordination 27/27; repeated pairs 60/60; full check 494 pass, 0 fail | 1 crash/9 attempts | 1 crash/9 attempts |
| 2 | MEDIUM | `README.md:11` | Git ignored the linked hero GIF and replayable cast. | Reader opens merged README → first product visual is broken. | measured; resolved | `.gitignore:12-15`; `git check-ignore -v` matched 2/2 files | Explicitly track both generated files. | `git ls-files --stage` returns 2/2 | 1 broken hero/1 README | 1 working hero/1 README |
| 3 | MEDIUM | `src/domain/reducer-helpers.ts:415` | Final messages retained running reasoning/tool parts and imprecise outcomes. | Any terminal event follows an active part → spinner or wrong state remains. | measured; resolved | `test/domain-reducer.test.ts:78-148` | Close active parts through one exact terminal-status map on both event paths. | 7/7 terminal outcomes pass | 7 wrong states/7 outcomes | 7 correct states/7 outcomes |
| 4 | MEDIUM | `src/views/tui/dynamic-autocomplete.ts:20` | Completion descriptions froze before runtime capabilities changed. | A run enables `/ask` → completion still says unavailable. | measured; resolved | `test/w6-ui.test.ts:482-495` | Refresh the provider when the command signature changes. | 1/1 transition passes; GIF shows accepted `/ask` | 1 stale command/1 transition | 1 correct command/1 transition |
| 5 | MEDIUM | `src/bin/args.ts:151` | Visual state could be selected without the deterministic provider. | `--ui-fixture product-demo` alone → synthetic state enters a non-fixture session. | measured; resolved | `a34c7ff:src/bin/args.ts:147`; `test/cli-startup.test.ts:42-52` | Require `--fixture deterministic`. | 2/2 parser cases pass | 1 unsafe invocation/1 test | 1 rejected invocation/1 test |
| 6 | MEDIUM | `src/adapters/storage/sqlite-paths.ts:200` | An early candidate treated post-inspection disappearance as optional absence. | SQLite sidecar disappears after initial inspection → permission check reports success. | measured; resolved | `src/adapters/storage/sqlite-paths.ts:172-223` | Permit absence only on initial inspection; fail every later error. | static branch inspection; full check 494 pass, 0 fail | unmeasured races/run | unmeasured races rejected/run |

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
| --- | --- | --- |
| The observed 1 of 9 Linux crash rate represents only affected concurrent launches. | #1 cost, not severity | Repeat the same two-process test across Linux filesystems and deployed hosts. |
| Protected Tangle services preserve the normalized events shown by local adapters. | None of 6; first-release status only | Run the protected release flows with deployment credentials. |

## Self-gate

9/9 passed — failed: none.
1 verdict = decision + 1 number · 2 every finding has file:line · 3 concrete failure scenario · 4 status label · 5 evidence is a pointer · 6 cost both sides · 7 fix + verification per row · 8 zero adjectives standing in for counts · 9 154 words ≤600 outside tables.

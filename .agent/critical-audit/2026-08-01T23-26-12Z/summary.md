# Audit: Braid W0 re-audit — af60a1b..WORKTREE — n=76 files, 0 unresolved findings

**Verdict:** APPROVE — 13 of 13 measured defects resolved · 0 CRITICAL / 0 HIGH / 0 MEDIUM / 0 LOW
**Next:** `/verify`

## Scope

| Field | Value |
| --- | --- |
| Files | n=76 via `rg --files` excluding generated and dependency directories |
| Base..head | `af60a1b1cbff1c6a901748075fb77bcc36cb675c..WORKTREE` |
| Re-audit | `.agent/critical-audit/2026-08-01T22-56-47Z` plus its bounded-RPC follow-up |
| Project type | TypeScript ESM package |
| Reviewers | A=Codex original findings, B=operator packed/PTY/memory checks, C=Codex RPC regression · serial |
| Not inspected | Live providers and W1+ behavior; neither is implemented in W0 |

## Findings — 0 of 13 unresolved

0 new findings and 0 dropped.

## Re-audit

| Prior # | Sev | Resolution | Evidence |
| ---: | --- | --- | --- |
| 1 | HIGH | resolved | Packed PTY signal probe: 3 of 3 cleanup markers present and exit code 130 |
| 2 | HIGH | resolved | Duplicate direct response replayed; changed body returned `REQUEST_ID_CONFLICT`; compiled RPC test passed |
| 3 | HIGH | resolved | Replay revision 13 equaled current revision 13 and contained 4 of 4 messages |
| 4 | HIGH | resolved | Packed symlink setup left the seeded victim unchanged; `stateWriteSymlinkSafe:true` |
| 5 | HIGH | resolved | 12 of 12 Unicode `Bidi_Control` characters removed |
| 6 | MEDIUM | resolved | 2 of 2 aborted and blocked terminal states retained distinct status |
| 7 | MEDIUM | resolved | 4 of 4 Ctrl+C branches passed, including two-step idle quit |
| 8 | MEDIUM | resolved | Wrong optional type returned `INVALID_PARAMS` and dispatched 0 messages |
| 9 | MEDIUM | resolved | Corrected function-scoped GC probe reported `completionStateCollectible:true` |
| 10 | MEDIUM | resolved | Exact `\nA\n\nB` payload survived deterministic chunking |
| 11 | MEDIUM | resolved | 2 of 2 unconfigured and deterministic modes reported their actual connection |
| 12 | MEDIUM | resolved | Packed process launched 4 of 4 sizes with 9 events per size |
| 13 | MEDIUM | resolved | 20,000-request in-flight probe grew 318,344 bytes versus 22,585,480 bytes before; independent post-GC probe grew 60,224 bytes; 2 of 2 payload-edge tests added; final reviewer `APPROVE` |

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
| --- | --- | --- |
| Supported Unix systems expose the required exclusive/no-follow file flags | #4 portability only | Repeat the packed symlink test on the macOS release runner |

## Self-gate

9/9 passed — failed: none.

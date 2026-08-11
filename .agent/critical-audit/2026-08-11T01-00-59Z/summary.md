# Audit: Braid production terminal and real Pi proof

**Verdict:** APPROVE.

Eight measured defects are resolved, and no actionable defect remains in the reviewed candidate.

## Scope

| Field | Value |
| --- | --- |
| Base | `5e2cc57101150b0a839a1eddd399af87082fb435` |
| Product source | `bd8f607fd1045aabefd7153efe6d37d6b1e4ba36` |
| Pull request change | 399 files, including generated proof artifacts |
| Product code change | 207 source files and 39 test files |
| Independent review | Luna Max approved the corrected exact artifacts |

## Findings

| Severity | Resolved | Unresolved |
| --- | ---: | ---: |
| Critical | 0 | 0 |
| High | 4 | 0 |
| Medium | 4 | 0 |
| Low | 0 | 0 |

The worst defects allowed the public demo to differ from the proven package and allowed estimated cost to lose its provenance.

Both defects now fail closed.

## Architecture

The product remains a terminal client over `agent-runtime`.

It does not own a runner loop, provider parser, sandbox scheduler, inference gateway, or judge.

`ActivityDocument` is a 103-line presentation projection.

`ComposerView` is 157 lines, and `ExecutionTargetView` is 58 lines.

The larger live recorder delegates terminal, manifest, HTTP, safety, and workspace concerns to separate modules.

The source graph contains 454 modules and 2,323 edges with zero cycles.

Dependency boundary checks pass.

## Proof

| Check | Result |
| --- | --- |
| `pnpm check` | 610 passed, 0 failed, 2 protected skips |
| Performance tests | 15 passed, 0 failed |
| Live-demo tests | 18 passed, 0 failed |
| Exact package proof | Passed for `bd8f607`, tarball SHA-256 `32dda757...f7b8` |
| Real Pi workspace | 17 passed, 0 failed |
| Real `/ask` | 3 findings, 6 model calls, 2 pages |
| Visual proof | 75 artifacts and 11 required states |
| Responsive proof | 4 of 4 reference terminal sizes |
| Demo artifact hashes | 4 of 4 match the manifest |
| W6 artifact hashes | 69 of 69 hashed files match the manifest |
| Secret scan | 221,517 demo bytes and 1,211,252 W6 bytes; no leaks |
| Independent review | APPROVE, no remaining defects |

## Limits

Protected Tangle inference and sandbox checks did not run without their credentials.

Runtime issue 762 still owns incremental normalized tool events.

Runtime issue 773 still owns exact native execution and worker attachment.

Braid exposes these limits instead of simulating support.

## Next

Run final formatting and git checks, then publish the pull request and merge it to main.

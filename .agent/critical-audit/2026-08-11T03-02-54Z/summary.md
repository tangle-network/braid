# Audit: Braid current terminal UX

**Verdict:** APPROVE.

Five measured defects are resolved, and no actionable defect remains in the reviewed diff.

## Scope

| Field | Value |
| --- | --- |
| Base | `0cd611d7c9a02845b6341ebe49d7542321423cd3` |
| Working-tree diff | 32 files before this audit artifact |
| Diff SHA-256 | `d367ad68f357c46026e7daa468ae5900b693e1ea376917557308c954165f9251` |
| Independent review | Luna Max read-only probes plus operator re-verification |

## Findings

| Severity | Resolved | Unresolved |
| --- | ---: | ---: |
| Critical | 0 | 0 |
| High | 2 | 0 |
| Medium | 3 | 0 |
| Low | 0 | 0 |

The worst defects made estimated analysis cost look exact and hid decision controls at 40 by 12 cells.

Both now have named regressions.

The exact Pi run also found and removed a proof parser dependency on display punctuation.

One formatter-only report was dropped after the formatter passed because it had no remaining failure scenario.

## Architecture

The product remains one terminal client over `agent-runtime`.

It does not own a runner loop, provider parser, sandbox scheduler, inference gateway, or judge.

Terminal composition is 143 lines.

Identity rendering is 200 lines, usage formatting is 177 lines, and the shared focused layout is 68 lines.

The source graph contains 457 modules and 2,336 edges with zero cycles.

## Proof

| Check | Result |
| --- | --- |
| Complete repository command | Passed, including the CLI Bridge adversarial matrix |
| Repository tests | 615 passed, 0 failed, 2 protected checks skipped |
| Unit tests | 226 passed, 0 failed |
| Terminal tests | 122 passed, 0 failed |
| Performance tests | 15 passed, 0 failed |
| Visual proof | 75 artifacts, 11 states, and 4 terminal sizes |
| Direct narrow render | Validation, response, all outcomes, and Escape visible at 40 by 12 |
| Dependencies | 68 production packages and no known vulnerability |
| Changed-line secret scan | 0 credential-like additions |
| Independent probes | Typecheck and focused terminal suites passed |

## Limits

Protected Tangle inference and sandbox checks did not run without their credentials.

Runtime issues 762 and 773 still own normalized tool events and native execution attachment.

Braid exposes these limits instead of simulating support.

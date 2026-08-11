# Audit: exact profile binding and durable evidence — `fa375f9..69b8fd9` — 34 files, 11 findings

**Verdict:** APPROVE — 11 of 11 measured defects resolved; 0 unresolved.

**Worst:** Redacted profile identity permitted metadata-only execution reuse, and semantic artifact limits removed four of six cases.

**Next:** `/verify`

## Scope

| Field | Value |
| --- | --- |
| Files | 34 changed files |
| Base | `fa375f9ef14ecead34d287f294465d46f54bc8f4` |
| Head | `69b8fd9e8ad81770febe5dc472afdafe1745631d` |
| Review | Operator plus two independent Luna Max passes |
| Product checks | Packed terminal, native SQLite, performance, real Router semantic evaluation |

## Findings

| # | Severity | Area | Result |
| ---: | --- | --- | --- |
| 1 | HIGH | Exact AgentProfile admission identity | Resolved |
| 2 | HIGH | Restart profile identity | Resolved |
| 3 | HIGH | Nested profile metadata persistence | Resolved |
| 4 | HIGH | Evaluation secret and traversal safety | Resolved |
| 5 | HIGH | Structured value safety | Resolved |
| 6 | HIGH | Complete semantic artifact retention | Resolved |
| 7 | MEDIUM | Runtime aggregate token record | Resolved |
| 8 | MEDIUM | Invalid numeric telemetry | Resolved |
| 9 | MEDIUM | Long conversation export | Resolved |
| 10 | MEDIUM | Partial observed and estimated cost | Resolved |
| 11 | MEDIUM | Loaded-host terminal capture | Resolved |

## Proof

| Check | Result |
| --- | --- |
| Repository | 586 passed, 0 failed, 2 protected skips |
| Unit | 219 passed, 0 failed |
| Security | 129 passed, 0 failed |
| Semantic | 6 cases, 18 fixtures, 73 calls, all passed |
| Performance | 10 rows, 12,122 samples, 0 failures |
| Packed terminal | 34 RPC records, 75 artifacts, 11 states |
| Architecture | 443 modules, 2,268 edges, 0 cycles |
| Independent review | 2 approvals, 0 unresolved high-severity findings |

## Limits

Protected Tangle inference and sandbox checks did not run in this local proof.

Raw terminal attachment remains blocked on the retained-session contracts tracked in the three upstream issues.

## Self-check

9 of 9 required audit fields passed.

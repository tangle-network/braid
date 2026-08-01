# Audit: complete staged plan — `4b825dc`..`f7cefa2` — n=20 files, 10 findings

**Verdict:** APPROVE AFTER RE-AUDIT — 10 of 10 concrete findings resolved · 0 critical / 6 high / 4 medium / 0 low

**Worst:** #1 `docs/03-architecture.md:256` — normal completions had no valid state transition · cost if shipped 1 rejected transition per ordinary completion

**Next:** Commit the corrected specification and start the implementation goal.

## Scope

| Field | Value |
| --- | --- |
| Files | n=20 staged files |
| Base..head | empty tree `4b825dc` to staged tree `f7cefa2` |
| Project type | Documentation-first TypeScript terminal application |
| Reviewers | A complete; B interrupted and C omitted at the user's direction; deterministic re-audit completed |
| Not inspected | Implementation code does not exist yet; full B and C passes were stopped when the user asked to stop expanding the review |

## Findings — 10 of 10, ranked

| # | Sev | file:line | Defect | Resolution evidence |
| ---: | --- | --- | --- | --- |
| 1 | HIGH | `docs/03-architecture.md:256` | Normal terminal transitions were absent | Complete transition table plus targeted assertion |
| 2 | HIGH | `docs/07-security-and-privacy.md:140` | Tombstones left payloads decryptable | Per-conversation content keys plus verified redaction rewrite |
| 3 | HIGH | `docs/08-verification.md:47` | Reconnect lost operation identity | Caller operation ID plus command digest and conflict response |
| 4 | HIGH | `docs/06-conversations-forks-and-analysis.md:354` | Secret answers could enter automation rules | Secret schemas reject automation and persist no value |
| 5 | HIGH | `docs/06-conversations-forks-and-analysis.md:182` | Fork crash could duplicate remote resources | Required key, digest, lookup, conflict, and cleanup contract |
| 6 | HIGH | `docs/06-conversations-forks-and-analysis.md:210` | Context changes could be disclosed after dispatch | Side-effect-free plan and accepted digest precede execution |
| 7 | MEDIUM | `docs/04-runtime-contracts.md:336` | Native continuation lacked boundary proof | Matching provider boundary is now mandatory |
| 8 | MEDIUM | `docs/09-delivery-plan.md:302` | Direct terminal output could leave approval stuck | Matching acknowledgement or terminal outcome resolves it |
| 9 | MEDIUM | `docs/03-architecture.md:442` | Pi test helper was not published | Braid test-only attributed adapter is explicit |
| 10 | MEDIUM | `docs/06-conversations-forks-and-analysis.md:280` | `agent-eval` call shapes were incompatible | Streaming path now uses `registry.runExactStream(...)` |

0 dropped.

## Re-audit

| Prior # | Sev | Resolution | Evidence |
| ---: | --- | --- | --- |
| 1 | HIGH | resolved | `critical-reaudit: PASS` check `run terminal transitions` |
| 2 | HIGH | resolved | `critical-reaudit: PASS` check `deletion key destruction` |
| 3 | HIGH | resolved | `critical-reaudit: PASS` check `headless caller operation identity` |
| 4 | HIGH | resolved | `critical-reaudit: PASS` check `secret automation rejection` |
| 5 | HIGH | resolved | `critical-reaudit: PASS` check `fork retry lookup` |
| 6 | HIGH | resolved | `critical-reaudit: PASS` check `pre-dispatch context consent` |
| 7 | MEDIUM | resolved | `critical-reaudit: PASS` check `native boundary proof` |
| 8 | MEDIUM | resolved | `critical-reaudit: PASS` check `interaction terminal completion` |
| 9 | MEDIUM | resolved | `critical-reaudit: PASS` check `Pi test helper boundary` |
| 10 | MEDIUM | resolved | `critical-reaudit: PASS` check `agent-eval streaming API` |

## Assumptions and unverified

| Assumption | Finding it would flip | Check that settles it |
| --- | --- | --- |
| Current package source remains compatible when implementation begins | 5, 7, 9, 10 | Re-run package inventory and compile against packed current tarballs before W0 and each upstream work package |
| The selected keychain and SQLite bindings support the documented key lifecycle on all release systems | 2 | W5 install, forced-death, backup, key-destruction, and marker-scan checks on macOS, Linux, and Windows |

## Self-gate

9/9 passed — failed: none.

1 verdict has a decision and count · 2 every finding has file:line · 3 every finding has a concrete failure scenario · 4 every finding has a status label · 5 every finding has an evidence pointer · 6 costs use the same unit on both sides · 7 every finding has a fix and verification · 8 zero adjectives stand in for counts · 9 prose outside tables is under 600 words.

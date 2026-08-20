# Audit: Braid cloud proof path — 3d7b79f..7e19843 — n=17 files, 8 findings

**Verdict:** REQUEST_CHANGES — no live provider run, and LIVE-08 lacks full telemetry · 0 CRITICAL / 2 HIGH / 6 MEDIUM / 0 LOW

**Worst:** #2 `scripts/live-bridge/process-tree.mjs:9-35` — process-group exit does not cover escaped descendants · cost if shipped 1 unsafe workspace cleanup/run

**Next:** run with staging Sandbox credentials, then address #2, #3, #4, and #7 before calling LIVE-08 complete.

## Scope

| Field | Value |
|---|---|
| Files | n=17, two requested scripts, direct helpers, and proof tests |
| Base..head | `3d7b79f6f4f3270821b1b2fcbd777fb411f1ded9..7e19843217b9d1c9233fb1c5cdc93f54aa8552ff` plus dirty working tree |
| Project type | Node package with live release scripts |
| Reviewers | operator + codex `gpt-5.6-luna`, serial review |
| Not inspected | agent-dev-container and unrelated Braid production code |

## Findings — 8 of 9, ranked

| # | Sev | file:line | Defect | Failure scenario (input/state → wrong result) | Status | Evidence | Fix | Verification | Cost if shipped | Saved if fixed |
|---:|---|---|---|---|---|---|---|---:|---:|---:|
| 1 | HIGH | `scripts/live-required/contracts.mjs:490-501` | Status-only interactive receipts passed. | True facts plus `{status:'passed'}` → passed receipt without runtime sections. | resolved | `node --test ... -> 28/28`; new rejection test at `test/tangle-live07-wiring.test.mjs:217` | Require six structured observation sections. | 28/28 self-tests. | 1 false proof/run | 1 false proof/run |
| 2 | HIGH | `scripts/live-bridge/process-tree.mjs:9-35` | Group status misses escaped descendants. | Detached child survives parent exit → group gone, workspace cleanup runs. | open-live-boundary | Luna PTY probe: `gone:true`, `aliveAfterParentExit:true`. | Use cgroup/job/supervisor ownership. | Add detached-child test and cleanup refusal. | 1 unsafe cleanup/run | 1 unsafe cleanup prevented/run |
| 3 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-interactive.mjs:442-447` | LIVE-08 deletes one exact resource, not the complete owned set. | Second owned Sandbox remains → exact target deletion still passes. | open | One `get/delete/get`; soak has broader census. | Shared owned-resource census. | Live duplicate-resource test. | 1 leak/run | 1 leak prevented/run |
| 4 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-interactive.mjs:778-784` | Input check accepts local PTY echo. | Provider ignores input → echo count advances → input passes. | open | No provider-bound marker check. | Require provider event/response. | Ignored-input live fault test. | 1 false input pass/run | 1 false input pass prevented/run |
| 5 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-soak.mjs:399-454` | Replay does not prove hidden provider exactly-once execution. | Provider runs same execution twice but deduplicates events → proof passes. | open-live-boundary | No execution-attempt receipt. | Provider receipt or side-effect counter. | Duplicate-execution fault test. | 1 hidden duplicate/run | 1 duplicate detected/run |
| 6 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-interactive.mjs:383-389` | Attach/input causality is not provider-bound. | Local operations succeed while remote operation is ignored → stable identity looks valid. | open-live-boundary | Ordered lifecycle events now exist; attach ack/input response absent. | Require provider-bound acknowledgements. | Real Pi Sandbox fault test. | 1 false interactive pass/run | 1 false pass prevented/run |
| 7 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-interactive.mjs:896-934` | LIVE-08 omits spend and resource telemetry. | Run passes with unknown tokens/cost/latency/account usage. | open | Soak has telemetry; interactive does not. | Reuse disclosures or mark partial. | Live receipt metric-status check. | 1 spend gap/run | 1 spend gap closed/run |
| 8 | MEDIUM | `scripts/live-required/tangle-sandbox-braid-soak.mjs:855-910` | Shared cohort delta cannot attribute account churn. | Concurrent external resource activity → account delta is ambiguous. | open | Canary/cohort pass `false`; exact owned cleanup still runs. | Exclusive cohort or explicit unattributed status. | Shared plus exclusive cohort checks. | 1 ambiguous cohort | 1 ambiguity removed/cohort |

## Assumptions & unverified

| Assumption | Finding it would flip | Check that settles it |
|---|---:|---|
| Sandbox staging/prod is reachable with current credentials. | 2,3,4,5,6,7,8 | Run both scripts with endpoint, model, runner, and protected credential. |
| Provider event records include causal attach/input acknowledgements. | 4,6 | Inspect one live `--record-state` frame and Sandbox terminal event stream. |
| `tangle-sandbox` resource ownership is unique by control reference. | 3 | List all retained resources before and after LIVE-08. |

## Self-gate

9/9 passed — failed: none.
1 verdict = decision + 1 number · 2 every finding has file:line · 3 concrete failure scenario · 4 status label · 5 evidence is a pointer · 6 cost both sides · 7 fix + verification per row · 8 zero adjectives standing in for counts · 9 words ≤600 outside tables.

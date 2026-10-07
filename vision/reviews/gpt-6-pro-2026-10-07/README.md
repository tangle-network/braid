# GPT-6 Pro review packet

Prepared 2026-10-07 at the user's request for full, deep independent opinions. **All three reviews are verified as sent to GPT-6 Pro. Answers are pending.** These are review inputs and delivery receipts, not audit findings.

| Review | Question | Exact prompt | Conversation |
| --- | --- | --- | --- |
| Architecture | What is the smallest sound implementation and what must remain with existing owners? | [Prompt](architecture.prompt.md) | [Open](https://chatgpt.com/c/6ac6d427-a478-83e8-91c4-a4e48904a968) |
| Learning and profiles | How can personal evolution and capability investment be measured without misleading proxies? | [Prompt](learning.prompt.md) | [Open](https://chatgpt.com/c/6ac6d27e-305c-83e8-9673-d5a287412b16) |
| Product and counterarguments | What should the user experience, where is the thesis weak, and what first job can establish value? | [Prompt](product.prompt.md) | [Open](https://chatgpt.com/c/6ac6d597-a5cc-832f-95f3-fdc0a9dd56c4) |

Each self-contained prompt is about 4,000 words and includes implementation context, the complete root-agent and durable lifecycle proposals, specific questions, counterarguments, evidence standards, and required deliverables. The explicit request for deep prompts takes precedence over the fleet skill's usual short-prompt guideline. Reviewers must not consult each other's conclusions before answering.

The [manifest](manifest.json) records exact prompt hashes, source revision, requested model, owner, and current state. The [shared context](context.md) is retained for inspection. The root's [implementation path](../../implementation-path.md) is provisional and intentionally omitted from the prompts so reviewers can derive their own sequence.

## Verified delivery

The proposal merged in [PR #128](https://github.com/tangle-network/braid/pull/128), main commit `bd27d9852d910cba2fdfd1fdce7375146d077fef`. The original prompt files were fetched from their immutable commit on GTR; all three file hashes still match. Fleet strips only the final newline. Both file and normalized hashes are retained in the [filtered ledger receipts](dispatch-receipts.json).

Fleet recorded each `start` after checking the stored full user message and requested GPT-6 Pro selection:

| Review | Fleet item | Verified send, UTC |
| --- | --- | --- |
| Learning | `it-3930c98e0f` | 2026-10-07 23:19:42.547 |
| Architecture | `it-3a4ad00c94` | 2026-10-07 23:24:44.205 |
| Product | `it-8401b4cbf5` | 2026-10-07 23:29:26.053 |

The dispatch receipt snapshot does not yet identify served reply models. Reply metadata and completed answers will be recorded separately. A verified send is not a completed review.

Earlier attempts stopped before submission. Temporary account contention was repaired in [Tangle Tools PR #785](https://github.com/tangle-network/tangle-tools/pull/785). The changed model picker was repaired in [PR #797](https://github.com/tangle-network/tangle-tools/pull/797), which verifies the checked GPT-6 family separately from Pro effort. Both fixes were deployed through the maintained updater. Request-body and returned-model guards remain enforced. The same three items were retained throughout; no alternate model or duplicate question was substituted. Historical blockers remain in the manifest.

## Completion owner and next check

Owner: `codex-braid-root-vision-20261007`. The existing one-shot `pickerfix` services on `drew-gtr-pro` own reply waits and answer files. Their unit names and log paths are in the manifest. They use the `Tangle Agent Managed` project. These research items do not authorize PRs, implementation, external outreach, or cloud provisioning.

Observe the local ledger without consuming an account API lease:

```bash
chatgpt-fleet runs --all --json --limit 10000 --session codex-braid-root-vision-20261007
```

The next completion check is a complete answer for each existing item, with served-model metadata and retained provenance. Do not start another send while its worker is active. If a worker stops, inspect its recorded disposition and resume the existing item's reply wait through the maintained fleet command. Do not recreate the question.

Read each complete answer before acknowledging it. Check repository claims against actual source and open primary references before relying on them. Retain raw answers and conversation provenance; a reviewer assertion is not a verified implementation fact.

## Acceptance and synthesis

The synthesis must include:

1. Agreements, substantive disagreements, and unsupported claims from each reviewer.
2. Accepted and rejected recommendations with reasons and owners.
3. A revised implementation sequence and the smallest useful complete flow.
4. Concrete proof requirements, dependencies, stop conditions, and remaining user decisions.

Use the existing item for a follow-up that resolves a named disagreement. Do not use majority vote as validation. After integrating or rejecting an answer, record `ack --actions` or `ack --rejected`, then close the research item with an accurate `--answered` summary. Preserve full conversations through the normal fleet export path.

No synthesis can be labeled independently audited until the requested model's actual answers have been captured and checked.

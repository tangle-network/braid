# GPT-6 Pro review packet

Prepared 2026-10-07 at the user's request for full, deep independent opinions. **Three work items are registered, but account admission blocked every send. No reviews have been dispatched or received.** These are review inputs, not audit findings.

| Item | Fleet item | Question | Exact prompt |
| --- | --- | --- | --- |
| Root agent architecture and delivery | `it-3a4ad00c94` | What is the smallest sound implementation and what must remain with existing owners? | [Architecture](architecture.prompt.md) |
| Root agent learning and objective discovery | `it-3930c98e0f` | How can personal evolution and capability investment be measured without misleading proxies? | [Learning](learning.prompt.md) |
| Root agent product and counterarguments | `it-8401b4cbf5` | What should the user experience, where is the thesis weak, and what first job can establish value? | [Product](product.prompt.md) |

Each self-contained prompt is about 4,000 words and includes common implementation context, the complete root-agent and durable lifecycle proposals, specific audit questions, counterarguments, evidence standards, and required deliverables. The explicit request for deep prompts takes precedence over the fleet skill's usual short-prompt guideline. Reviewers must not consult each other's conclusions before answering.

The [manifest](manifest.json) records exact prompt hashes, source revision, requested model, owner, and blocked dispatch state. The [shared context](context.md) is retained for inspection. The root's [implementation path](../../implementation-path.md) is provisional and intentionally omitted from the prompts so reviewers can derive their own sequence.

## Execution status

The proposal merged in [PR #128](https://github.com/tangle-network/braid/pull/128), main commit `bd27d9852d910cba2fdfd1fdce7375146d077fef`. Exact prompt files were fetched on GTR from their immutable commit and their SHA-256 hashes matched the manifest. The normal commit hooks and documentation checks passed.

GTR preflight inspected all 214 pre-existing ledger items dated September 22 through October 5. It found 24 unresolved items owned by other sessions and no duplicate root-agent audit item; their ownership and state were preserved. Live account checks reached authenticated Pro sessions, but send attempts then stopped with `AccountBusy` across slots a, b, c, and d. Registration of the three items does not establish prompt delivery.

The supervised dispatch processes exited before sending. Their retained logs and unit names are in the manifest. All three items have no conversation and no active send claim. No background review is currently running for this packet. Resume the same items once shared admission permits; do not override holds, pacing, or other owners' operations.

Local Git metadata is read-only. Delivery used an isolated checkout, normal hooks, and the authenticated GitHub API to publish the exact checked Git tree and commit. The original workspace files are retained; its local Git index has not been synchronized.

## Resume through the maintained fleet

Owner: `codex-braid-root-vision-20261007`. The next completion check is three ledgered research items with actual conversation URLs and GPT-6 Pro answers. First verify the fleet's current accounts and ledger, including older items:

```bash
chatgpt-fleet runs --all --json --limit 10000
chatgpt-fleet status --json
```

The three matching items already exist. Resume them by the IDs above rather than creating duplicates. Preserve unrelated pending work and account holds. Use only the `Tangle Agent Managed` project. These are research items; they do not authorize PRs, implementation, external outreach, or cloud provisioning.

Retain a copy of the exact packets in the fleet's durable state directory on the host that will run the command. From the repository root:

```bash
braid_review_dir="$HOME/.local/state/chatgpt-fleet/braid-root-vision-20261007"
mkdir -p "$braid_review_dir"
cp vision/reviews/gpt-6-pro-2026-10-07/*.prompt.md "$braid_review_dir/"
```

Resume the registered research questions with the maintained tool, preserving its account selection and admission rules:

```bash
chatgpt-fleet send --ref it-3a4ad00c94 --session codex-braid-root-vision-20261007 --operator codex-braid-root-vision-20261007 --model gpt-6-pro --file "$braid_review_dir/architecture.prompt.md"
chatgpt-fleet send --ref it-3930c98e0f --session codex-braid-root-vision-20261007 --operator codex-braid-root-vision-20261007 --model gpt-6-pro --file "$braid_review_dir/learning.prompt.md"
chatgpt-fleet send --ref it-8401b4cbf5 --session codex-braid-root-vision-20261007 --operator codex-braid-root-vision-20261007 --model gpt-6-pro --file "$braid_review_dir/product.prompt.md"
```

Record actual conversation URLs and send receipts in the manifest before waiting. Use `wait ITEM --model gpt-6-pro --out PATH` in a supervised background process. Preserve tool errors distinctly; a finished turn is not necessarily an audit, and a model mismatch is not an acceptable substitute.

For an additional opinion on the same research question, use the existing item's `send --ref ITEM --second-opinion` route. Do not create a duplicate question to bypass the two-account limit.

## Acceptance and synthesis

Read each complete answer before acknowledging it. Check cited repository claims against actual source and open primary references before relying on them. Retain raw answers and conversation provenance; do not turn a reviewer assertion into a verified implementation fact.

The synthesis must include:

1. Agreements, substantive disagreements, and unsupported claims from each reviewer.
2. Accepted and rejected recommendations with reasons and owners.
3. A revised implementation sequence and the smallest useful vertical slice.
4. Concrete proof requirements, dependencies, stop conditions, and remaining user decisions.

Use the existing item for a follow-up that resolves a named disagreement. Do not use majority vote as validation. After integrating or rejecting an answer, record `ack --actions` or `ack --rejected`, then close the research item with an accurate `--answered` summary. The full conversations must remain exported through the normal fleet path.

No synthesis can be labeled independently audited until the requested model's actual answers have been captured and checked.

# Review synthesis and decisions

2026-10-07. The root read all three complete, independently prompted GPT-6 Pro answers. [Answer receipts](answer-receipts.json) retain original conversations, one verified send per item, served-model checks, and exact text hashes. Full native exports are deferred. Reviewers inspected source but ran no tests; their agreement is not experimental evidence.

Keep one canonical root AgentProfile. Its instructions and referenced artifacts define how the agent understands needs, chooses methods, authors children, and proposes revisions. Commitments, private knowledge, execution state, and authority retain their existing owners. No second profile language or Braid scheduler is justified.

The next claim should be useful bounded work with understandable continuity. Learning earns a separate claim only when revised methods beat a frozen root with the same memory and comparable resources. A useful conversation may produce no objective, delegation, or revision.

## Decisions, ranked

| Priority | Decision and benefit | Owner and deciding evidence |
| --- | --- | --- |
| 1 | Repair and prove the real Braid-to-cloud route. Retained sandbox state alone does not establish root wakeup or topology control. | Runtime/providers/Sandbox; Braid integration. Published compatible packages, exact admission identities, usable artifacts, restart and control evidence. |
| 2 | Ship a restrained starting profile through current profile selection. Let clear work, ambiguous needs, and conversation-only cases choose different actions without fixed domain roles. | Profile content. Check the result against each user's need and the strongest native baseline. |
| 3 | Connect one durable child outcome to one root continuation through existing Runtime and Platform owners. | Runtime admission, accounting, and fencing; Platform sleeping waits; Sandbox recovery. Kill the coordinator after result commit but before wake, start two contenders, deliver the outcome twice, and require one committed continuation. |
| 4 | Make revisions inspectable, withdrawable, and prospective. A correction need not masquerade as measured optimization. | Interface diffs, knowledge owner, Runtime activation, application atomic write, Braid review. Test stale baselines, duplicate activation, withdrawal propagation, rollback, and unchanged historical receipts. |
| 5 | Test method improvement separately from personalization and extra computation. | Eval and the selected improvement method. Frozen seed, equal-memory control, held-out situations, comparable resources, independent checks, and full development costs. |
| 6 | Build capabilities only when the recurring subproblem justifies acquisition and maintenance. | Root policy and artifacts. Compare direct work, code, data, skills, specialists, experiments, and people; retain a case where doing no capability development wins. |

These stages preserve the broader application space. Consulting, business, research, farming, finance, and personal support can share these mechanics while requiring different evidence and authority. The first pilot need not certify all of them. Large fleets, specialist training, marketplaces, and autonomous global revision remain conditional bets.

## Agreements and useful disagreements

All three reviewers reject a new optimizer in Braid, treating a successful process exit as objective acceptance, and treating a profile as private memory or permission. They favor exact artifact and execution identities, bounded recursive resources, and user corrections that remain understandable.

Architecture favors native execution inside a durable Runtime pursuit, with Platform wakeups. Product argues that the strongest native agent may remove most of the reason to switch. Accept both constraints: preserve native capabilities, and test benefit while holding the runner constant before attributing value to routing.

Learning distinguishes personalization, method improvement, capability improvement, and net product benefit. Adopt those separate claims. Observational runner advice cannot establish causal routing superiority. An unmeasured feedback draft stays unmeasured even when useful.

Product proposes a twelve-user, four-week adoption study and illustrative 20% effort and eight-user retention thresholds. Learning recommends choosing sample size after measuring variability and clustering. Use an instrumentation pilot first; freeze worthwhile effects, cost, and stopping rules before a later study. The suggested numbers are not validated acceptance criteria.

The reviews favor early usefulness experiments before finishing every lifecycle feature. Permit offline comparisons and explicit reviewed personalization now. Require durable event delivery, controls, and accounting before autonomous cloud activation or an always-on promise.

Do not require visible divergence between users, child creation, or a revision after every interaction. Those are possible outcomes, not success proxies. Do not replace the user's broad ambition with a permanently engineering-only product.

## Source checks and corrections

- Braid's `profile-learning.ts` returns `status: 'unmeasured'`; save and selection remain separate. The reviews' old dependency pins describe main at their inspection time, not the pending refresh. Package adoption and registry proof remain separate from source availability.
- Runtime 0.309.0 rejects unsupported root pause/resume/ask calls. That published source fix does not implement topology pause. The [durability inventory](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/docs/durability.md) assigns execution and workspace recovery to their existing owners. The root vision now explicitly names Platform as the sleeping-wait owner.
- Product identified Braid's first-match worker label fallback. Production callers already pass exact runtime IDs. A Beelink regression selected the wrong worker before the fix; the prepared exact-ID-only fix and label refusal passed all 37 affected supervision, dispatch, and attachment tests. The executable fix remains in the runtime refresh awaiting its final package gate. This fixes an existing consumer defect, not a proposed fleet feature.
- Learning identified the documented [promotion evidence boundary](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/mcp/tools/coordination.ts#L896-L910): the caller must bind a promotion decision to the sealed experiment's rows. Before integrating agent-authored promotion, require that binding through the owner contracts and test mismatched decisions. No current Braid automatic activation flow or exploit was demonstrated.
- Interface's installed declarations confirm that profile content is public identity and native subagent definitions are narrower than full profiles. Keep private knowledge outside exported profiles; do not promise equivalent execution of every profile field across native and cloud children.
- The Discovery link used the wrong branch. The immutable source link is now verified through its repository API. Native-product comparisons and cited coordination research remain reviewer assessments here; they were not independently benchmarked by this work.
- Two real cloud attempts failed before recovery. The diagnostic also had an event-projection capture bug and displayed an old admission snapshot. The [autopsy](../../../.agent/autopsies/2026-10-07-tangle-retained-diagnostic.md) records the correction and its 88 passing affected tests. Neither review agreement nor deterministic tests make those live attempts pass.

## Smallest complete flow and stop conditions

Begin with one profile, one authorized task, one real cloud child where useful, and an independently checked artifact. Preserve exact identities through the result-to-wake crash test. Then expand to the proposed two-child, one-grandchild topology, including offline completion, coordinator restart, steering, cancellation, and supported pause/resume. Unsupported pause remains an unmet requirement.

Separately compare a candidate method with an identical-memory frozen root. Include unclear needs, changed priorities, withdrawn preferences, obsolete commitments, and situations needing no action. Count user explanation, review, repair, all descendants, failed candidates, evaluation, and maintenance. Unknown costs stay unknown.

Stop expansion if benefit disappears against memory or compute controls, users must operate the organization themselves, or recovery cannot avoid duplicate effects and lost revocation. A small inconclusive pilot justifies no improvement claim. No further user choice is needed to record these decisions or finish the authorized dependency repair. A new prospective user study needs its own concrete scope and resource envelope.

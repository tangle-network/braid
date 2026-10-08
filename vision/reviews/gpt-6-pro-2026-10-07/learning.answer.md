I’ll separate what the supplied design proposes from what current source supports, then build the experimental program around independently checked outcomes. I’ll first check GitHub access and the maintained Braid, Runtime, Eval, and Discovery contracts; all work will remain read-only.

GitHub access works. Current Braid main still pins Runtime 0.263.0 and Eval 0.187.2. Newer Runtime source removes the misleading pause/resume/ask signal controls because they lacked an implemented effect; that clarifies the boundary but does not deliver the proposed pause-and-resume lifecycle. I’m checking where current learning code stops at drafting and where measured activation would need upstream support.

The current `/profile learn` path composes explicit feedback into an **unmeasured** profile draft; saving and selecting it are separate actions. That makes a memory-only comparison essential: otherwise remembering a correction could be mistaken for an improved working method. I also verified that the retained live advice attempt stopped at a routing 401 before any advice call, so it supplies no recommendation-quality evidence.

Upstream already has candidate search, held-out comparison, review, and activation contracts, so the audit will recommend reusing those. One ownership correction also matters: current Runtime documentation assigns sleeping timers and external-event wakeups to Platform Workflows; a live supervisor’s worker-return wake lasts with its coordinator. The proposed durable root needs a proven connection between those owners, not a scheduler inside Braid.

I found a concrete provenance gap in recursive profile promotion: Runtime verifies the experiment seal and the profile’s treatment-arm digest, but the promotion decision itself has no experiment digest. The caller must establish that the decision came from those rows. I’m also treating pursuit-version improvement as development evidence: that path uses one pursuit task and no held-out test partition.

# Executive judgment

**Continue with a bounded experimental program. The canonical-root architecture is coherent, but the inspected evidence does not yet demonstrate personal improvement beyond memory, additional computation, or continued work on the same task.**

An AgentProfile can define how the root listens, proposes objectives, authors children, chooses capabilities, and proposes revisions to those methods. Generality does not require a fixed hierarchy. It does require an independently enforced boundary between **proposing behavior, establishing its usefulness, and authorizing its execution**.

Separate four claims:

1. **Personalization:** retained information makes the agent more useful.
2. **Method improvement:** revised root behavior outperforms a frozen root given the same authorized information and resources.
3. **Capability improvement:** a new tool, dataset, procedure, specialist, or model improves subsequent work.
4. **Net product benefit:** those improvements justify development, evaluation, maintenance, and user burden.

All four can be valuable. None, by itself, demonstrates that the underlying model improved.

**Evidence labels:** “Inspected” below means source or documentation read during this audit, not executed verification. “Supplied” refers to your packet. Recommendations and protocols are proposals. I inspected no other audit conclusions and performed no experiments, training, deployments, or repository mutations.

## 1. What current implementation supports

### Inspected boundaries

I inspected Braid at [`5932e0d45507af9cad6b8918496b864d52f79be7`](https://github.com/tangle-network/braid/tree/5932e0d45507af9cad6b8918496b864d52f79be7), Runtime at [`849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7`](https://github.com/tangle-network/agent-runtime/tree/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7), and Eval at [`cd95bae5498f0cd39e442b3b0f15d062c271a2f6`](https://github.com/tangle-network/agent-eval/tree/cd95bae5498f0cd39e442b3b0f15d062c271a2f6). The two supplied vision documents entered Braid through [`bd27d985…`](https://github.com/tangle-network/braid/commit/bd27d9852d910cba2fdfd1fdce7375146d077fef).

Braid’s current `/profile learn` uses Eval’s preference-memory helper and Interface’s canonical guidance composition to create an explicitly **unmeasured** draft. Saving does not select it. The inspected feedback action interface exposes recording, listing, and preference summarization, but no withdrawal operation. These are useful foundations, with correction withdrawal still requiring integration. [Learning implementation](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/src/app/profile-learning.ts#L11-L60); [selection boundary](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/docs/05-profiles-and-connections.md#L131-L169); [feedback actions](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/src/app/task-feedback.ts#L14-L34).

The retained advice artifact records a routing authorization failure and `adviceCommands: 0`. It supplies no recommendation-quality result. [Retained evidence](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/artifacts/verification/profile-learning/live-advice-unavailable.json).

### Reuse the maintained improvement path

| Responsibility | Existing owner and implication |
|---|---|
| Exact profiles and changes | Interface’s `AgentProfile`, `AgentProfileDiff`, and `AgentCandidateBundle`; preserve the complete profile and referenced artifacts. |
| Candidate generation and execution | Runtime supports whole-profile and skill surfaces; the selected method determines candidate generation. |
| Comparisons and uncertainty | Eval’s `compareOptimizationMethods` separates training, selection, and final testing. Its integrity policies cover independent units, final-data exposure, and evaluator audits. |
| Review and activation | Runtime supplies `proposeAgentImprovement` → `reviewAgentImprovementProposal` → `createAgentImprovementActivation` → `executeAgentImprovementActivation`; the application supplies the atomic target write. |

These mechanisms are documented and, for method execution and activation boundaries, supported by inspected source. **Do not build a second optimizer in Braid.** The root’s chosen authoring or improvement skill can itself be a candidate surface. [Runtime improvement contracts](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/docs/improve.md#L336-L448); [actual method execution](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/improvement/method-execution.ts#L178-L235); [Eval comparison contract](https://github.com/tangle-network/agent-eval/blob/cd95bae5498f0cd39e442b3b0f15d062c271a2f6/src/campaign/presets/compare-optimization-methods.ts#L310-L365).

Compatibility remains unverified: Braid still pins Runtime **0.263.0**, Eval **0.187.2**, and Interface **2.13.1**; inspected newer Runtime requires Eval `>=0.209.1 <0.210.0` and Interface `^3.1.1`. Source availability does not establish a compatible published upgrade. [Braid dependencies](https://github.com/tangle-network/braid/blob/5932e0d45507af9cad6b8918496b864d52f79be7/package.json#L106-L116); [Runtime peers](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/package.json#L167-L170).

Discovery’s architecture also preserves profile-defined recursive behavior and shared owners. Its default branch is `master`, inspected at [`9e6118f…`](https://github.com/tangle-network/discovery/blob/9e6118f764bae60017dc3fc99c90fb93bd6dbf0f/docs/02-architecture.md). Two path probes failed and were resolved: `discovery/docs/02-architecture.md@main` returned **404, “No commit found for the ref main”**; `braid/docs/vision` returned **404, “Not Found”**; Braid’s actual directory is `vision/`.

## 2. Learning targets and admissible evidence

**Proposed evidence map:**

| Learning target | What can establish progress | What that evidence cannot establish |
|---|---|---|
| Understand preferences | User confirmation; correct retrieval and application in relevant situations; tests for scope and withdrawal | That an inference is a lasting preference, or that agreement signifies benefit |
| Identify candidate objectives | User assessment of relevance, independently reviewed feasibility, later usefulness | A universally correct objective or permission to pursue it |
| Decide whether to act | Deterministic authority checks; user assessment of timing and interruption; expert review where consequences require it | That every technically permitted action is worthwhile |
| Decompose tasks | Dependency and coverage checks where specifications exist; downstream completion and repair burden | Quality from the number or apparent sophistication of subtasks |
| Select harness or placement | Capability compatibility; contemporaneous paired measurements of outcomes, latency, reliability, and resources | Causal superiority from observational run history |
| Author child profiles | Canonical validation, bounded authority, and the children’s independently checked outcomes | Capability from a persuasive profile description |
| Create reusable capabilities | Contract tests or proofs where applicable; held-out task performance; measured maintenance and reuse costs | General reliability from development examples |
| Revise root behavior, including its authoring skills | Held-out improvement above an identical-memory frozen root, with regression checks and full accounting | Universal improvement or improved model weights |

Deterministic verification proves a specified property under specified assumptions. A program passing tests can still solve the wrong problem. Conversely, a conversation can help without producing a machine-verifiable artifact.

Do not automatically optimize the user’s values, emotional dependence, willingness to agree, appetite for risk, or execution permissions. Automatically adapting reversible presentation preferences can be reasonable under an existing update policy; changing objectives, professional judgment, or authority demands a different evidential and authorization standard.

Use task-specific outcomes and constraints. Keep correctness, relevance, burden, timeliness, and cost visible separately instead of collapsing them into a universal reward.

## 3. A concrete candidate lifecycle

### Capture different kinds of information separately

Every retained item should carry its source, time, scope, status, and dependencies:

- **Stored fact:** an attributed claim about the user or world, with freshness requirements.
- **Tentative inference:** a hypothesis that may guide a question.
- **Temporary context:** something valid for this situation or period.
- **Preference:** a conditional user choice, including exceptions.
- **Working method:** reusable agent behavior that can be compared experimentally.
- **Permission:** authority maintained outside editable behavioral text.

An explicit current instruction can govern the next decision immediately. That does not require rewriting an admitted profile or claiming that a learned method improved.

### Progress from evidence to activation

1. **Record the observation.** Preserve the original feedback and its relationship to the run. An approval to execute a tool is not task-quality feedback.

2. **Propose a bounded revision.** The root’s selected improvement method produces an exact canonical change, intended scope, rationale, supporting observations, counterexamples, and expected costs. “No revision justified” is a valid output.

3. **Qualify the candidate.** Validate profile and artifact identities, permissions, compatibility, and affected invariants. A change to a profile-authoring skill must be assessed through what its authored children do. A change to an improvement skill must not receive authority to rewrite its own acceptance rules.

4. **Freeze and compare.** Bind baseline, candidate, execution dependencies, data partitions, evaluator, stopping rules, and resource terms before final exposure. Keep final evidence inaccessible to candidate authors.

5. **Review and activate prospectively.** Use the existing Runtime activation contract. The product transaction should compare the expected source version, apply the exact reviewed target, and record its idempotent result. Activation applies at the next eligible admission boundary; ongoing runs retain their original receipts. Runtime’s existing transaction contract already requires target comparison and forbids fresh writes after authorization expiry. [Activation source](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/intelligence/activation.ts#L53-L118).

6. **Monitor, withdraw, or roll back.** Append a new decision identifying the failed revision and the selected replacement. Reconcile live work separately; selecting an old profile does not restore old permissions or undo external effects.

### Withdrawal and conflict handling

“Be concise in routine updates” and “give detailed research audits” are compatible scoped preferences. Resolve conflicts first through scope, circumstances, and explicit current instructions. Unresolved conflicts should remain visible rather than being averaged into a fabricated preference.

Withdrawing a correction makes it inactive; it does not automatically establish the opposite. Invalidate dependent summaries, compiled guidance, retrieval entries, and pending candidates. Otherwise the withdrawn instruction survives inside a profile even after its memory record changes.

Preserve historical run evidence without relabeling it. If deletion of private content is required, separate deletable payloads from provenance records and show the resulting evidence gap; do not fabricate an unchanged historical record.

## 4. Evaluate objective discovery without manufacturing work

Use two evaluation panels.

**Execution panel:** independently selected, approved objectives are fixed before assignment. This measures how well the agent solves work.

**Discovery panel:** situations are sampled *before* the agent decides whether work exists. This prevents success-rate inflation through selecting easy objectives and ignoring difficult needs.

The discovery panel should include:

| Situation | Appropriate success |
|---|---|
| A useful need is evident | Notices it and proposes a relevant, feasible next step |
| A consequential uncertainty remains | Asks a non-leading question whose answer can change the decision |
| Exploration | Helps examine possibilities while preserving uncertainty and avoiding premature commitment |
| Emotional support | Responds in the way the user needs, potentially through listening alone |
| Changed priorities | Reconsiders ongoing work and redirects within current authority |
| Obsolete commitment | Retires it and prevents old reminders or late results from reviving it |
| No useful intervention | Creates no objective and avoids unnecessary delegation |

Permit multiple acceptable responses. A single reference objective would often encode the evaluator’s priorities rather than the user’s.

Assess questions by decision relevance and interruption burden. Assess proposals by user relevance, feasibility, opportunity cost, and later usefulness. Record missed needs as well as unnecessary initiatives. Conversation length, agreement, task count, and retention are unsuitable substitutes.

Recorded conversations support evaluation of a decision at a frozen point. They do **not** reveal how the user would have answered a different question. Interactive and longer-term benefit therefore remains a prospective research question requiring later authorization.

Automatic judges can identify specific violations and organize evidence. They cannot certify that an inferred life objective benefits an individual. Research on LLM judging documents position, verbosity, and self-enhancement biases; it supports safeguards, not transferring personal authority to the judge. 

## 5. Fair comparisons and statistical discipline

### Use strong controls

| Arm | Persistent information | Reusable behavior |
|---|---|---|
| Strong native harness | Same relevant authorized context; normal native facilities | Competently configured native behavior |
| Frozen root | Ordinary within-episode context | Fixed profile and methods |
| Frozen root plus typed memory | Current authorized facts, preferences, and feedback | Fixed methods |
| Revised root plus identical typed memory | Identical information to the preceding arm | Candidate root methods or authoring skills |

The third arm is essential. Beating an agent denied known preferences primarily tests information availability.

Native baselines deserve their actual capabilities. Claude documents responsive background workflows and saved orchestration, with specific replay and interruption limits. Codex documents persistent, bounded Goals. Pi provides executable extensions; Pi Durable describes checkpointed task recovery as a separate framework. Deep Agents documents asynchronous workers whose updates interrupt the prior run and start another on the same thread. These are substantial comparison points, without implying Braid adapter support. 

### Separate the causal comparisons

For the method test, hold model, executable tools, datasets, placement, and available permissions constant. Allow child authoring through the same available contracts, charging all descendants. Give controls comparable deliberation and retry opportunities.

Also compare total product packages with their useful native features intact. If models or tools cannot be matched, label that result a product comparison; it cannot isolate the effect of learning.

Report operational performance at matched resource envelopes **and** cumulative costs including candidate generation and evaluation. Match actual usage where possible; equal caps can conceal unequal computation. Unknown billing remains unknown, including subscription usage and unreported descendant costs.

### Splits, repetition, and uncertainty

Separate development, candidate selection, and final evaluation by meaningful source units. Variants from one incident stay together. Hold out later situations and, when claiming transfer, task families or users.

Freeze candidates during final evaluation. Final peeking, including failed or interrupted attempts, consumes evidence. Eval already provides exposure tracking, but its documentation correctly assigns answer-file protection and actual author/evaluator separation to the host. [Eval integrity boundaries](https://github.com/tangle-network/agent-eval/blob/cd95bae5498f0cd39e442b3b0f15d062c271a2f6/docs/evaluation-integrity.md#L83-L129).

Repeat stochastic executions, but do not count repeated answers, sibling task variants, or correlated reviewers as independent users or problems. Blind candidate identity and randomize presentation order. Different model names or reviewer IDs do not establish independence.

Choose sample size after the instrumentation pilot reveals variability, clustering, missingness, and reviewer disagreement. Specify the smallest worthwhile benefit and unacceptable regressions, then assess whether an affordable design can distinguish them. There is no justified power estimate yet. Eval’s own documentation distinguishes estimator eligibility from adequate power. [Small-sample interpretation](https://github.com/tangle-network/agent-eval/blob/cd95bae5498f0cd39e442b3b0f15d062c271a2f6/docs/evaluation-integrity.md#L60-L81).

Block comparisons by contemporaneous model versions; changes trigger requalification. Include abandoned tasks, failed candidates, refusals, and users who discontinue participation. Analyze assignment, not only successful completion. User adaptation and carryover require explicit treatment: freezing the agent does not freeze the person.

Promotion requires a worthwhile prespecified benefit, acceptable uncertainty, intact authority constraints, and no unacceptable regression in critical cases. An inconclusive result means hold, not equivalence.

## 6. Capability investment and recursive evidence

### Choose the investment that addresses the bottleneck

| Option | When it is plausible |
|---|---|
| Direct work or existing capability | Rare need, adequate current performance, uncertain recurrence |
| Deterministic program | Stable transformation with checkable correctness |
| Retrieval dataset | Missing or changing evidence is the constraint |
| Skill or procedure | An inspectable sequence of decisions is reusable |
| Trained small model | Stable repeated mapping, suitable data, credible operational advantage |
| External experiment | Needed information requires observation |
| Person | Access, authority, tacit knowledge, or judgment is limiting |

Compare each option against direct work over a declared, uncertain reuse horizon. Count data acquisition, annotation, failed candidates, training, evaluation, integration, deployment, inference, maintenance, retirement, and human opportunity cost. Do not amortize over imaginary future demand.

Keep outcome quality and economics separate. Equal quality with cheaper inference is an efficiency gain. Better outcomes at higher cost may also be worthwhile. Neither deserves deployment automatically.

The root should be able to conclude: **“This occurs too rarely to justify a specialist; I will use the existing tool directly.”** Controlled coordination research provides a reason to test that choice: benefits vary with task structure, and additional coordination can degrade performance under bounded resources. It supplies no universal delegation threshold. 

### Children can propose; evidence determines what survives

Children may author further profiles and evaluation proposals within inherited authority. Their self-tests are development evidence. Acceptance must depend on an independently specified checker, user assessment, or external review, with protected evidence and recorded disagreement.

Two inspected seams matter:

- Runtime’s pursuit-version chain registers a **development claim**, one training task, and empty selection/test partitions. Progress there can reflect additional work on the same pursuit. [Actual split](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/durable/pursuit-versions.ts#L416-L432).
- Promoted profile entries pair a sealed experiment with a decision lacking an experiment digest. Runtime checks the seal, matching treatment profile, and promotion flag; the caller must establish that the decision came from those rows. Before accepting agent-authored promotion claims, close or constrain that seam through Eval/Runtime evidence binding. [Explicit limitation](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/mcp/tools/coordination.ts#L896-L910); [checks](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/supervise.ts#L1997-L2040).

Evidence transfers only with its assumptions. A parser’s checked properties may transfer across users; a personal preference does not. Model-sensitive delegation results require rechecking after model changes. Dataset, tool, profile, evaluator, deployment, or authority changes invalidate affected claims through dependency tracking.

Profile export transfers inspectable configuration and references. It does not transfer private memory, credentials, live jobs, model weights, or universal performance.

## 7. Audit of the durable lifecycle proposal

The proposed distinctions are sound, but ownership needs correction.

Current Runtime rejects non-cancellation root signals rather than silently accepting pause/resume/ask. That improves honesty without implementing those controls. Its durability documentation assigns **sleeping timers and external-event wakeups to Platform Workflows**. A live supervisor wakes on worker returns while its coordinator exists; journal recovery reconstructs that state. [Signal guard](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/src/runtime/supervise/supervisor.ts#L1149-L1155); [wake ownership](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/docs/durability.md#L158-L174).

Therefore, require these owner-level properties:

- **Durable inbox and crash-safe wake:** commit the outcome and a discoverable continuation obligation together, or provide a recovery scan that closes the gap. Notifications are hints. Repeated delivery must resolve to the same admission decision.
- **Fenced decisions:** coordinator generation, current authority, and objective revision must be checked when committing work. A proposal based on stale state cannot override accepted steering.
- **Exact subtree control:** distinguish admission closure, requested suspension, acknowledged suspension, and unresolved descendants. Concurrent grandchildren must inherit the effective control state.
- **Conserved reservations:** one authoritative admission/accounting owner reserves before spawning, including descendants and checking costs. Missing usage is not free; unenforceable provider spending cannot become a promised hard cap.
- **Honest recovery:** reconstruct pending approvals, immutable receipts, unconsumed events, worker bindings, and reservations. Reconcile uncertain executions before replacement. Checkpoint recovery cannot undo external actions or recreate unavailable native sessions.

Reuse Runtime’s journals, fenced SQL context, retained-run controls, Platform wake mechanisms, and Sandbox recovery. Braid remains the client that presents their acknowledged state.

The maintained conformance documentation reports several fault-test environments, including a host-loss flow with a shim control plane. Those reports do not establish the requested Braid-to-real-cloud consumer proof, which remains missing from this audit. [Documented proof limits](https://github.com/tangle-network/agent-runtime/blob/849144e47cc7c719b199a8cbfc2bfd2d2e7e41c7/docs/durability.md#L182-L211).

Do not require a complete fleet implementation before conducting offline falsification. Require the lifecycle proof before autonomous cloud activation and scale claims.

## 8. Three staged experimental protocols

All launches below require a separate decision. No experiment was run here.

### Experiment 1 — Instrumentation and candidate integrity

**Baseline:** frozen root, fixed memory, current feedback/draft path.

**Intervention:** a small hand-auditable set of histories exercising preference scope, correction, withdrawal, conflict, activation, rollback, and no-objective behavior.

**Acceptance:** deterministic assertions show exact provenance, no permission inflation, withdrawal propagation, unchanged historical receipts, idempotent activation, and honest unknown states. Inject every consequential fault class in the supplied lifecycle matrix.

**Envelope:** predeclare case count, candidate count, fault schedules, model calls, reviewer hours, deadline, storage, and spending bounds. A tractable integration extension is exactly the supplied root, two real cloud children, and one grandchild—after separate authorization—with disconnect, coordinator restart, steering, subtree cancellation, and supported pause/resume.

**Failure interpretation and decision:** failure means the evidence substrate needs repair. Passing permits semantic testing; it establishes no personal benefit. Unsupported pause remains a failed requirement, even if displayed honestly.

### Experiment 2 — Falsifying personal improvement

**Baseline:** strong native harness, frozen root, and frozen root with identical typed memory.

**Intervention:** develop root-method or authoring-skill revisions from earlier conversations; freeze selected candidates before evaluating new execution and discovery situations.

**Acceptance:** a prespecified worthwhile benefit survives memory and compute controls, including exploration, emotional-support, changed-priority, and no-objective cases, without unacceptable regressions.

**Envelope:** use Experiment 1 to choose independent situations, repeats, and reviewer allocation. Lock candidate attempts, final exposures, models, tools, user interruption allowance, budget, and stopping rules before launch. If affordable precision cannot resolve the worthwhile effect, label the study exploratory.

**Failure interpretation and decision:** gains disappearing against memory-only indicate personalization; disappearing under resource matching indicate computation. Uncertain results justify no promotion. A supported gain permits narrowly scoped, reversible activation followed by a fresh temporal evaluation.

### Experiment 3 — Reusable capability creation

**Baseline:** direct root work and the best existing capability.

**Intervention:** present recurring subproblem families plus a deliberately uncommon case. Let the root choose among reuse, direct work, a program, dataset, skill, specialist, experiment, or person.

**Acceptance:** later eligible tasks establish independently checked quality and acceptable total economics. Preserve a positive case where the correct choice is direct work with **no delegation or training**.

**Envelope:** predeclare admissible build options, candidate limits, data access, training allowance, evaluation and integration budgets, reuse horizon, maintenance assumptions, and retirement conditions.

**Failure interpretation and decision:** development-only gains indicate overfitting; unrecovered investment indicates an economic failure; unnecessary specialization indicates a decision-policy failure. Admit successful capabilities only to demonstrated scope, retain direct work where it wins, and retire uneconomic artifacts.

## 9. Ranked research risks and investment boundary

1. **Benefit is misdefined:** objective creation becomes paternalism or engagement optimization. Preserve user assessment, restraint cases, and multiple acceptable outcomes.
2. **Apparent learning is confounded:** memory, compute, tools, or task selection explain the gain. The factorial controls are indispensable.
3. **Evaluation becomes circular:** descendants author both claims and favorable verdicts. Enforce separation and bind decisions to measured evidence.
4. **Feedback changes the population:** users adapt, priorities drift, and successful users dominate retained data. Use temporal checks and retain withdrawals and attrition.
5. **Operational and economic gaps erase value:** missed wakes, uncertain effects, missing costs, and maintenance overwhelm local gains. Require owner-level proof and full accounting.

**The smallest result justifying continued investment** is one reproducible, reversible root-method improvement on a narrowly defined recurring personal need, above an identical-memory frozen root at comparable resources, with successful withdrawal and rollback and correct restraint. That warrants a larger experiment.

**The strongest result falsifying the approach within its declared scope** is a sufficiently informative series of fresh comparisons that rules out the user’s minimum worthwhile benefit: strong native or memory-only systems match or exceed the revised root, apparent gains are explained by information or additional resources, and capability investments fail to recover their full costs. Repeated unjustified objective creation would strengthen that falsification. A small, inconclusive pilot would not.

# Directions worth pursuing

Updated 2026-10-07. Ordered by recommended investment, including dependencies. These rankings are hypotheses to test.

The [root agent](root-agent.md) is domain-general. Engineering is a useful first comparison because artifacts can be checked; it does not define the agent's eventual scope. A well-configured native harness is the initial technical baseline. Other applications need comparisons against their actual substitutes and appropriate evidence of benefit.

The root AgentProfile defines how objectives and working methods emerge. The investments below provide capabilities it can choose; they do not prescribe a universal agent organization.

## Ranked investments

| Rank | Direction | Benefit | Limit and first useful proof |
| --- | --- | --- | --- |
| 1 | Capability-aware native and Tangle cloud delegation | Choose a mechanism that fits the task while retaining native strengths. | Shared verbs do not imply equivalent behavior. Complete a real cloud child through Braid, retrieve its artifact, and prove observation, steering, cancellation, and identity. |
| 2 | Durable pursuits | Leave and return to the same long-running work. | Saved chat is insufficient. Interrupt the coordinator, client, and worker; check budgets, workspace recovery, exact ownership, and duplicate effects. |
| 3 | Decisions linked to verified outcomes | Establish evidence for better allocation and profile changes. | Traces do not establish causality. Reconstruct actual choices, artifacts, failures, inclusive spending, and human interventions without double-counting children. |
| 4 | Evaluated AgentProfile revisions | Preserve useful working methods in user-owned, versioned profiles with rollback. | Feedback creates a candidate. Compare it with the baseline on held-out tasks using acceptance checks outside the candidate's control. |
| 5 | Conversational fleet supervision | Explain progress, disagreements, blocked work, spending, and decisions needing attention. | Fluent summaries can conceal stale state. Seed operational failures and measure the user's ability to detect and resolve them. |
| 6 | Learned delegation and harness selection | Learn when to stay solo, fan out, change harness, seek review, or stop. | Task, model, profile, and tool effects are confounded. Beat a strong fixed policy under comparable total resources before enabling automatic selection. |
| 7 | Skill, tool, and extension improvement | Fix recurring failure causes in reusable resources and capability selection. | More instructions and plugins can worsen behavior. Change one resource for one failure cluster; measure regressions and optimization expense. |
| 8 | Trace investigation that yields tested changes | Turn analysis into a diagnosis, candidate change, and experiment. | More analysts do not guarantee accuracy. Compare deterministic extraction plus one analyst with a bounded team; retain added analysis only when useful. |
| 9 | Adaptive workflows and competing approaches | Explore independent hypotheses, change decomposition, and stop unproductive branches. | Correlated errors and integration costs can erase gains. Compare with solo and native workflows, charging every branch and verification run. |
| 10 | Code improvement through isolated experiments | Repair tool or execution defects that instructions cannot fix. | Broad regression risk. Reuse Runtime's isolated improvement path, external checks, and normal review and release. |
| 11 | Reproducible profile packages and sharing | Transfer working methods with exact resources, requirements, provenance, and evidence. | Secrets, private history, subscriptions, and quality guarantees do not transfer. Reproduce a claimed task slice in a clean environment and another supported harness. |
| 12 | Reuse inside other products | Launch and direct the same durable work through product-specific interfaces. | Consumers should import Runtime and Cloud contracts, not Braid's terminal machinery. Prove a second consumer can reconnect, steer, and retrieve outcomes. |

The first five form the initial product. The remaining directions expand intelligence and distribution after execution and evidence are trustworthy. Marketplace rankings, a universal workflow language, default large fleets, and unattended production self-modification are deferred.

## Preserve the ownership model

An AgentProfile defines the reusable agent. A task or pursuit defines the particular outcome, constraints, and acceptance evidence. A run receipt records the exact execution. Keep live job state out of the portable profile and reuse maintained Runtime contracts rather than creating a Braid scheduler.

| Owner | Responsibility |
| --- | --- |
| Agent Interface | Canonical profiles, candidate differences, shared contracts and identity |
| Runtime and providers | Admission, delegation, execution, resource enforcement, control and recovery |
| Eval | Measurements, analysts, comparisons and candidate-search methods |
| Tangle Cloud | Placement, environments, persistent workspaces and hosted execution ownership |
| Braid | Conversation, user decisions, cited explanations, supervision and candidate review |
| Profiles and referenced artifacts | Objective discovery, profile authoring, working methods, learning and allocation policies |

One unit of work has one completion authority. Native goals, workflows, cloud supervisors, and optimizers compose through bounded assignments; they must not independently restart the same task. Native children remain distinct from Runtime workers in identity and accounting. The root can reconsider objectives with the user without silently changing a running task's acceptance criteria.

Natural-language instructions express strategy. Adapters establish supported behavior. Prompt portability does not prove that a native command, extension, or recovery guarantee exists on another execution path.

## Connect the product pieces

- `/ask` explains a frozen execution using cited evidence.
- Feedback records the user's judgment and corrections.
- `/profile learn` proposes an unmeasured profile revision.
- `/runner advice` offers an observational recommendation without changing execution.
- Eval compares exact candidates with their baseline.
- Live supervision explains current state and delivers steering through Runtime.

The Braid commands above exist, with the limits recorded in [evidence](evidence.md). Closing the loop through Eval comparisons and complete provider-backed fleet supervision remains an integration and verification target. Available library APIs are not proof of that user flow.

Local versus cloud analysis is a placement decision. The useful output is a correct diagnosis or tested change. Do not build a second optimizer or hardcode one universal research method into Braid.

## First convincing comparison

Choose one recurring engineering workflow. Compare a strong native harness, Braid with native delegation, and Braid with bounded Tangle workers. Include tasks where staying solo is correct.

1. Delegate a few independent tasks, then disconnect and reconnect Braid.
2. Return verified artifacts with correct ownership, spending, and unresolved-work records.
3. Identify one recurring failure from retained evidence.
4. Change one policy or profile resource and compare it on held-out work.

Freeze acceptance, starting artifacts, permissions, and task scope. Record model, tool, subscription, version, and compute differences. Count retries, children, analysis, evaluation, integration, cloud resources, and human rescues. Missing cost is unknown, not zero.

Measure verified completion, elapsed time, inclusive cost, recovery, and user effort. Start with an instrumentation pilot, then repeated trials on disjoint tasks. Retain negative results and abstain when evidence is insufficient. Reassess applicable claims after material provider, extension, or task-distribution changes.

Hundreds of workers become a scaling target only after this comparison shows useful throughput. The [evidence note](evidence.md) separates the current foundation from the capabilities this direction still needs.

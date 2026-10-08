# Braid vision

Updated 2026-10-07. Product direction and research bets, not a claim of shipped capability or a release checklist.

Braid should be the home for one user-facing agent whose evolving `AgentProfile` defines how it understands the user, discovers worthwhile objectives, develops capabilities, and learns from experience. Its domain and organization emerge from those interactions. Engineering is an initial proving ground, not the boundary of the product.

The same profile can define how to author child AgentProfiles, choose tools or harnesses, commission research, build a reusable solution, or simply remain in conversation. Different users can develop different methods and agent structures from the same starting profile. Braid supplies visibility and control; it does not hardcode that organization.

| Read | Purpose |
| --- | --- |
| [One evolving root agent](root-agent.md) | The central abstraction: objective discovery, recursive profile authoring, capability creation and personal evolution |
| [Durable root lifecycle](root-lifecycle.md) | Event wakeups, topology controls, shared budgets, recovery semantics, and failure tests |
| [Implementation path](implementation-path.md) | Delivery sequence revised after three independent GPT-6 Pro reviews |
| [Review synthesis](reviews/gpt-6-pro-2026-10-07/synthesis.md) | Accepted findings, source checks, disagreements, and the first deciding experiment |
| [Directions](directions.md) | Twelve ranked investments, their limits, ownership, and the first useful comparison |
| [Evidence](evidence.md) | Dated implementation boundaries and primary sources behind the strategy |
| [Moonshots](moonshots.md) | Larger conditional bets if model capability and reliable execution keep improving |

Start with one durable, understandable agent and one demonstrated benefit. Larger fleets, trained specialists, and continuing services are choices that agent may make when useful.

The [product contract](../docs/01-product-contract.md) still owns Braid's boundaries. Braid is a terminal client over Runtime. `AgentProfile` remains the only agent configuration. Runtime owns execution, Eval owns evaluation methods, and Tangle Cloud owns environments. Vision documents do not authorize new infrastructure, spending, or production changes.

Update these documents when evidence changes the next decision. Keep implementation status in its owning issue and release evidence, rather than accumulating parallel status reports here.

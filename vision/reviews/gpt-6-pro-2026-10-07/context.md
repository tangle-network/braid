# Shared review context

Prepared 2026-10-07 for three independent GPT-6 Pro research reviews. This is source material and a proposed vision, not evidence that the proposed system exists.

## User intent

The user wants one canonical AgentProfile at the first layer of Braid, the agent they converse with. It defines how that agent understands the user, identifies worthwhile objectives, decides whether action or conversation is appropriate, develops capabilities, authors child AgentProfiles through its chosen skills, and improves its own reusable behavior. A registry may offer starting profiles. Subsequent interactions can lead different users toward different profiles, methods, capabilities, objectives, and agent organizations. The runtime must not prescribe one universal hierarchy.

This is domain-general. Engineering and research are initial proof settings, not the intended product boundary. Consulting, business, farming, finance, trading, and continuing personal support were examples of possible applications, not authorization to deploy in those domains or a claim of professional competence. Some needs call for listening, clarification, or restraint rather than maximizing a numerical objective.

Capability creation is broader than spawning agents. The root could use an existing tool, write a deterministic program, train a small specialist model, gather a dataset, develop a procedure, commission an experiment, or involve a human. A learned decision should account for the cost of creating, verifying, integrating, and maintaining that capability, and whether it is likely to help future work.

The user explicitly requested full, deep independent audits with demanding expectations. Do not give a generic list of agent features or merely agree with the thesis. Distinguish general product architecture from domain-specific validation and deployment requirements.

## Required lifecycle

The user explicitly requires a responsive root that dispatches cloud agents, wakes when children return, pauses and resumes while a topology is live, and budgets across descendants. Audit the supplied lifecycle proposal as critically as the profile vision. Address durable inboxes versus transport notifications, crash-safe wakeups, conflicting user and worker events, exact subtree control, coordinator fencing, inherited reservations, unavailable native controls, and the limits of checkpoint recovery. Require deterministic failure tests and actual cloud consumer proof before making durability claims. Identify existing owner contracts before proposing another scheduler.

## Repository and implementation baseline

Primary repository: `tangle-network/braid`. Locally inspected base: `11f32f485e14e2f8f651d536a25c302227e3e9fd`, 2026-10-07. Inspect current main for the committed vision and source history. The source commit identifies the implementation baseline; the supplied packet carries the exact proposed root-agent and lifecycle documents so access limitations do not hide the design under review.

Verified in that source:

- Braid is a terminal client over agent-runtime, with a shared application core for terminal and JSONL control. It is not another agent loop, scheduler, profile compiler, model gateway, judge, or sandbox implementation.
- AgentProfile from agent-interface is the only agent configuration. Harness selection is a profile preference or run override, not agent identity.
- Providers own live processes and native sessions. Braid's local journal owns its conversation graph and user decisions. Identifiers for runs, sessions, environments, workers, interactions, branches, and profiles remain distinct.
- Runtime owns worker control and supervisor read APIs. Braid does not parse native output or supervisor-private files. Unsupported actions require capability checks, not simulated behavior.
- `/ask` analyzes a frozen run and creates separate cited evidence. Findings enter agent context only through explicit promotion.
- `/feedback accept|reject` stores explicit task judgments. `/profile learn` makes a reviewable canonical profile draft, explicitly labeled unmeasured. `/runner advice` requests observational advice and neither establishes causality nor automatically selects a runner.
- The latest retained live advice attempt failed workspace-routing authorization before any advice call. There is no live recommendation-quality result to extrapolate from it.
- Source package pins: Runtime 0.263.0, Interface 2.13.1, Eval 0.187.2. Nearby later source contains more durability, recursive coordination, and skill/profile/code improvement features. Later source availability is not proof of compatible published packages or Braid integration.
- The documented pinned root signal sink acts on cancel only; pause, resume, and ask are observational signals without an acknowledged runtime effect. Do not treat their names as implemented controls. Verify whether current upstream source changes this boundary.
- Existing local validation and packaged keyboard captures establish the recorded implementation checks, not automatic personal evolution, production fleet reliability, or measured superiority.

Useful primary repository paths to inspect through available tools:

| Repository | Paths |
| --- | --- |
| tangle-network/braid | `docs/01-product-contract.md`, `docs/04-runtime-contracts.md`, `docs/05-profiles-and-connections.md`, `docs/06-conversations-forks-and-analysis.md`, `src/app/profile-learning.ts`, `src/app/runner-advice.ts`, `src/adapters/runtime/supervisor-control.ts`, `package.json` |
| tangle-network/agent-runtime | `docs/improve.md`, `docs/durability.md`, `src/durable/pursuit-versions.ts`, `src/mcp/tools/coordination.ts` |
| tangle-network/discovery | `docs/02-architecture.md` |

Discovery's maintained architectural direction is recursive execution of an exact profile, task, inherited limits, and retained evidence. Behavior belongs in profiles and run-selected artifacts; there is no separate universal Discovery coordinator. Inspect current source before proposing reuse. If access fails, name the attempted repository/path and exact error, then reason from the supplied snapshot with that limitation.

## Current external comparison points

These are starting references, not permission to assume Braid adapters support them. Verify changing facts before relying on them.

- Claude dynamic workflows and ultracode: https://code.claude.com/docs/en/workflows
- Codex persistent goals: https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex
- Pi extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Pi Durable: https://earendil.com/posts/pi-durable/
- Deep Agents asynchronous workers: https://docs.langchain.com/oss/python/deepagents/async-subagents
- Controlled study of agent coordination: https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/

Native workflows already offer substantial parallelism and responsive conversation. Prompt keywords, resumable chats, native goals, background sessions, and cross-host durable pursuits do not necessarily have equivalent semantics. More workers, longer conversations, and richer traces are not outcome improvements by themselves.

## Review authority and evidence rules

This is a read-only research item. Do not create branches, commits, pull requests, deployments, paid resources, cloud workers, or external messages. The deliverable is your complete written audit in this conversation. Implementation may follow a separate decision.

Use primary sources where you make external factual claims. Mark inspected facts, supplied facts, inferences, and proposals distinctly. Never invent APIs, filenames, measurements, jobs, tests, or access. A tool returning no data or refusing access is a useful finding. Report uncertainty rather than filling gaps with plausible detail.

Keep AgentProfile canonical and Braid a client. If you believe those constraints make the objective impossible, explain the precise contradiction and smallest justified upstream extension. Challenge the proposal where needed, but do not replace it with a fixed role hierarchy or a domain-specific workflow platform without explaining the loss of generality.

Preserve useful native behavior, exact admitted profile versions, bounded delegated resources and permissions, explicit update authority, and source-linked evidence. A profile can propose changing its methods; editing itself does not create execution authority or retroactively change acceptance criteria.

Produce a substantial written analysis with concrete examples, prioritized decisions, implementation ownership, and falsifying experiments. Explain your recommendations and assumptions without supplying private internal deliberation. Do not ask clarification questions; state reasonable assumptions and identify choices that genuinely need a user decision. A concise executive decision should precede the detailed audit.

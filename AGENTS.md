# Braid operator contract

Read `README.md`, then `docs/01-product-contract.md` through `docs/10-upstream-strategy.md`, then the decision records before changing product behavior.

The repository-level instructions in `/home/drew/code/AGENTS.md` also apply.

## Non-negotiable boundaries

Braid is a terminal client over `agent-runtime`; it is not another agent runner.

`AgentProfile` from `@tangle-network/agent-interface` is the only agent configuration object.

A harness is one run preference inside a profile or run override; it is never agent identity.

Use the canonical model and harness helpers exported by `agent-interface` instead of maintaining a local compatibility table.

Ask each provider for capabilities and disable unsupported actions with a plain explanation.

Do not parse harness-native output, launch harness processes, materialize profile files, or read provider-private state from Braid.

Do not duplicate interaction, replay, session, checkpoint, fork, or runtime-control contracts inside Braid when the shared packages need an extension.

Do not read or write `.agent/supervisor` files from Braid; import the runtime-owned read and control APIs.

Components render immutable view models and emit typed intents.

Controllers own workflows, cancellation, event reduction, and side effects through ports.

The local event journal is authoritative for Braid's conversation graph and user decisions, while a provider remains authoritative for its live process and native session.

Every durable event is idempotent by `(run_id, event_id)` and every user action has a stable operation identifier.

Never conflate conversation, branch, turn, runtime run, provider session, environment, checkpoint, supervisor, or interaction identifiers.

Unknown interaction kinds must render through the generic `answerSpec` contract and fail closed if Braid cannot produce a valid response.

Credential values and secret-designated answers belong in the operating-system credential facility, an environment reference, or their bounded response path, never in profiles, SQLite, logs, snapshots, screenshots, or trace artifacts.

Sanitize untrusted terminal content before rendering and suppress OSC control sequences by default.

## Source reuse

Depend on the published `@earendil-works/pi-tui` package at an exact version.

Copy application-level code only when adapting it is materially safer than reimplementing the behavior.

Every copied or substantially adapted file must name its source repository, source commit, source path, and license in the file header and `THIRD_PARTY_NOTICES.md`.

Never copy Pi's or Kimi Code's agent loop, session core, model registry, provider adapters, authentication, or profile logic.

Keep a patch ledger for any vendored terminal-library code and add a regression test for every local patch.

## Proof required for changes

Run the narrow test first, then the complete local verification command relevant to the change.

Any change to a reducer or persisted event requires an idempotency, restart, and migration test.

Any change to streaming requires disconnect, replay, duplicate-event, and cancellation tests.

Any change to an interaction requires keyboard acceptance, decline, timeout, cancel, and restart tests.

Any visible UI change requires terminal captures at 40×12, 80×24, 120×40, and 200×60, plus a real keyboard walk-through.

Any pull request that changes a user flow requires a short terminal recording in addition to still frames.

Do not describe a fake-provider result as proof of a provider integration.

Do not use a model judge for facts that a deterministic assertion, process exit code, event ledger, or terminal frame can prove.

Release completion is defined only by `docs/08-verification.md` and `docs/09-delivery-plan.md`.

## Plain-language glossary

| Term | Meaning in Braid |
| --- | --- |
| Profile | The portable definition of one agent |
| Connection | Credentials and transport to a place that can run an agent |
| Runner | The coding program used for one run, such as Pi or Codex |
| Conversation | The user-visible history and its branches |
| Branch | One path through a conversation |
| Turn | One user input and its resulting activity |
| Run | One admitted execution of a turn |
| Provider session | A runner's continuity identifier |
| Environment | The local or cloud workspace containing the run |
| Interaction | A question, permission, or plan waiting for a user response |
| Analysis | A separate cited review of a frozen run |
| Supervisor | The runtime-owned tree of active worker agents |

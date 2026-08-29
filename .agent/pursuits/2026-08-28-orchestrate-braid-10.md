# Braid completion workflow

## Objective

Ship Braid as a production terminal for concurrent, durable agent work.

The release must start, stream, switch, branch, fork, ask, analyze, supervise, and control parallel sessions through current shared contracts.

Every component must have an implementation note that describes the smallest general design which satisfies its contract.

## Structure

The workflow is a pipeline with one integration barrier.

Three isolated implementation tracks run in parallel before integration.

1. Stream safety owns incremental sanitation, durable event safety, replay, cancellation, and output limits.
2. Multi-run product owns concurrent branch runs, focused-run state, controls, terminal workflows, and responsive presentation.
3. Runtime continuity owns retained reconnect, native continuation, exact worker control, and any missing shared runtime contract.

The integration branch accepts a track only after its narrow tests pass.

Shared package changes merge and publish before Braid consumes them.

## Coordination policy

- Three Luna-max workers write independent implementations in isolated worktrees.
- The operator owns architecture boundaries, integration, live checks, commits, releases, and final claims.
- Workers must extend current contracts and must not add provider-specific execution paths to Braid.
- Every durable event change includes idempotency, restart, and migration coverage.
- Every streaming change includes disconnect, replay, duplicate-event, cancellation, and finalization coverage.
- Every interaction change includes accept, decline, timeout, cancel, and restart coverage.
- Every visible workflow includes keyboard proof and captures at 40x12, 80x24, 120x40, and 200x60.
- A worker can request an upstream change, but the owning package must implement it.
- No track opens a separate Braid pull request.

## Expected worker count

Three concurrent workers run in each implementation wave.

The expected total is 12 to 18 worker turns across implementation, integration repair, live proof, and adversarial review.

## Waves

### Wave 1: foundations

- Make streamed output safe before it enters the journal or reducer.
- Replace the global active-run slot with branch-scoped active work and one explicit focus.
- Reproduce and repair retained Tangle reconnect with preserved failure evidence.
- Adopt the current runtime package only after its required API is proven.

### Integration barrier

- Integrate passing commits into one Braid branch.
- Resolve the state, migration, and adapter interfaces once.
- Run contract, type, dependency, performance, security, and full local checks.

### Wave 2: complete workflows

- Complete exact native continuation and same-session recovery.
- Complete portable conversation handoff and workspace fork through owning packages.
- Complete trace analysis actions from run details.
- Complete supervisor worker navigation, attach, steer, and acknowledged cancellation.
- Complete the conditional work strip, capability-driven selectors, help navigation, and truthful route copy.
- Create component notes and a complete source-to-component index.

### Wave 3: proof and delivery

- Run the current live CLI Bridge and Tangle matrix from packed artifacts.
- Prove concurrent sessions, retained reconnect, interactions, fork, analysis, attach, steer, cancel, cleanup, and replay.
- Capture dark and light terminal evidence at all required sizes.
- Record the changed user flows.
- Run three independent adversarial reviews after all implementation checks pass.
- Fix every valid finding and repeat the affected checks.
- Open one pull request per changed repository.
- Merge and publish dependencies in order.
- Install the published Braid package in a clean directory and repeat the release checks.

## Synthesis rule

Prefer one general owning contract over a Braid-only special case.

Prefer explicit identifiers and immutable projections over inferred global state.

Reject an implementation if it cannot prove restart, replay, cancellation, capability failure, and bounded resource use where those conditions apply.

The product is complete only when the published package passes the required live matrix and leaves no owned resource behind.

# Verification

## Completion rule

Braid is complete only when one immutable release build passes every required check and one machine-readable evidence manifest links each requirement identifier to reproducible evidence.

A build result does not prove a user flow.

A fake provider does not prove a live provider.

A screenshot does not prove keyboard behavior.

A model judge does not prove deterministic state or protocol facts.

A live happy path does not prove replay, cancellation, denial, timeout, or recovery.

## Required interfaces for proof

The terminal, headless interface, deterministic driver, and live-provider runs all compose the same application core.

No test-only reducer, profile validator, fork planner, interaction queue, or persistence implementation is permitted.

The deterministic provider and clock are test adapters at the same ports used by production adapters.

## Headless JSONL protocol

`braid rpc` reads one UTF-8 JSON object per line from standard input and writes protocol objects only to standard output.

Human-readable logs go to standard error.

The first command must initialize a protocol version and workspace.

### Command envelope

```json
{
  "version": 1,
  "requestId": "req-0001",
  "command": "initialize",
  "params": {
    "workspace": "/workspace/repo",
    "subscribe": true
  }
}
```

`requestId` is unique per client connection and is echoed by every direct response.

Braid defensively replays the most recent 256 request responses within an 8 MiB payload budget.
Clients must still keep request identifiers unique; durable mutation safety comes from `operationId`, which remains effective after the response window is evicted.

A command that can mutate durable Braid state or external state must include a caller-created `operationId` in its input envelope.

The identifier is globally stable across client connections and Braid process restarts.

For example, a send request has the following shape.

```json
{"version":1,"requestId":"req-0002","operationId":"op-01K1SEND","command":"send","params":{"conversationId":"conv-1","branchId":"branch-1","text":"Explain this failure"}}
```

Braid persists the operation identifier with a digest of the command and canonical parameters before external dispatch.

### Output envelopes

```json
{"version":1,"type":"ack","requestId":"req-0001","revision":12}
{"version":1,"type":"ack","requestId":"req-0002","operationId":"op-01K1SEND","revision":13}
{"version":1,"type":"event","sequence":41,"revision":13,"event":{"kind":"run.started"}}
{"version":1,"type":"state","requestId":"req-0002","revision":13,"state":{}}
{"version":1,"type":"error","requestId":"req-0003","code":"CAPABILITY_UNAVAILABLE","message":"Workspace fork requires checkpoint and fork support","retryable":false}
```

Events have a monotonically increasing application sequence and committed state revision.

Acknowledgement means Braid accepted and journaled the operation, not that an external effect succeeded.

External effect results arrive as events and state transitions.

An accepted send emits its admission state before completion and its terminal state after completion.

Errors use stable machine codes plus concise human text and never include secrets.

### Required commands

| Command | Purpose |
| --- | --- |
| `initialize` | Negotiate protocol, open workspace, configure subscription, and return build metadata |
| `get_state` | Return canonical semantic application state at one revision |
| `subscribe` / `unsubscribe` | Control application event delivery |
| `list_profiles` / `select_profile` / `validate_profile` / `save_profile` | Drive canonical profile workflows |
| `list_connections` / `upsert_connection` / `test_connection` / `select_connection` / `remove_connection` | Drive secret-free connection metadata workflows; credential bytes never enter JSONL |
| `set_run_override` | Set runner, model, effort, or mode for the next run |
| `new_conversation` / `list_conversations` / `open_conversation` / `rename_conversation` / `archive_conversation` / `delete_conversation` | Drive conversation navigation and lifecycle |
| `set_draft` / `send` / `queue` / `remove_queued` / `steer` | Drive input and active-run behavior |
| `respond_interaction` / `cancel_interaction` | Submit or cancel a typed interaction response with stable operation identity |
| `automation_list` / `automation_create` / `automation_update` / `automation_dry_run` / `automation_disable` / `automation_delete` | Inspect and manage scoped, audited interaction response rules |
| `cancel_run` | Request and await explicit cancellation state events |
| `branch` / `clone` / `plan_fork` / `execute_fork` | Drive conversation and workspace fork workflows |
| `ask` / `analyze` / `compare` / `promote_analysis` | Drive `agent-eval` workflows |
| `get_graph` / `get_activity` / `get_details` | Query semantic product views |
| `steer_worker` / `cancel_worker` | Drive typed runtime supervisor controls |
| `export` / `import_conversation` | Produce or safely restore a redacted conversation with a verified digest |
| `shutdown` | Persist state and apply configured detach or cancel behavior |

The published protocol schema marks every mutating command as operation-bearing and rejects it when `operationId` is absent.

This includes profile and connection changes, conversation and branch changes, conversation import, send and queue changes, interaction response, interaction automation, cancellation, fork execution, analysis and promotion, worker control, export creation, and deletion.

### Protocol behavior

Malformed JSON, unknown protocol version, duplicate request identifier with changed body, invalid command, invalid parameters, stale revision precondition, and command in the wrong state produce distinct stable errors.

Repeating an identical request identifier while its response remains in the bounded connection cache returns the original direct response.

Repeating a stable operation through a new connection reconciles the journaled operation instead of dispatching it twice.

Reusing an operation identifier with a different command or canonical parameter digest returns `OPERATION_CONFLICT` and dispatches nothing.

`get_state` can request a full state or named projection and never returns credential values or secret answers.

The protocol schema is published in the npm package and checked for backward compatibility within a major version.

End of input performs the same safe shutdown as `shutdown` with the configured default and returns a meaningful process exit code.

### Cancellation, restart, and evidence rules

Cancellation is a two-party operation.

Braid first records `run.cancel.requested`, then asks the runtime port for provider acknowledgement while the run is shown as `cancelling`.

Local stream abortion is only cleanup and never proves that the provider stopped.

An acknowledgement records `aborted`; a rejected, missing, or timed-out acknowledgement records `unknown` with the reason.

Production uses encrypted SQLite behind `StoragePort`, including the event journal, canonical projection, operation ledger, immutable run receipts, snapshots, backups, recovery markers, and content-key lifecycle.

It loads and verifies durable state before any dispatch, so a restart reconciles an existing operation identifier instead of starting the provider twice.

The deterministic memory journal remains fixture-only and composes through the same application ports.

`shutdown` is operation-bearing in JSONL, plain mode, command-key paths, signal handling, and the terminal command palette.

All of those paths commit one `application.shutdown.requested` event before waiting for idle or cancellation completion.

Assistant message text and every rendered part pass through the same sanitized character and line bounds before Pi TUI receives them.

The packed proof runs send, graph, unavailable command, retry, cancellation, and shutdown through terminal, RPC, and plain mode.

RPC and plain mode use separate stdout and stderr pipes; only terminal mode uses a pseudoterminal.

Visual state captures use one signal-triggered semantic record with a matching revision, and interaction and fork captures contain real fixture `answerSpec` and fork-preview data.

Every raster manifest records the Pi TUI, PTY, emulator, Node, `agg`, ImageMagick, font, color mode, packed binary, and tarball provenance.

Package proof builds an isolated copy, records a digest of the exact source copy, packs that build, and installs the resulting tarball before running the binary.

## Deterministic test adapter

The deterministic provider implements the production execution, profile validation, interaction, session, workspace, analysis, and supervisor ports without network or subprocesses.

Fixtures are declarative event schedules keyed by virtual time and caller operation.

The adapter can inject the following behavior.

- Text, reasoning, message-part replacement, tools, artifacts, warnings, usage, and terminal outcomes.
- Questions, permissions, plans, secret answers, cancellation, timeout, concurrent requests, stale response, and response conflict.
- Disconnect before event, disconnect after event before local commit, replay from cursor, duplicate event, out-of-order event, sequence gap, expired cursor, missing run, and provider restart.
- Start acknowledgement loss, idempotent retry, non-idempotent unknown result, cancellation acknowledgement loss, and late terminal event.
- Native session continuation, missing session, mismatched provider history, and fresh portable context.
- Workspace read and write, checkpoint, fork, independent destination mutation, and external operation failure at each boundary.
- Supervisor tree changes, steering acknowledgement, cancellation acknowledgement, worker exit, and lost control client.
- Analysis findings, invalid citations, late source event, budget termination, cancellation, and comparison asymmetry.
- Storage lock, commit failure, forced process death, migration interruption, integrity failure, and backup restore.

The fake adapter cannot satisfy any check labeled live.

## Verification layers

### Layer 1: static and package checks

Static checks include formatting, lint, strict type checking, dependency boundaries, exhaustive event handling, generated schema freshness, package exports, license inventory, vulnerability policy, and build.

The repository-owned module-cycle check walks every `src` TypeScript module, includes type-only imports and re-exports, resolves relative `.js` specifiers to `.ts`, reports exact strongly connected components, rejects a zero-module scan, and runs in `pnpm check` with a deterministic synthetic-cycle self-test.

The package test installs the packed tarball in a clean directory and runs `braid --version`, `braid --help`, one headless deterministic turn, and one virtual-terminal deterministic turn.

Its plain-mode workflow waits for observable startup, completion, unsupported-control, retry, and cancellation output before sending the next command; fixed sleeps cannot satisfy packed-package proof.

### W5 application-core, storage, and release checks

W5 has stable package entry points for `test:unit`, `test:contract`, `test:coordination`, `test:rpc`, `test:virtual-terminal`, `test:pty`, `test:storage`, `test:crash`, `test:security`, `test:performance`, `test:live`, `test:install`, `test:capture`, and `check:release`.

`test:storage` exercises the coordinator, the deterministic storage adapter, and the production SQLite adapter for atomic pending admission, serialized execution, duplicate reconciliation, conflict recording, encrypted payloads, WAL, foreign keys, replay cursors, missing history, projections, backups, approved-root and no-clobber enforcement, restore, retention, redaction, key destruction, migration interruption, lock handling, and commit failure.

`test:crash` runs a compiled child process that is killed before and after every SQLite commit boundary and every backup, restore-manifest, copy, move, install, cleanup, and publication boundary, then reopens the database and checks integrity and durable outcome state.

`test:security` checks protected headless key sources, operating-system credential availability, secret canaries, secret-designated interaction values, and production fail-closed behavior.

`test:install` and `test:pty` run the packed-package proof, while `test:capture` runs the deterministic terminal capture.

`test:live` runs the four protected live product commands in sequence and exits nonzero when any required provider service, credential, behavior, or cleanup proof is unavailable.

`test:coordination` includes a two-process native SQLite race that proves one external dispatch for one operation identifier.

`test:performance` records native SQLite append measurements at 10,000 and 100,000 events and verifies the resulting event count and integrity report.

It also measures terminal projection with 10,000 and 100,000 saved runtime workers.

The result reports changed-state and repeated-render distributions separately.

The native storage test commands fail with an explicit prerequisite when the exact encrypted SQLite package is absent; they never convert missing production coverage into a passing or silently skipped result.

The reducer property test generates 1,000 histories and compares incremental reduction with full replay by canonical projection checksum.

The production adapter, not `MemoryStorage`, is the proof source for encryption, crash recovery, backup, restore, content-key destruction, and concurrent reader/writer behavior.

### W5 requirement mapping

| Requirement | Proof in this repository |
| --- | --- |
| `AR-03`–`AR-07`, `AR-10` | `test/domain-ids.test.ts`, `test/domain-reducer.test.ts`, `scripts/check-boundaries.mjs`, `scripts/check-dependencies.mjs`, `test/scripts.test.ts` |
| `PR-09` | Restarted SQLite projection checksum and `StorageJournal.fromStorage` replay in `test/storage.test.ts` |
| `PC-08`–`PC-10` | `test/security.test.ts`, headless key validation, credential-port availability failure, and package metadata checks |
| `PC-11`, `PC-12` | `test/connections.test.ts`, `test/connection-lifecycle.test.ts`, `test/production-connection-actions.test.ts`, `test/production-connection-setup.test.ts`, and `test/security.test.ts` cover health classes, secure creation, typed blockers, shared credentials, authoritative removal identity, serialized cleanup, resolver loss, keyring false-return, crash recovery, replay, and preserved history |
| `CF-01`, `CF-08` | Branded graph identifiers, operation/effect records, duplicate-event and conflict tests in `test/domain-ids.test.ts`, `test/domain-reducer.test.ts`, and `test/coordination.test.ts` |
| `SE-01`, `SE-02`, `SE-06`, `SE-07` | Secret rejection, raw-byte canaries, wrong-key rejection, protected key-source tests, and dependency/license checks |
| `ST-01`–`ST-10` | Production SQLite encryption, atomic commit, duplicate/gap/replay, forced-kill, migration, integrity, retention/redaction, provider-state non-guessing, and concurrent-writer tests |

### Layer 2: unit and property checks

Unit checks cover parsers, canonicalization, digests, redaction, reducers, commands, selectors, view-model builders, layout, capability decisions, state machines, and storage queries.

Property checks generate event interleavings, branch operations, identifier values, Unicode content, dimensions, and replay failures.

Every generated failure records its seed and minimizes the counterexample.

Required property runs use at least 1,000 seeds in normal CI and 100,000 seeds in the release soak.

### Layer 3: shared-contract checks

Contract suites run unchanged against the deterministic adapter, CLI Bridge provider, Tangle provider, runtime run handle, supervisor control client, storage adapter, credential adapter, and analysis adapter where applicable.

The suite verifies capabilities against method behavior rather than trusting declarations alone.

It deliberately removes each capability and proves no forbidden method call occurs.

Shared upstream package checks `UP-01` through `UP-14` run in their owning repositories and their artifact links enter the Braid release manifest.

### Layer 4: headless application checks

Headless checks start the packed `braid rpc` binary as a subprocess and communicate only through JSONL.

They cover every required command, malformed input, concurrent requests, restart, operation idempotency, event subscription, state revisions, error codes, and clean shutdown.

Golden command transcripts are semantic JSON with unstable timestamps and generated identifiers normalized through declared fields.

No test imports an internal controller to claim headless protocol proof.

### Layer 5: virtual-terminal checks

Braid's test-only implementation of Pi TUI's public `Terminal` interface renders the real root component and application core at 40×12, 80×24, 120×40, and 200×60.

The adapter is derived from Pi's test helper with immutable source and license attribution because `@earendil-works/pi-tui@0.84.1` does not publish that helper.

The output assertion includes cell character, width, semantic style, cursor, focus, overlay bounds, clipped rows, and hidden content.

Fixtures cover empty, loading, ready, streaming, tool, interaction, queued, detached, reconnecting, cancelling, cancelled, failed, expired, unknown, fork preview, graph, analysis, activity, profile editor, connection setup, and storage failure.

Unicode fixtures cover ASCII, CJK, Hangul, Arabic and bidirectional markers, combining accents, zero-width joiner emoji, flags, skin tones, variation selectors, tabs, and malformed control input.

Resize fixtures change dimensions during IME composition, paste, streaming, modal interaction, and graph navigation.

Activity, graph, and analysis fixtures use one list-and-details keyboard contract at every reference size.

They prove that `Up` and `Down` preserve stable selection, `Enter` and `Right` open details, and `Left` equals `Esc` for back and close.

They also prove that long details wrap before pagination and retain their final evidence token at 40 columns.

A mounted terminal fixture opens `/activity`, observes a runtime child worker, rejects duplicate state from unchanged snapshots, and proves refresh stops after close.

The fixture also proves that a late refresh cannot render after close or application stop.

Runtime projection tests keep two runtime supervisors bound to two distinct Braid runs, even when snapshot order changes.

Worker control tests use the public identifiers returned by Braid and assert the exact runtime references delivered to `agent-runtime`.

When an active worker disappears, the fixture proves that its saved status changes to `unknown` without deleting its history.

### Layer 6: real terminal process checks

PTY checks launch the packed `braid` executable in a real pseudoterminal and send encoded keyboard input.

They assert process state, screen cells, cursor, terminal-mode cleanup, journal state, and headless-equivalent semantic state.

The required flow types a prompt, edits multiline input, selects profile and runner, streams content, expands a tool, answers an interaction, queues input, cancels a run, creates a branch, executes a fork preview, runs `/ask`, moves between saved analyses, navigates runtime workers and the graph, resizes, closes, and reopens.

Tests cover alternate-screen and inline modes, legacy and Kitty keyboard modes, `NO_COLOR`, 16-color, high-contrast, reduced-motion, and plain output.

The accessibility proof rejects every OSC title, hyperlink, progress, or equivalent metadata sequence; it does not allowlist individual OSC forms.

Forced `SIGINT`, `SIGTERM`, stream failure, and process kill verify terminal restoration and database recovery.

### Layer 7: live integrations

Live checks use published packages or exact release-candidate tarballs, actual provider services, actual runner binaries, real credentials supplied by protected release infrastructure, and real workspaces created for the test.

They never use mocked HTTP responses to claim provider success.

Each live check records date, region, machine, operating system, package versions and integrities, bridge and server versions, runner versions, profile digest, command, attempts, event counts, identifiers, usage, cost, wall time, outcome, cleanup result, and artifact hashes.

The public demo must use the same immutable tarball as package proof.

Its manifest records observed and estimated cost separately.

Its recording reaches the final analysis page and renders every model call.

### Layer 8: semantic evaluation

`agent-eval` evaluates only behaviors whose quality cannot be decided by exact assertions.

The judge is calibrated on seeded good, bad, and trivial-baseline examples before release cases run.

Calibration contains at least 12 paired examples across cited analysis usefulness, fork explanation clarity, permission explanation clarity, and comparison honesty.

The judge must prefer the intended better example on at least 11 of 12 pairs.

Every seeded good answer must meet its release threshold.

The judge must reject the trivial baseline on every category before its release scores are admissible.

The complete rubric, examples, model, effort, prompt, package version, raw outputs, scores, costs, and disagreements enter the evidence artifact.

Individual untrusted request and response values use the small structured-redaction limits.

Complete evaluation artifacts use separate 4 MiB value and 100,000-item limits, so all six cases remain present and hash-sensitive.

The judge executes through Runtime with one exact `AgentProfile` and a direct Tangle Router connection.

`BRAID_EVAL_API_KEY` supplies the protected credential.

`BRAID_EVAL_BASE_URL` defaults to `https://router.tangle.tools/v1`, and `BRAID_EVAL_MODEL` defaults to `glm-5.2`.

The profile sets a 2,048-token total completion limit through `max_completion_tokens`.

For GLM routes, it also sends `thinking.type: disabled` because GLM enables hidden reasoning by default and does not honor `reasoning_effort: none`.

A conflicting request limit fails before provider spend.

A failing or uncalibrated judge blocks semantic claims but cannot override passing deterministic facts.

### Layer 9: installation and release checks

The exact npm tarball installs in clean current supported macOS arm64 and Linux x64 environments.

Each environment verifies native database encryption, terminal startup, headless turn, path handling, credential adapter behavior, update check disablement, and uninstall without deleting user data.

The published package is downloaded from the registry after publication and its integrity and behavior are compared with the approved release candidate.

## Required live matrix

The CLI Bridge gate uses GLM 5.2 through OpenCode and Pi with Tangle Router, plus the configured Codex default.

Model discovery does not make every advertised model a release gate.

| ID | Path | Real proof |
| --- | --- | --- |
| LIVE-01 | CLI Bridge with Pi | Exact profile materialization, text, reasoning, tool, usage, native session continuation, event replay, explicit cancel, and terminal receipt |
| LIVE-02 | CLI Bridge with Codex | The same cross-family flow and a cross-runner handoff from the Pi source context |
| LIVE-03 | CLI Bridge interactive protocol | Real question or permission pauses the runner, reaches Braid, receives once and session responses, resumes, and rejects a stale duplicate |
| LIVE-04 | CLI Bridge restart | Run state becomes honestly unknown or recovers according to retained state; Braid never labels it cancelled or resubmits unsafely |
| LIVE-05 | Every advertised interactive bridge runner | Common conformance flow at a pinned minimum runner version; failures remove the interactive capability claim |
| LIVE-06 | Tangle inference | Real profile-backed inference route, streaming, usage, cancellation, and immutable receipt |
| LIVE-07 | Tangle sandbox | Ephemeral create, turn, observation, and deletion; retained exact lookup, forced process loss, replay, cancel retry, two-conversation concurrent streaming with focus switching, and confirmed cleanup |
| LIVE-08 | Tangle interaction | A retained cloud interaction remains answerable after Braid reconnect and continues once from the acknowledged response |
| LIVE-09 | Tangle workspace fork | Checkpoint, destination fork, independent destination file change, unchanged source file, and explicit cleanup of both environments |
| LIVE-10 | Confidential Tangle path | Requested placement remains unverified until valid attestation is checked; negative nonce and measurement tests fail |
| LIVE-11 | Runtime supervisor | Real root and worker stream, spend and status update, typed steering effect, typed cancellation effect, and reconnectable control |
| LIVE-12 | `agent-eval` trace analysis | Real source run freezes, the selected profile and connection execute analyst model calls through `agent-runtime`, usage and cost receipts settle, citations resolve, source remains unchanged, and selected finding promotion records provenance |

If a required live provider is unavailable, the release is blocked and the manifest reports the unavailable check rather than marking it skipped or simulated.

`LIVE-11` uses one reusable flow over the published `@tangle-network/agent-runtime/kernel` and `@tangle-network/agent-runtime/tui` APIs.

The flow rejects incomplete snapshots and requires an exact supervisor identifier, exact worker identifier, root status, worker status, and complete spend fields.

It observes a spend change while the worker remains running before it admits any control operation.

It retries one stable steering operation identifier, then requires a matching request digest, exact worker, and `delivered` Runtime acknowledgement.

It retries one stable worker-cancellation operation identifier, then requires a `cancelled` acknowledgement that names the terminated worker.

It reloads the snapshot after cancellation and rereads the same cancellation acknowledgement to prove reconnect persistence.

When a provider supplies the exact interactive reconnect contract, the flow records the opaque terminal takeover handle.

When no provider supplies that contract, the flow records the explicit unavailable reason and makes no attachment claim.

The check returns the `LIVE-11` measurement only after every required effect and reconnect assertion passes; it never returns a partial result.

### Tangle Sandbox durability stress

Run `pnpm test:live:tangle:sandbox:stress` against the public Sandbox endpoint.

The aggregate `pnpm test:live:tangle` command also runs `tangle-sandbox-braid-multirun.mjs` as part of `LIVE-07`.

The direct `pnpm test:live:tangle:sandbox:multirun` command runs the same proof when an operator needs only the concurrent-session path.

The command runs one canary before it starts the remaining cohort.

The default cohort contains three proofs with at most two concurrent proofs.

The command stops scheduling new proofs after any failure.

Each proof creates one retained cloud environment through Braid and records the exact six-field cloud identity.

When the provider does not report the required exact-control contract, the canary must fail before resource creation and the cohort must not start.

The proof kills the first Braid process after a committed provider cursor.

A fresh Braid process must reconnect to the same cloud execution without duplicate visible provider events.

A follow-up turn must solve a hidden workspace continuity challenge in the same cloud session.

Cancellation must become durable in the cloud and remain safe when the same request is retried.

Every proof checks the execution account before and after cleanup.

Every proof deletes only resources with its exact Braid ownership metadata.

The cohort reports each result and the minimum, median, p90, and maximum latency for every observed phase.

The cohort also reports observed tokens, costs, active-resource deltas, and explicit unavailable values.

The command fails when a cloud identity repeats, an account changes, evidence is missing, or one owned resource remains.

The multirun proof creates two independent conversations, streams both retained runs concurrently, and switches focus to each run.

It closes the activity browser before sending cancellation to the selected run.

It records the canonical cancellation dispatch event and operation before waiting for provider acknowledgement.

It cancels only the selected run, closes Braid, replays both runs after restart, and confirms exact cleanup.

The proof holds each provider turn for 180 seconds and allows 300 seconds per phase by default to absorb public startup variance.

When a phase fails, its artifact retains the latest semantic terminal frame and the latest frame-capture error.

The multi-run proof reads active ownership from `BraidState.activeRuns` and Work Strip items from the real `BraidViewModel`.

It also requires two actionable Work Strip rows in the packed terminal frame.

The release collector registers the multirun artifact below `live/tangle/evidence.json` and rejects `LIVE-07` when that artifact is absent, failed, incomplete, or not exactly clean.

### Current core-path observations

On 2026-08-09, the packed public setup, RPC dispatch, durable transcript, native continuation, process restart, and post-restart send passed separately against CLI Bridge commit `33695db` for Pi 0.83.0 with `tangle-router/glm-5.2` in 136.492 seconds and Codex CLI 0.147.0 with its default model in 43.462 seconds.

Both loopback-only Bridge instances used host execution for this product-flow check; both turns and the post-restart turn retained one provider session identifier.

The two records share source tree `5c411d9`, tarball SHA-256 `4008b3e9d48c8cc78043c733c79189e547e0aa2a49fa29dbb9c54bc2bfcc89bb`, and installed binary SHA-256 `141288e0fe917635d723b4b70d464dc49baff14cc356f54de1d3f8faa5d8254f`.

An aggregate run proved that the current bridge cannot enable its process-wide Pi isolation requirement and Codex 0.147.0 together because Codex receives a read-only `CODEX_HOME`; [CLI Bridge issue 130](https://github.com/drewstone/cli-bridge/issues/130) records the upstream defect, while the separate passing artifacts remain `artifacts/verification/live-core/pi.json` and `artifacts/verification/live-core/codex.json`.

These observations prove the shared core flow only; they do not claim the broader interaction, tool, replay-cursor, cancellation, Tangle, or analysis rows in the required live matrix.

On 2026-08-12, a production Braid cloud-execution cohort completed 20 Tangle Sandbox jobs with OpenCode and `tangle-router/glm-5.2`.

The cohort used four-way concurrency and completed in 198.554 seconds.

Per-job latency was 24.671 seconds minimum, 27.981 seconds median, 34.738 seconds p90, and 44.578 seconds maximum.

The jobs reported 10,180 input tokens, 460 output tokens, zero provider-reported model cost, and eight Sandbox compute-minutes.

All 20 provider environment identifiers were unique.

All 20 environments were absent after their turns, and active Sandbox count stayed at four.

The artifact is `artifacts/verification/live/tangle-sandbox-braid-execution-stress-production-20260812.json`.

Its SHA-256 is `1a38a26e97917073ef760525f7b18abbcca43fcf6faba54cf862e55e4886693c`.

This proves production ephemeral cloud execution, observation, concurrency, and cleanup only.

On 2026-08-15, the default retained production cohort passed 3 of 3 proofs at two-way concurrency.

The cohort used Braid commit `45c641b`, OpenCode, `tangle-router/glm-5.2`, and Tangle Sandbox.

It completed in 185.238 seconds.

Per-proof duration was 82.255 seconds minimum, 89.016 seconds median, and 96.213 seconds maximum.

Each proof killed its first Braid process with `SIGKILL`, started a fresh process, and restored one local run from the exact provider reference.

Every replay had unique fresh event identifiers and no overlap with events acknowledged before the process loss.

Each proof completed a follow-up turn in the same provider session.

Each cancellation was accepted, replayed for identical input, rejected for changed input, and observed as cancelled by the provider.

The six completed turns reported 9,231 input tokens, 1,992 output tokens, and $0 provider cost.

Token and cost data were unavailable for the three cancelled turns.

All three exact environment identifiers were unique and absent after cleanup.

The cohort-wide active Sandbox delta was zero.

One overlapping proof sampled an active delta of one while its sibling environment existed; exact identity checks still confirmed both deletions.

The three cgroup v2 samples reported 152–157 MB current memory, 630–633 MB peak memory, and a 2,048 MB limit.

The provider did not report machine identity, machine IP, effective CPU, disk use, storage, verified placement, verified region, or per-sandbox cost.

This cohort satisfies the retained create, process-loss recovery, replay, cancellation, and cleanup parts of `LIVE-07`.

The August 12 failure artifacts remain diagnostic history and are superseded by this passing cohort.

On 2026-08-21, this branch upgraded the provider cohort to interface `1.3.0`, runtime `0.143.0`, eval `0.149.0`, CLI Bridge adapter `0.9.4`, Tangle adapter `0.13.0`, and sandbox `0.31.0`.

The automated suite passed 782 of 782 tests on Linux, and the release self-check passed 32 of 32 tests, both with the deleted second sandbox parser and the published Sandbox run outcome as the only terminal result source.

`LIVE-03` and `LIVE-08` were attempted through their built-in checks: both emit `unavailable` because this environment holds no CLI Bridge interaction credential and no Tangle Sandbox credential, and the built-in check refuses to claim a row it cannot execute.

`LIVE-06`, `LIVE-07`, `LIVE-09`, and `LIVE-10` remain unavailable in this environment for the same reason, and no live claim in this record comes from a simulated provider.

## Runner conformance

CLI Bridge may advertise a runner as interactive only after the following real flow passes at its pinned minimum version.

1. Start a native bidirectional session with an exact profile.
2. Receive session creation, text, reasoning when supported, one tool request and result, usage, and terminal events without loss.
3. Continue with a second user turn in the same provider session.
4. Trigger a real question or permission when the runner protocol supports one and answer through Braid.
5. Disconnect after a recorded event, replay from the prior cursor, and receive no duplicate displayed part.
6. Inject one steer while active when supported and prove its effect in subsequent events.
7. Explicitly cancel and observe a terminal cancellation state.
8. Restart or reap according to the bridge contract and report the resulting state honestly.

A runner that lacks a native interaction path may remain advertised as one-shot or non-interactive with those capabilities false.

## Visual evidence

Every visible pull request captures the packed real binary, not a hand-authored mock screen.

The deterministic adapter supplies repeatable content for visual comparison, while the live matrix separately proves integrations.

Each affected state produces the following artifacts.

- A semantic cell snapshot for exact automated comparison.
- A plain-text frame for review and accessibility.
- An ANSI or asciicast capture preserving terminal behavior.
- A PNG at native reference dimensions for pull-request review.
- A short GIF or video for a changed multi-step flow.

The capture manifest records build digest, fixture, terminal type, dimensions, color mode, font and version for raster output, command, and artifact checksum.

Raster capture uses one pinned rendering tool and font in CI so image diffs are meaningful.

A reviewer performs the keyboard flow in a real terminal and links the recording plus final semantic state revision.

Screenshots must show empty, active streaming, interaction, fork preview, graph or analysis, narrow layout, and one failure or reconnect state before the first public release.

## Performance targets

Performance measures Braid overhead separately from provider latency.

Reference measurements run from the packed production build on a named dedicated Linux x64 CI machine with no competing job, and repeat on one current macOS arm64 machine.

Every report includes hardware, operating system, Node version, terminal, dimensions, database size, event count, warm or cold state, repetitions, minimum, median, p90, p95, p99, and maximum.

Startup reports split production composition, encrypted storage open, journal restore, application creation, terminal import, and first render.

Streaming and resize reports also include millisecond distributions for application commit, display queue, view projection, terminal view application, Pi render, terminal flush, and updates represented by each frame.

A streaming update counts as visible only after Pi completes its render, the headless terminal flushes the output, and the expected unique event marker appears in the terminal cells.

The packed startup entries use syntax and whitespace minification while retaining identifiers and source maps, and startup measurements execute the packed tarball rather than source files.

| ID | Boundary | Target |
| --- | --- | --- |
| PERF-01 | Process start to first visible frame, warm database and primed Node compile cache, 20 runs | p95 ≤ 250 ms |
| PERF-02 | Process start to first visible frame, cold 100,000-event database and a fresh empty Node compile cache for every run, 20 runs | p95 ≤ 1,000 ms |
| PERF-03 | Key byte received to updated frame while idle, 1,000 keys | p95 ≤ 50 ms and p99 ≤ 100 ms |
| PERF-04 | Runtime event received to updated frame at 100 events/s, 10,000 events | p95 ≤ 50 ms with zero missing or duplicate event |
| PERF-05 | Replay and reduce 10,000 committed events | p95 ≤ 2 seconds |
| PERF-06 | Open a 100,000-event conversation to useful recent viewport | p95 ≤ 2 seconds without loading all rendered rows into memory |
| PERF-07 | Resize across all reference dimensions during a 100 events/s stream, 1,000 resizes | p95 frame ≤ 100 ms with zero crash or invalid cell |
| PERF-08 | Idle application over 60 seconds after settling | median CPU ≤ 1% of one core |
| PERF-09 | Resident memory after opening a 10,000-event conversation | p95 ≤ 150 MiB |
| PERF-10 | Database growth for 10,000 small normalized text events excluding provider payload artifacts | ≤ 50 MiB before optional compaction |

A target change requires measured evidence, a decision record, and user-visible impact analysis before release.

Provider time to first token, total run wall time, model tokens, cost, and network latency are reported in live results but cannot be counted as Braid overhead.

## Usage and execution observation proof

Deterministic proof sends multiple `llm_call` events and one terminal cumulative usage event.

It proves that model-call count and latency accumulate while terminal token totals replace live estimates.

It proves that reported, estimated, observed-minimum, and unknown values survive storage and restart.

One conversation fixture includes direct turns, trace analyses, and an explicitly bound Runtime worker tree.

The fixture proves that all three groups remain separate and no call is counted twice.

One fake sandbox returns identity, account usage, subscription data, requested resources, verified placement, a cgroup sample, and a credential-bearing runtime URL.

The projected record must contain the safe hostname and reported facts.

It must not contain the URL path, query, bearer token, API key, SSH data, or secret value.

Terminal keyboard proof opens `/activity`, selects the execution row, and reads every reported and unavailable field.

Headless proof reads the same execution identifier, lifecycle, resource, account, and unknown-state fields.

The live Tangle sandbox check records sandbox account totals separately from per-run model cost.

It marks physical machine IP, effective allocation, and per-sandbox CPU, RAM, and storage cost unavailable unless the live provider reports them.

A sandbox `error` or failed terminal event must keep the Braid run failed while preserving measured usage and confirmed deletion.

A Runtime abort must reach any pending sandbox create request and settle the Braid run as aborted.

These checks guard [agent-runtime issue 781](https://github.com/tangle-network/agent-runtime/issues/781) and [agent-runtime issue 782](https://github.com/tangle-network/agent-runtime/issues/782).

## Reliability and recovery matrix

| Failure point | Required result |
| --- | --- |
| Before operation journal commit | No external dispatch occurs |
| After operation commit before dispatch | Restart dispatches once with the same idempotency key or reports manual resolution required |
| After dispatch before acknowledgement | Reconcile by operation or run identifier before retry |
| After event receive before database commit | Cursor does not advance and replay returns the event |
| After database commit before render | Restart reduction displays the committed event once |
| During interaction response | Same operation reconciles to accepted, conflict, stale, expired, or unknown without double answer |
| During explicit cancel | Status polling or replay reaches terminal cancel or honest unknown |
| During checkpoint | Same-key lookup finds the existing checkpoint, reports a digest conflict, or remains unknown while the provider is unavailable; it never creates another blindly |
| During environment fork | Same-key lookup finds the destination, reports a digest conflict, or remains unknown while the provider is unavailable; it never fabricates or duplicates it |
| During database migration | Original encrypted backup opens and no partial schema becomes current |
| During terminal mode change | Process cleanup restores cursor, echo, paste, keyboard, mouse, and screen modes |
| During analysis | Source remains immutable and a cancelled analysis retains bounded partial diagnostics only |

Each row has a forced-process-kill test at every durable boundary.

## Semantic release cases

| ID | Question | Better behavior the calibrated judge must recognize |
| --- | --- | --- |
| EVAL-01 | Can a user tell what a fork copied? | Names conversation, provider session, environment, checkpoint, and omitted state without false resume claims |
| EVAL-02 | Is a permission understandable? | Identifies exact subject, consequence, scope, and safe choices without burying the decision |
| EVAL-03 | Is `/ask` useful? | Gives actionable findings with valid citations, uncertainty, and no unsupported root cause |
| EVAL-04 | Is a comparison honest? | Shows every captured asymmetry, missing field, cost, and outcome before a verdict |
| EVAL-05 | Is reconnect status clear? | Distinguishes detached, reconnecting, cancelled, failed, expired, and unknown in plain language |
| EVAL-06 | Is profile incompatibility clear? | Identifies the exact unsupported field and valid choices without silently weakening the profile |

Each case runs on at least three representative source fixtures and includes a seeded poor output plus a trivial raw-data baseline.

## Comprehensive audit manifest

The comprehensive audit is available when a product decision needs every requirement record in one manifest.

It is not an npm publication prerequisite.

The audit requires `BRAID_RELEASE_ARTIFACT_ROOT` to name a real directory outside the clean source checkout.

Audit candidate creation writes one npm tarball, its package-file manifest, check streams, terminal captures, resumable state, and `release/checks.json` below that directory.

The collector executes 25 distinct prerequisite commands and materializes 43 exact `UP-*`, `LIVE-*`, `PERF-*`, `EVAL-*`, and `VR-03` records from their matching command outputs, for 65 check records covering all 154 requirement identifiers.

`verify:release` assembles this optional audit and never appears as one of its own prerequisite checks.

Publication uses a smaller direct acceptance path.

The candidate job runs `pnpm check` once, then `pnpm release:prepare` builds and uses one immutable package.

A code-free job endorses that exact package before publication.

After npm publication, the same clean-install, plain-flow, encrypted-storage, digest, architecture, and cleanup smoke runs for the candidate and registry package on Linux x64 and macOS arm64.

The publication process validates those four records, the package SHA-256, and npm provenance.

It writes `publication/proof.json` below the external artifact directory.

An isolated code-free job endorses the resulting release bundle before tagging the commit.

When the comprehensive audit runs, its report counts passed, failed, unavailable, uncaptured, and unrecognized check results separately.

Each report row includes its exact result.

The requirement total counts only rows backed by passed checks and present artifacts.

A separate job that checks out no source and executes no package code computes a complete file index and signs a fixed-format candidate or final endorsement with Ed25519.

The endorsement binds phase, repository, exact commit, version, and the SHA-256 of the complete file index.

Large recordings, raw traces, and live logs may live in immutable CI or release storage, while the manifest stores content hashes and authenticated links.

The manifest contains the following top-level data.

```json
{
  "schemaVersion": 1,
  "braidVersion": "0.1.0",
  "gitCommit": "<sha>",
  "packageIntegrity": "sha512-…",
  "startedAt": "<iso>",
  "finishedAt": "<iso>",
  "sourceState": {
    "clean": true,
    "commit": "<sha>",
    "treeSha256": "<tree-sha>",
    "tarballSha256": "<sha256>",
    "tarballArtifactId": "package-tarball",
    "specificationDigests": []
  },
  "dependencies": [
    { "name": "@tangle-network/agent-runtime", "version": "<exact>", "integrity": "sha512-…" }
  ],
  "environments": [
    { "id": "linux-release", "kind": "ci", "details": {} }
  ],
  "checks": [],
  "requirements": {
    "UX-01": { "checks": ["virtual-terminal"], "artifacts": ["80x24-frame"] }
  },
  "artifacts": [],
  "liveResources": [],
  "cleanup": [],
  "signatures": []
}
```

Each check records identifier, category, required status, command, working directory, environment identifier, start and end, exit code, attempt count, measured fields, result, stdout and stderr artifact hashes, and failure details.

An audit archive includes every check field and output digest.

The publication endorsement covers the exact package, package manifest, four platform-use records, and npm provenance.

The publication and tag jobs accept only the public key pinned in `release/endorsement-public-key.pem` and recompute the complete index before accepting its signature.

The private key exists only inside isolated endorsement jobs, which download fixed evidence, execute OpenSSL, delete the key, and run no repository or package code.

The verifier rejects check identifiers outside the fixed command list and the requirement identifiers extracted from these specification documents.

Every accepted check command must be one of the fixed commands below and its category must match that command.

Timestamps use canonical millisecond UTC form such as `2026-08-02T07:00:00.000Z`, and the recorded duration must equal their difference.

Measurements are typed scalar values, full distributions, or explicit unavailable or uncaptured records with a reason.

A distribution records unit, sample count, minimum, median, p90, p95, p99, and maximum as finite ordered numbers.

Passing checks set `failureDetails` to `null` and identify stdout and stderr as `{ "artifactId": "…", "sha256": "…" }`, including zero-byte output artifacts rather than omitting either stream.

The release verifier requires every stable command row below, rejects every unreferenced check, and requires `UP-*`, `LIVE-*`, `PERF-*`, and `EVAL-*` requirements to cite an identically named check record of the appropriate category.

Each requirement maps to one or more check identifiers and artifact identifiers.

A zero, null, unavailable, or uncaptured measured field remains in the manifest with its reason.

The verifier fails when a required identifier from any specification document is absent, duplicated, skipped, stale, unsigned, run against another build digest, or linked only to an inadmissible proof type.

Live resource cleanup records each environment, checkpoint, session, temporary repository, and credential with confirmed or unresolved state.

The release cannot complete with an unresolved externally billable test resource.

## Required repository commands

Implementation must provide the following stable scripts.

| Check ID | Command | Scope |
| --- | --- | --- |
| `repository` | `pnpm check` | Format, lint, strict types, boundaries, dependency/license metadata, deterministic checks, and the release manifest check |
| `unit` | `pnpm test:unit` | Unit and normal property tests |
| `contract` | `pnpm test:contract` | Shared port and capability conformance |
| `upstream` | `pnpm test:upstream` | Tagged owning-repository `UP-01` through `UP-14` checks and retained artifact digests |
| `coordination` | `pnpm test:coordination` | Durable effect admission, digest conflict, and dispatch serialization |
| `rpc` | `pnpm test:rpc` | JSONL protocol tests |
| `rpc-packed` | `pnpm test:rpc:packed` | Packed-binary JSONL protocol tests |
| `virtual-terminal` | `pnpm test:virtual-terminal` | Cell, layout, Unicode, keyboard, and state snapshots |
| `pty` | `pnpm test:pty` | Packed-binary real terminal keyboard and lifecycle tests |
| `storage` | `pnpm test:storage` | Encrypted production journal, migration, integrity, replay, retention, redaction, backups, and concurrent access |
| `crash` | `pnpm test:crash` | Production SQLite forced-kill recovery at every durable commit boundary |
| `security` | `pnpm test:security` | Secret canaries, terminal attacks, paths, fuzzing, and static analysis |
| `performance` | `pnpm test:performance` | Reducer, coordination, and storage overhead measurements; the full PERF-01..10 matrix lands in W12 |
| `property-soak` | `pnpm test:property:soak` | Release-only 100,000-seed randomized product check with retained seed range and digest |
| `live` | `pnpm test:live` | Aggregate protected live product flows |
| `live-bridge` | `pnpm test:live:bridge` | Required CLI Bridge and runner matrix |
| `live-bridge-release` | `pnpm test:live:bridge:release` | Strict `LIVE-01` through `LIVE-05` flow; narrower bridge smoke cannot satisfy it |
| `live-tangle` | `pnpm test:live:tangle` | Required inference, sandbox, interaction, fork, and confidential matrix |
| `live-supervisor` | `pnpm test:live:supervisor` | Runtime worker observation and control |
| `live-analysis` | `pnpm test:live:analysis` | Real frozen trace, `/ask`, restart, promotion, model-call, and usage path against the packed candidate |
| `eval` | `pnpm test:eval` | Judge calibration and semantic release cases |
| `install` | `pnpm test:install` | Packed package across supported release platforms |
| `capture` | `pnpm test:capture` | Deterministic baseline real-binary captures |
| `visual` | `pnpm capture:visual` | Deterministic real-binary state captures and manifests |
| `release` | `pnpm check:release` | Release manifest and evidence-set check |
| `verify:release` | `pnpm verify:release` | Assemble the optional comprehensive audit from collected result records |

The deterministic local commands are implemented in this repository.

The opt-in CLI Bridge flow and semantic evaluation implementation are present and execute when their configured runners are available.

The live driver writes portable profiles with separate runner, provider, and model fields, resolves a sibling CLI Bridge checkout by default, and supplies Pi's Linux `fs-jail` floor only when no operator policy is already present.

Managed Windows commands enter a non-breakaway kill-on-close Job Object atomically during creation through `PROC_THREAD_ATTRIBUTE_JOB_LIST`, then begin execution with their original arguments, environment, working directory, and standard streams.

The named Job Object host terminates residual members, waits for its active process count to reach zero, and writes a drain receipt only after cleanup is confirmed.

Forced cleanup uses a separate controller that opens the named Job Object, terminates it, and acknowledges success only after its active process count reaches zero.

Pull-request checks reproduce forced, natural-exit, RPC, detached-grandchild, and controlling-parent-crash cases, independently probe every fixture PID after cleanup, and run the portable cleanup matrix on Windows, macOS, and Linux.

Capability checks use the effective per-run values returned by `agent-runtime`; broader provider-environment support remains recorded as evidence but cannot enable an action that the composed run disabled.

When cancellation is unavailable, the live driver checks the rejected control against the completed run instead of starting another generation that cannot be cancelled.

Tangle, supervisor, and live-analysis commands return a typed unavailable result until protected credentials, deployments, and evidence stores are supplied.

The release workflow runs `pnpm check` once and uses `pnpm release:prepare` before publication.

It does not require provider, sandbox, supervisor, or analysis credentials.

Those settings remain inputs to explicit live audits.

After publication, `release:record-publication` validates direct candidate and registry use plus npm provenance.

The comprehensive collector and verifier remain separate commands for explicit audits.

## Verification acceptance

| ID | Required proof |
| --- | --- |
| VR-01 | Every requirement identifier in all plan documents maps to an admissible passing check for the exact release build. |
| VR-02 | Terminal and headless flows produce equivalent journal events and semantic state for every primary workflow. |
| VR-03 | Normal CI completes 1,000 property seeds and release soak completes 100,000 with saved seeds and no unresolved failure. |
| VR-04 | All twelve live checks pass with complete provenance, measured fields, artifact hashes, and confirmed cleanup. |
| VR-05 | Every advertised interactive runner passes the common live conformance flow at its recorded version. |
| VR-06 | All four reference sizes have semantic snapshots, plain frames, PNGs, and required flow recording from the real packed binary. |
| VR-07 | All ten performance targets pass with complete distributions and no hidden warm/cold or environment asymmetry. |
| VR-08 | Every forced-kill boundary reconstructs a correct state with no duplicated external operation or displayed event. |
| VR-09 | Judge calibration passes before semantic cases and the evidence manifest retains every raw input, output, score, cost, disagreement, package version, and artifact hash. |
| VR-10 | Usage and execution proof preserves all known and unknown states, reports no missing value as zero, matches terminal and headless output, and contains no credential-bearing field. The registry package matches the approved tarball and repeats its clean-install smoke on every supported platform. |

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

Errors use stable machine codes plus concise human text and never include secrets.

### Required commands

| Command | Purpose |
| --- | --- |
| `initialize` | Negotiate protocol, open workspace, configure subscription, and return build metadata |
| `get_state` | Return canonical semantic application state at one revision |
| `subscribe` / `unsubscribe` | Control application event delivery |
| `list_profiles` / `select_profile` / `validate_profile` / `save_profile` | Drive canonical profile workflows |
| `list_connections` / `test_connection` / `select_connection` | Drive connection workflows without exposing secret values |
| `set_run_override` | Set runner, model, effort, or mode for the next run |
| `new_conversation` / `list_conversations` / `open_conversation` | Drive conversation navigation |
| `set_draft` / `send` / `queue` / `remove_queued` / `steer` | Drive input and active-run behavior |
| `respond_interaction` | Submit a typed canonical response with stable operation identity |
| `cancel_run` | Request and await explicit cancellation state events |
| `branch` / `clone` / `plan_fork` / `execute_fork` | Drive conversation and workspace fork workflows |
| `ask` / `analyze` / `compare` / `promote_analysis` | Drive `agent-eval` workflows |
| `get_graph` / `get_activity` / `get_details` | Query semantic product views |
| `steer_worker` / `cancel_worker` | Drive typed runtime supervisor controls |
| `export` | Produce a redacted export and digest |
| `shutdown` | Persist state and apply configured detach or cancel behavior |

The published protocol schema marks every mutating command as operation-bearing and rejects it when `operationId` is absent.

This includes profile and connection changes, conversation and branch changes, send and queue changes, interaction response, cancellation, fork execution, analysis and promotion, worker control, export creation, and deletion.

### Protocol behavior

Malformed JSON, unknown protocol version, duplicate request identifier with changed body, invalid command, invalid parameters, stale revision precondition, and command in the wrong state produce distinct stable errors.

Repeating an identical request identifier while its response remains in the bounded connection cache returns the original direct response.

Repeating a stable operation through a new connection reconciles the journaled operation instead of dispatching it twice.

Reusing an operation identifier with a different command or canonical parameter digest returns `OPERATION_CONFLICT` and dispatches nothing.

`get_state` can request a full state or named projection and never returns credential values or secret answers.

The protocol schema is published in the npm package and checked for backward compatibility within a major version.

End of input performs the same safe shutdown as `shutdown` with the configured default and returns a meaningful process exit code.

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

The package test installs the packed tarball in a clean directory and runs `braid --version`, `braid --help`, one headless deterministic turn, and one virtual-terminal deterministic turn.

### W5 application-core, storage, and release checks

W5 has stable package entry points for `test:unit`, `test:contract`, `test:coordination`, `test:rpc`, `test:virtual-terminal`, `test:pty`, `test:storage`, `test:crash`, `test:security`, `test:performance`, `test:live`, `test:install`, `test:capture`, and `check:release`.

`test:storage` exercises the coordinator, the deterministic storage adapter, and the production SQLite adapter for atomic pending admission, serialized execution, duplicate reconciliation, conflict recording, encrypted payloads, WAL, foreign keys, replay cursors, missing history, projections, backups, approved-root and no-clobber enforcement, restore, retention, redaction, key destruction, migration interruption, lock handling, and commit failure.

`test:crash` runs a compiled child process that is killed before and after every SQLite commit boundary and every backup, restore-manifest, copy, move, install, cleanup, and publication boundary, then reopens the database and checks integrity and durable outcome state.

`test:security` checks protected headless key sources, operating-system credential availability, secret canaries, secret-designated interaction values, and production fail-closed behavior.

`test:install` and `test:pty` run the packed-package proof, while `test:capture` runs the deterministic terminal capture.

`test:live` exits nonzero with a precise external prerequisite message because live provider services and credentials are not available in this repository's deterministic test environment.

`test:coordination` includes a two-process native SQLite race that proves one external dispatch for one operation identifier.

`test:performance` records native SQLite append measurements at 10,000 and 100,000 events and verifies the resulting event count and integrity report.

The native storage test commands fail with an explicit prerequisite when the exact encrypted SQLite package is absent; they never convert missing production coverage into a passing or silently skipped result.

The reducer property test generates 1,000 histories and compares incremental reduction with full replay by canonical projection checksum.

The production adapter, not `MemoryStorage`, is the proof source for encryption, crash recovery, backup, restore, content-key destruction, and concurrent reader/writer behavior.

### W5 requirement mapping

| Requirement | Proof in this repository |
| --- | --- |
| `AR-03`–`AR-07`, `AR-10` | `test/domain-ids.test.ts`, `test/domain-reducer.test.ts`, `scripts/check-boundaries.mjs`, `scripts/check-dependencies.mjs`, `test/scripts.test.ts` |
| `PR-09` | Restarted SQLite projection checksum and `StorageJournal.fromStorage` replay in `test/storage.test.ts` |
| `PC-08`–`PC-10` | `test/security.test.ts`, headless key validation, credential-port availability failure, and package metadata checks |
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

The adapter is derived from Pi's test helper with immutable source and license attribution because `@earendil-works/pi-tui@0.83.0` does not publish that helper.

The output assertion includes cell character, width, semantic style, cursor, focus, overlay bounds, clipped rows, and hidden content.

Fixtures cover empty, loading, ready, streaming, tool, interaction, queued, detached, reconnecting, cancelling, cancelled, failed, expired, unknown, fork preview, graph, analysis, activity, profile editor, connection setup, and storage failure.

Unicode fixtures cover ASCII, CJK, Hangul, Arabic and bidirectional markers, combining accents, zero-width joiner emoji, flags, skin tones, variation selectors, tabs, and malformed control input.

Resize fixtures change dimensions during IME composition, paste, streaming, modal interaction, and graph navigation.

### Layer 6: real terminal process checks

PTY checks launch the packed `braid` executable in a real pseudoterminal and send encoded keyboard input.

They assert process state, screen cells, cursor, terminal-mode cleanup, journal state, and headless-equivalent semantic state.

The required flow types a prompt, edits multiline input, selects profile and runner, streams content, expands a tool, answers an interaction, queues input, cancels a run, creates a branch, executes a fork preview, runs `/ask`, navigates the graph, resizes, closes, and reopens.

Tests cover alternate-screen and inline modes, legacy and Kitty keyboard modes, `NO_COLOR`, 16-color, high-contrast, reduced-motion, and plain output.

Forced `SIGINT`, `SIGTERM`, stream failure, and process kill verify terminal restoration and database recovery.

### Layer 7: live integrations

Live checks use published packages or exact release-candidate tarballs, actual provider services, actual runner binaries, real credentials supplied by protected release infrastructure, and real workspaces created for the test.

They never use mocked HTTP responses to claim provider success.

Each live check records date, region, machine, operating system, package versions and integrities, bridge and server versions, runner versions, profile digest, command, attempts, event counts, identifiers, usage, cost, wall time, outcome, cleanup result, and artifact hashes.

### Layer 8: semantic evaluation

`agent-eval` evaluates only behaviors whose quality cannot be decided by exact assertions.

The judge is calibrated on seeded good, bad, and trivial-baseline examples before release cases run.

Calibration contains at least 12 paired examples across cited analysis usefulness, fork explanation clarity, permission explanation clarity, and comparison honesty.

The judge must prefer the intended better example on at least 11 of 12 pairs and reject the trivial baseline on every category before its release scores are admissible.

The complete rubric, examples, model, effort, prompt, package version, raw outputs, scores, costs, and disagreements enter the evidence artifact.

A failing or uncalibrated judge blocks semantic claims but cannot override passing deterministic facts.

### Layer 9: installation and release checks

The exact npm tarball installs in clean current supported macOS arm64, Linux x64, and Windows x64 environments.

Each environment verifies native database encryption, terminal startup, headless turn, path handling, credential adapter behavior, update check disablement, and uninstall without deleting user data.

The published package is downloaded from the registry after publication and its integrity and behavior are compared with the approved release candidate.

## Required live matrix

| ID | Path | Real proof |
| --- | --- | --- |
| LIVE-01 | CLI Bridge with Pi | Exact profile materialization, text, reasoning, tool, usage, native session continuation, event replay, explicit cancel, and terminal receipt |
| LIVE-02 | CLI Bridge with Codex | The same cross-family flow and a cross-runner handoff from the Pi source context |
| LIVE-03 | CLI Bridge interactive protocol | Real question or permission pauses the runner, reaches Braid, receives once and session responses, resumes, and rejects a stale duplicate |
| LIVE-04 | CLI Bridge restart | Run state becomes honestly unknown or recovers according to retained state; Braid never labels it cancelled or resubmits unsafely |
| LIVE-05 | Every advertised interactive bridge runner | Common conformance flow at a pinned minimum runner version; failures remove the interactive capability claim |
| LIVE-06 | Tangle inference | Real profile-backed inference route, streaming, usage, cancellation, and immutable receipt |
| LIVE-07 | Tangle sandbox | Environment create, profile validation, turn, replay after client restart, workspace read/write/exec/git, run cancel, and retained environment |
| LIVE-08 | Tangle interaction | Replayed cloud interaction remains answerable after Braid reconnect and the session continues from the response |
| LIVE-09 | Tangle workspace fork | Checkpoint, destination fork, independent destination file change, unchanged source file, and explicit cleanup of both environments |
| LIVE-10 | Confidential Tangle path | Requested placement remains unverified until valid attestation is checked; negative nonce and measurement tests fail |
| LIVE-11 | Runtime supervisor | Real root and worker stream, spend and status update, typed steering effect, typed cancellation effect, and reconnectable control |
| LIVE-12 | `agent-eval` trace analysis | Real source run freezes, analyst executes, citations resolve, source remains unchanged, and selected finding promotion records provenance |

If a required live provider is unavailable, the release is blocked and the manifest reports the unavailable check rather than marking it skipped or simulated.

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

| ID | Boundary | Target |
| --- | --- | --- |
| PERF-01 | Process start to first visible frame, warm database, 20 runs | p95 ≤ 250 ms |
| PERF-02 | Process start to first visible frame, cold 100,000-event database, 20 runs | p95 ≤ 1,000 ms |
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

## Release evidence manifest

The release process writes `artifacts/verification/<version>/manifest.json` and a readable `report.md`.

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
  "sourceState": {},
  "dependencies": [],
  "environments": [],
  "checks": [],
  "requirements": {},
  "artifacts": [],
  "liveResources": [],
  "cleanup": [],
  "signatures": []
}
```

Each check records identifier, category, required status, command, working directory, environment identifier, start and end, exit code, attempt count, measured fields, result, stdout and stderr artifact hashes, and failure details.

Each requirement maps to one or more check identifiers and artifact identifiers.

A zero, null, unavailable, or uncaptured measured field remains in the manifest with its reason.

The verifier fails when a required identifier from any specification document is absent, duplicated, skipped, stale, run against another build digest, or linked only to an inadmissible proof type.

Live resource cleanup records each environment, checkpoint, session, temporary repository, and credential with confirmed or unresolved state.

The release cannot complete with an unresolved externally billable test resource.

## Required repository commands

Implementation must provide the following stable scripts.

| Command | Scope |
| --- | --- |
| `pnpm check` | Format, lint, strict types, boundaries, schemas, licenses, and build |
| `pnpm test:unit` | Unit and normal property tests |
| `pnpm test:contract` | Shared port and capability conformance |
| `pnpm test:rpc` | Packed-binary JSONL protocol tests |
| `pnpm test:virtual-terminal` | Cell, layout, Unicode, and state snapshots |
| `pnpm test:pty` | Packed-binary real terminal keyboard and lifecycle tests |
| `pnpm test:storage` | Encrypted production journal, migration, integrity, replay, retention, redaction, backups, and concurrent access |
| `pnpm test:crash` | Production SQLite forced-kill recovery at every durable commit boundary |
| `pnpm test:security` | Secret canaries, terminal attacks, paths, fuzzing, and static analysis |
| `pnpm test:performance` | All required Braid overhead measurements |
| `pnpm test:live:bridge` | Required CLI Bridge and runner matrix |
| `pnpm test:live:tangle` | Required inference, sandbox, interaction, fork, and confidential matrix |
| `pnpm test:live:supervisor` | Runtime worker observation and control |
| `pnpm test:live:analysis` | Real frozen trace and analyst path |
| `pnpm test:eval` | Judge calibration and semantic release cases |
| `pnpm test:install` | Packed package across supported release platforms |
| `pnpm capture:visual` | Deterministic real-binary captures and manifests |
| `pnpm verify:release` | Validate and assemble every required result into one signed evidence manifest |

The live-provider, evaluation, and final evidence-manifest commands remain later release surfaces; the W5 commands above are implemented in this repository.

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
| VR-10 | The registry-published package matches the approved tarball integrity and repeats its clean-install smoke on every supported platform. |

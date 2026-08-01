# Security and privacy

## Security posture

Braid sits between a user, untrusted repositories, agent runners that can execute tools and modify files, local credentials, cloud accounts, terminal emulators, and model-generated content.

Its default behavior must fail closed at every permission, credential, path, control, and interaction boundary.

A polished approval dialog does not make an unsafe transport safe.

Braid cannot ship an interactive runner path that auto-approves requests beneath the interface.

## Protected assets

- Local and cloud provider credentials.
- Hub connection grants and capability tokens.
- Model prompts, transcripts, reasoning, tool arguments, tool results, traces, and analyses.
- Source code, uncommitted workspace changes, files outside the workspace, and repository credentials.
- Profile instructions, resources, hooks, MCP configuration, permissions, and confidential-execution policy.
- Cloud environments, checkpoints, placement information, and attestation evidence.
- User interaction decisions, automation rules, and feedback trajectories.
- Local database encryption keys, update metadata, and diagnostic exports.
- Terminal clipboard, title, links, notifications, and image channels.

## Trust boundaries

| Boundary | Untrusted or partially trusted input |
| --- | --- |
| Terminal input | Pasted control characters, bracketed paste ambiguity, IME sequences, mouse reports, and hostile terminal capability claims |
| Rendered output | Model text, tool output, filenames, diffs, URLs, markdown, runner logs, provider errors, and raw events |
| Workspace | Project Braid configuration, profile files, symlinks, hooks, MCP commands, resource destinations, Git metadata, and files changed during a run |
| Profile source | Remote resources, provider catalog values, namespaced extensions, commands, headers, environment, and permissions |
| Local runner | Native process, private session files, emitted events, permission requests, and subprocess tree |
| CLI Bridge | Endpoint identity, bearer auth, server version, replay state, materialization, and backend policy |
| Tangle services | Authentication, account or team scope, placement, sandbox server, replay, attestation, checkpoint, and environment lifecycle |
| Analysis | Trace content, analyst model output, citations, tool access, and promoted findings |
| Extension or copied code | Dependency package, adapted source, update, and runtime permissions |
| Local state | SQLite database, WAL, backups, config files, logs, caches, and exported bundles |

## Permission model

The canonical profile permission value remains `allow`, `ask`, or `deny`, including per-subject object policies.

Braid never interprets absent permission as allow.

The provider validates the effective profile and reports the policy it can honor.

An interactive `ask` is supported only when the runner, transport, provider adapter, runtime, and Braid response path all report support.

If any layer cannot carry the request and response, admission fails or the profile must explicitly select a non-interactive allow or deny policy before the run.

The current CLI Bridge ACP first-option auto-approval and OpenCode headless allow defaults must be removed from interactive mode before release.

Benchmark or unattended execution may retain explicit auto-approval only under a separately named execution mode, submitted profile policy, isolated placement, and audit receipt.

### Permission interaction

The dialog shows profile, runner, run, workspace, subject type, exact target, sanitized detail, requested action, allowed response scopes, automation match, and timeout.

File permissions resolve canonical paths and show whether the target is inside the trusted workspace, outside it, a symlink, missing, or changed since request.

Shell permissions show executable, argument vector, working directory, environment variable names, network policy, and whether a shell interpreter is involved.

URL permissions show normalized scheme, host, port, path, redirect policy, and credential-header presence without values.

Diff permissions show target path, mode changes, line counts, binary status, and bounded content.

Agent or skill permissions show source profile and delegated capability scope.

The renderer does not derive the action target from prose when the interaction subject contains structured fields.

An invalid or unknown subject still permits deny and cancel but blocks broad approval until the provider supplies an answer the shared schema can validate.

### Approval scope

Allow-once applies to one interaction identifier.

Allow-session applies to one provider session, profile digest, runner, connection, and workspace trust digest.

Persistent allow applies only to an explicit structured matcher and expires or disables on scope change.

Braid never converts allow-session into a profile edit.

Automation conflicts, malformed requests, stale interactions, and unknown provider state fail closed.

Every response uses a stable operation identifier and waits for a provider acknowledgement.

## Credential handling

Credential values are stored in the operating-system credential facility and referenced by opaque identifier.

macOS uses Keychain, Windows uses Credential Manager, and Linux uses the current supported Secret Service implementation.

A Linux environment without a usable Secret Service cannot persist a credential silently.

It may use an environment-variable reference, a protected file descriptor supplied by the caller, or session-only input after explaining persistence behavior.

Configuration files and SQLite contain credential names and references only.

Environment-variable references store the variable name, never its value.

Secret interaction answers are held only long enough to validate and submit the response and are excluded from journal events, drafts, history, logs, clipboard actions, traces, screenshots, crash reports, and feedback.

An interaction containing a secret answer field cannot be converted into an automation rule; manual response is the only first-release path.

JavaScript cannot guarantee that a secret has been physically erased from process memory, so Braid minimizes copies and lifetime rather than claiming memory erasure.

Provider clients receive only the credential needed for the selected connection and operation.

Credentials from unrelated organizations or connection records are never pooled or tried as fallback.

Authentication errors never echo response headers, request headers, token prefixes, or complete endpoints containing user information.

## Local state encryption

Braid encrypts its SQLite database and WAL at rest with SQLCipher or an equivalently reviewed SQLite encryption implementation.

The database key is a random 256-bit value stored in the operating-system credential facility and never written beside the database.

Each conversation also receives a random content key stored only in that credential facility.

Journal payloads are encrypted with the conversation content key before entering the already encrypted database, so database, WAL, and backup files contain no conversation content key.

Encrypted backups use the same protected database-key generation or an explicit user-supplied export passphrase with a memory-hard key derivation function and recorded parameters, but they never embed conversation content keys.

Headless environments without a credential facility must receive the database key through a protected file descriptor or a mode-0600 key file outside the workspace.

Passing a state key directly on the command line is rejected because process listings and shell history can expose it.

The selected current SQLite binding must prove encryption is active by reading raw database, WAL, and backup bytes for seeded transcript markers during release tests.

File permissions restrict database, WAL, backups, and configuration to the current user.

Application-level redaction still occurs before encryption because decrypted exports, logs, and views must remain safe.

## Retention and deletion

Default retention is local and indefinite until the user changes it, with telemetry disabled.

The user can configure retention by conversation age, completed-run age, trace age, analysis age, tool-output size, and cache size.

Retention never cancels live runs or destroys cloud environments implicitly.

Deleting a conversation identifies linked active runs, provider sessions, environments, checkpoints, analyses, exports, and backups before action.

Local conversation deletion first blocks new writes to that conversation, writes a non-sensitive tombstone, removes its projections, destroys its conversation content key, checkpoints and truncates WAL, and then compacts the encrypted database according to policy.

Destroying the content key makes payload ciphertext in the current database and retained backups unreadable even before physical compaction.

Individual event redaction performs an exclusive rewrite of the remaining conversation payloads under a new content key, verifies replay and marker absence, atomically installs the rewrite, and only then destroys the old key.

Failed rewrite verification leaves the old key and database intact and reports that redaction did not complete.

Because flash storage and external backups may retain old blocks, Braid states that local deletion cannot prove physical erasure from every storage layer.

Conversation-key destruction, database-key rotation, and encrypted backup deletion provide the strongest practical local crypto-erasure boundary.

Cloud environment, checkpoint, provider transcript, trace, and account deletion are separate provider operations with independent confirmation and evidence.

## Workspace trust and paths

Project-controlled configuration is inactive until the workspace identity and configuration digest are trusted.

Trust review includes `.braid/config.json`, selected profile sources, hooks, local MCP commands, resource destinations, environment references, and executable files.

All Braid local paths are converted to canonical absolute paths before policy checks.

Operations use file descriptors or no-follow flags where available and recheck identity before mutation to resist symlink replacement.

Writes reject path traversal, NUL bytes, device files, sockets, FIFOs, hard-link surprises where detectable, and destinations outside allowed roots.

Reading a path does not imply permission to execute or write it.

Workspace changes between approval and execution invalidate the approval when they change the resolved target or content digest.

Braid never changes process `HOME` to materialize a runner profile and never writes runner-native configuration itself.

CLI Bridge remains responsible for its hardened temporary profile materialization and cleanup.

## Command and process safety

Built-in slash commands invoke typed application functions and are never interpolated into a shell string.

Profile resource commands are submitted through the shared profile/runtime path and are not executed by Braid.

Workspace execution uses provider typed APIs and a structured preview.

If an external package accepts only a shell command string, the adapter must either use an exact argument-vector alternative or block security-sensitive use until upstream provides one.

Opening a local editor uses a validated executable and argument vector, with user content passed through a temporary file or standard input rather than interpolation.

URLs open only after scheme normalization and permit `https` by default.

`file`, custom, credential-bearing, and local-service URL schemes require explicit policy and preview.

## Terminal-output safety

All model, runner, tool, file, diff, URL, log, error, profile, and provider strings are untrusted terminal content.

Raw C0 and C1 controls are removed except normalized newline and tab where the component explicitly permits them.

ESC, CSI, DCS, APC, PM, and OSC sequences from untrusted content are rendered as visible escaped text or removed with an audit marker.

OSC 52 clipboard writes are always blocked from rendered content.

Terminal title changes are blocked from rendered content.

OSC 8 links are generated only by Braid from a separately validated URL and can be disabled.

Bidirectional override and isolate characters are visualized or bounded so filenames and commands cannot visually reorder security-relevant text without indication.

Tabs have component-specific bounded expansion and cannot move content over permission labels.

One grapheme cluster is limited to 64 code points, one rendered line to 256 KiB before folding, markdown nesting to 32 levels, JSON nesting to 64 levels, and an inline tool or diff preview to 256 KiB or 2,000 lines before a paged safe viewer is required.

Unknown markdown HTML or embedded terminal markup is treated as text.

Terminal images are disabled by default for untrusted remote content, bounded by decoded byte and cell dimensions, and never trigger an implicit network fetch.

Clipboard copy is an explicit user action, previews secret classification when relevant, and excludes folded hidden content unless selected.

Bracketed paste is treated as input text and can never invoke a command until the user sends it.

## Local CLI Bridge security

The default endpoint is loopback.

A non-loopback endpoint requires TLS with certificate validation or an explicitly configured trusted tunnel.

Bearer credentials use the credential store and are never embedded in the endpoint URL.

Connection setup verifies bridge identity, version, health, and capability response before allowing runner discovery.

Braid sends caller operation, run, session, workspace, and profile identities exactly and never reuses one user's run identifier with changed input.

The bridge must bind response and cancellation operations to the authenticated caller and original run identity.

Replay endpoints must enforce the same authorization as initial dispatch.

Server `404`, restart, or lost registry is displayed as unknown and cannot be used to justify a duplicate unsafe dispatch.

## Tangle security

Tangle credentials are account and environment specific and cannot be substituted with CLI Bridge or unrelated organization credentials.

Team or account context is visible before any resource-creating operation.

Sandbox creation previews image or environment, repository, ref, resource limits, network policy, region, secrets by name, maximum lifetime when available, and confidentiality request.

Workspace, checkpoint, fork, run cancel, and environment destroy are separate capabilities and separate audit events.

Confidential execution is shown as requested until attestation evidence is cryptographically verified.

Attestation verification binds nonce, measurement, environment, profile digest, and expected policy before the interface says verified.

A confidential capability without valid evidence never changes the display to confidential.

Cloud event streams and interaction responses use authenticated encrypted transport and reject cross-session identifiers.

## Analysis isolation

An analyst receives a frozen redacted source and bounded trace tools, not live workspace mutation or source-run control.

The analysis execution uses a separate run identifier, budget, profile, and provider session.

Prompts and traces remain content-sensitive data and follow the selected analysis connection's disclosure policy.

Before analysis dispatch, Braid shows whether data leaves the local machine, which connection receives it, and whether confidential placement is requested and verified.

Citations cannot open data outside the frozen source range.

Model-generated findings are untrusted text and pass through the same terminal sanitizer.

Promotion requires explicit selection and creates a provenance attachment.

## Logs, diagnostics, and crash handling

Structured logs default to warning and above and contain identifiers, event names, sizes, durations, states, and redacted error classes.

Content logging is opt-in per diagnostic capture with an inclusion preview and automatic seeded-secret scan.

Crash handlers flush only safe metadata and do not dump process memory.

Core dumps are disabled or warned about for builds that may hold decrypted state or credentials.

Diagnostic bundles are encrypted when they include content and never upload automatically.

Support upload, if added, is an explicit external action showing destination, retention, and exact included files.

## Updates and supply chain

Direct dependencies use reviewed version ranges and an immutable lockfile.

CI verifies npm integrity, provenance when available, package license, known vulnerabilities, install scripts, binary artifacts, and unexpected dependency changes.

Release builds use protected CI, pinned actions by digest, least-privilege publish credentials, npm provenance, and signed release metadata.

`THIRD_PARTY_NOTICES.md` must match copied-source headers and production dependency licenses.

A Pi TUI update runs Braid's complete test-terminal, real-terminal, Unicode, input, and visual suite before merge.

No dependency update bypasses tests because it is classified as a renderer-only or documentation-only change.

## Telemetry and privacy

Product telemetry is off by default.

If enabled, the consent screen lists each event category, destination, retention, identifier, and whether content is included.

Default telemetry may include only coarse version, platform, feature action, success class, duration bucket, and crash class after consent.

Prompt text, transcript text, tool content, filenames, repository identity, profile content, trace content, analysis content, credential references, account identifiers, IP address beyond transport necessity, and exact terminal input are excluded.

The user can inspect queued telemetry, disable it, and delete the local telemetry queue.

No telemetry failure blocks or changes agent execution.

## Security verification

Security tests run against deterministic fixtures and real provider paths where transport behavior matters.

Seeded canary secrets appear in credential input, environment variables, MCP headers, profile confidential fields, interaction secret answers, tool output, and traces.

The release scanner checks configuration, database ciphertext and decrypted redacted views, WAL, backups, logs, cache, snapshots, screenshots, videos, exports, diagnostic bundles, test output, and CI artifacts.

Malicious terminal fixtures cover ANSI and OSC controls, bidi text, wide and combining characters, huge graphemes, deep markdown, fake prompts, fake status bars, clipboard writes, title writes, links, images, and binary output.

Filesystem tests race symlink replacement, path traversal, concurrent edit, FIFO, device file, hard link, permission change, and workspace trust digest changes.

Protocol fuzzing covers malformed JSONL, SSE, event envelopes, profile values, interaction schemas, replay cursors, identifiers, and duplicate operations.

An independent security review and static analysis run are required before the first public release.

## Security acceptance

| ID | Required proof |
| --- | --- |
| SE-01 | The seeded-secret scan finds zero canary value in every persisted, logged, rendered, exported, captured, and uploaded artifact. |
| SE-02 | Raw database, WAL, and backup bytes contain none of the seeded transcript markers and fail to open without the credential-store key. |
| SE-03 | Interactive CLI Bridge runs cannot reach an auto-approved ACP or OpenCode permission path, and explicit unattended policy remains separately tested and labeled. |
| SE-04 | Wrong run, session, interaction, operation, connection, account, workspace, or user bindings fail closed for response, replay, cancel, steer, checkpoint, and fork. |
| SE-05 | Every malicious terminal fixture produces safe visible text, no clipboard or title mutation, no unapproved link or image fetch, and bounded memory and render time. |
| SE-06 | Filesystem race tests produce no write, execution, or materialization outside approved canonical roots. |
| SE-07 | Workspace-controlled configuration, hooks, MCP commands, and resource writes remain inactive until their exact digest is trusted. |
| SE-08 | Persistent approval rules expire or disable on profile, runner, connection, workspace trust, subject, or time-scope mismatch, and every secret answer specification rejects automation without persisting its value. |
| SE-09 | Tangle confidential status remains unverified until valid nonce-bound attestation is checked and rejects stale, wrong-environment, or wrong-measurement evidence. |
| SE-10 | Deletion tests destroy the selected conversation key, find zero seeded marker after replay of every artifact readable by every active key, preserve graph tombstones, distinguish provider session, trace, checkpoint, and environment deletion, and never perform an unconfirmed external deletion. |
| SE-11 | Dependency, provenance, license, static-analysis, and vulnerability checks have no unresolved critical or high finding in the release manifest. |
| SE-12 | An independent reviewer can reproduce the threat fixtures and signs the exact release candidate digest. |

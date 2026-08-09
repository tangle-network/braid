# Conversations, forks, and analysis

## Conversation model

A Braid conversation is a directed acyclic graph of user-visible work.

The graph is independent from any one provider's native session tree.

A branch is one ordered path through message boundaries and may bind to different provider sessions or environments over time.

A turn is one user input plus the runtime activity it causes.

A run is one admitted execution attempt for a turn.

An analysis is a separate child node that reads frozen run evidence and never becomes conversation context implicitly.

## Graph entities and edges

| Entity | Required content |
| --- | --- |
| Conversation | Identifier, workspace, title, created time, active branch, profile default, retention, and archive state |
| Branch | Identifier, source boundary, profile selection, connection selection, run overrides, provider binding, environment binding, and draft |
| Message | Stable identifier, role, ordered normalized parts, source run, timestamps, completeness, and redaction state |
| Turn | User message boundary, admitted run attempts, queue position, and selected result |
| Run | Runtime and provider identifiers, immutable receipt, ordered events, interactions, outcome, usage, cost, and trace reference |
| Analysis | Frozen source reference, analyst profile, recipe, findings, citations, usage, cost, and status |
| Environment | Provider, placement, workspace metadata, confidentiality evidence, and lifecycle state |
| Checkpoint | Provider identifier, source environment, creation boundary, metadata, and state digest when reported |
| Supervisor | Runtime identifier and link to source run |
| Worker | Runtime identifier, parent worker, status, spend, logs, and control history |

| Edge | Meaning |
| --- | --- |
| `continued` | A later turn continues one branch |
| `branched_at` | A new branch copies context through one message boundary |
| `cloned_from` | A new conversation copies an existing branch through its tip |
| `retried` | A new run attempts the same turn after another run |
| `handed_off` | A new provider session receives portable context from another runner or connection |
| `analyzed` | An analysis reads a frozen run or branch source |
| `compared_left` / `compared_right` | A comparison reads two frozen sources |
| `checkpointed` | A checkpoint was created from an environment at a run boundary |
| `forked_environment` | A new environment was created from a checkpoint |
| `spawned` | A runtime parent created a worker |
| `supervised_by` | A run is represented by one runtime supervisor tree |

Every edge stores the operation identifier, creation time, source and destination identifiers, and a provenance receipt.

## Message and part model

Braid stores normalized user, assistant, and system-visible messages with ordered parts.

Parts include text, reasoning when policy permits it, tool request, tool result, artifact reference, image or file input, warning, error, and unknown canonical payload.

Stable shared part identifiers drive streaming replacement.

Provider-native opaque fields remain in redacted event records and are not treated as portable context unless a shared adapter explicitly translates them.

Tool results too large or sensitive for context are represented by a bounded summary and an artifact reference with availability metadata.

An incomplete message records its last committed event and missing range.

No fork may present incomplete context as complete without an explicit warning and user choice.

## Portable context transfer

Changing runner, connection, or provider session requires a canonical way to initialize a fresh session from prior conversation.

The current `AgentTurnInput` has prompt, parts, session identifier, model, timeout, execution identifier, replay cursor, turn identifier, detach, context metadata, and provider options, but no portable message history field.

Braid must not solve this by flattening the transcript into an untyped prompt string.

`agent-interface` and `agent-runtime` must add a canonical portable conversation context accepted when a new session starts.

The contract needs ordered roles and typed parts, source message identifiers, source digest, selected boundary, attachment references, completeness, and an explicit context-plan receipt.

The runtime or provider adapter translates that canonical context into the selected runner's native initial session format.

Opaque tool-call identifiers are not reused across runners.

Tool activity enters transferred context only as normalized content and bounded result evidence.

System prompt and profile instructions come from the immutable profile snapshot and are not duplicated as user-visible transcript text.

The target runtime operation has the following semantic shape.

```ts
interface PortableConversationContext {
  sourceConversationId: string
  sourceBranchId: string
  throughMessageId: string
  messages: readonly BackendMessage[]
  attachments?: readonly PortableContextAttachment[]
  complete: boolean
  digest: string
}

interface ContextTransferReceipt {
  sourceDigest: string
  includedMessageIds: readonly string[]
  omittedParts: readonly ContextOmission[]
  transformedParts: readonly ContextTransformation[]
  estimatedInputTokens?: number
  destinationRunner: string
  destinationSessionId: string
}
```

The final names should follow shared-package conventions, but these semantics are required.

### Context size

Before starting a fresh session, the runtime computes or obtains the destination model's context allowance and estimates the exact transfer.

If the selected history fits, Braid sends it unchanged apart from declared adapter transformations.

If it does not fit, Braid shows the overage and offers a shorter boundary, explicit message selection, or a separately generated cited summary.

Braid never silently drops the oldest messages or analyses.

A generated summary is an analysis artifact with source citations and digest, and the context receipt identifies it as transformed context.

If token limits are unknown, Braid labels the estimate unavailable and lets the provider reject safely rather than asserting fit.

## Native continuation

Continuing the active branch on the same compatible provider uses the current provider session identifier only when `sessions.continue` is true and the provider proves that its context ends at Braid's recorded message boundary.

Only the new user input is submitted because the provider session remains authoritative for native context.

Braid compares its last known message boundary with a provider boundary token, revision, digest, or session messages.

A mismatch triggers reconciliation before admission and never causes Braid to resend the full history into the same native session automatically.

An unavailable boundary proof is treated as unverified context, not as a match.

If the native session is missing, expired, unauthorized, incompatible, or unverified, Braid offers a fresh session with portable context and records a handoff edge.

## Branch operation

`/branch` is the fast conversation-only operation inside the current conversation.

The user selects a message boundary, optionally edits the next user text, and confirms the profile, connection, runner, model, and effort inherited from the source branch.

The operation creates a new branch identifier and a fresh provider session binding.

The current environment remains shared and no claim of filesystem isolation is made.

Messages through the selected boundary are linked as branch ancestry rather than physically duplicated in the journal.

Pending interactions, queued turns after the boundary, terminal-only events after the boundary, and analyses are not inherited.

A non-user boundary starts with an empty composer, while selecting a user message may copy that user text into the draft for editing.

## Clone operation

`/clone` creates a separate conversation from the active branch through its current tip.

The new conversation receives a new conversation identifier, branch identifier, drafts, and execution operation identifiers.

It retains links to source messages, profile snapshot, connection selection, and environment reference but starts a fresh provider session.

Queued input and pending interactions are not cloned.

The title defaults to the source title with a disambiguating suffix and is immediately editable.

Clone is useful when the user wants independent retention, export, or organization without a workspace copy.

## Fork operation

`/fork` is the full provenance preview for a new branch at any message or run boundary.

It can change profile, connection, runner, model, effort, mode, context selection, and workspace behavior before creation.

The default is a conversation-only fork in the shared environment with a new provider session.

`/fork --workspace` additionally requests a real checkpoint and environment fork.

The preview must distinguish source, inherited, transformed, shared, new, unavailable, and omitted values.

The fork operation commits its requested plan before external checkpoint or session creation.

If an external step fails, the branch remains in a recoverable `preparing` or `failed preparation` state with no fabricated binding.

Workspace fork admission requires retry-safe checkpoint and fork operations with lookup by idempotency key.

Retry always reuses the original checkpoint and fork operation identifiers and canonical request digests.

## Workspace fork

A workspace fork is available only when the active environment implements both checkpoint and fork and reports both capabilities.

Braid first quiesces or reaches an explicit run boundary so the user knows which filesystem state the checkpoint represents.

The preview reports active processes, uncommitted files, untracked files, pending writes, and provider checkpoint limitations when available.

Braid requests a checkpoint with source branch, run, message boundary, profile digest, canonical request digest, and a dedicated idempotency key.

After the provider returns a checkpoint reference, Braid commits it before requesting the fork.

On restart before that commit, Braid looks up the checkpoint by idempotency key and either records the existing reference, records a key conflict, or reports an unknown outcome without creating another checkpoint.

The fork request uses its own idempotency key and canonical request digest.

The provider returns a new environment reference and placement metadata, which Braid binds to the destination branch.

The destination uses a new provider session even when the runner is unchanged.

Failure to fork does not destroy the checkpoint or source environment.

The user can retry, retain the checkpoint, or delete it through an explicit provider operation.

An environment fork does not imply copied external services, browser sessions, secrets, network connections, or provider process memory unless the provider receipt explicitly says so.

## Cross-runner handoff

A runner change always creates a new provider session.

Braid first requests a side-effect-free portable context plan through the selected boundary.

The plan shows every inclusion, omission, and transformation and has a canonical digest.

Any omission or transformation requires acceptance of that digest before dispatch; rejecting the plan creates no destination session or run.

The destination execution is bound to the accepted digest and returns a transfer receipt after admission that must match it exactly.

The destination profile remains the selected `AgentProfile`; runner-specific materialization occurs in the destination provider.

The graph links source and destination runs with `handed_off` and displays both runner and profile digests.

Native hidden state, process memory, cached tool state, runner-specific todos, and opaque tool identifiers do not transfer unless represented by a canonical portable artifact.

The interface says `new session with copied context`, never `resumed`, for this operation.

## Retry

Retry creates a new run for the same turn and retains the original run, partial output, outcome, and cost.

The user chooses whether to reuse the same provider session when safe, start a fresh session from the pre-turn boundary, or change runner, model, effort, connection, or profile.

An unknown previous outcome blocks automatic retry when turn idempotency is unavailable.

A retry comparison can be created without selecting a winner automatically.

The branch displays one selected run result while keeping alternate attempts accessible in the graph.

## Conversation persistence and recovery

Branch ancestry is stored as immutable boundary links and graph edges.

Messages and parts are stored once and referenced by branches through ancestry plus branch-local continuation.

On restart Braid rebuilds the graph, restores branch drafts and queues, and reconciles every non-terminal run with its provider.

Pending local preparation operations resume from their last acknowledged external step.

Pending interactions are not answerable until provider reconciliation proves they remain pending.

Provider session or environment loss marks the binding unavailable but does not erase local history.

Graph integrity checks reject cycles, missing boundaries, cross-workspace environment bindings without an explicit edge, and terminal-run mutation.

## Conversation export

Export can target a whole conversation, one branch, one run, one analysis, or a redacted diagnostic bundle.

Canonical JSON export retains identifiers, graph edges, receipts, normalized parts, outcomes, usage, citations, and completeness flags.

Markdown export is presentation-only and includes a machine-readable reference to the canonical export digest.

Raw provider events and trace content require separate explicit inclusion because they may contain sensitive data.

Export never includes credential values or secret interaction answers.

Import validates schema, identifiers, graph acyclicity, checksums, redaction markers, and version migration before writing.

`/import <path>` and the `import_conversation` JSONL command accept only canonical Braid JSON up to 2 MiB.

Import remaps every durable identifier into a deterministic local namespace, writes the complete conversation in one event, and leaves drafts and queues empty.

Imported runs retain historical text, normalized part provenance, outcomes, usage, cost, citations, completeness, and the source export digest, while provider sessions, connections, bindings, environments, live run replay cursors, pending interactions, and write capabilities are removed.
Event-only citation identifiers remain visible as historical provenance but are labeled unsupported because source journal events are not reintroduced as live events; message- and part-backed citations remain resolvable.

Continuing an imported conversation creates a fresh run through the currently selected profile and connection; it never resumes or controls the source provider session.

## `/ask` contract

`/ask <question>` asks a trace analyst about a frozen source rather than sending the question to the active agent.

### Source freeze

Braid resolves the selected run or branch boundary to an immutable source record containing normalized events, trace references, event range, profile snapshot and digest, runner, model, connection kind, runtime and provider versions, outcome, usage, cost, timestamps, workspace and environment references, and completeness.

The source record receives a digest before analysis starts.

Late provider events cannot enter that analysis silently; the user starts a new analysis for an updated source.

An incomplete source is allowed only after the analyst and user-visible result both carry the missing range.

### Analyst dispatch

Braid builds the configured `AnalystRegistry` through `buildDefaultAnalystRegistry` and drives the streaming analysis port through `registry.runExactStream(...)`.

Callers that need only a terminal result may use `analyzeTraces(...)` with its actual `source` and `engine` options, but Braid never passes a registry into that function or treats its promise as a stream.

The analysis profile, model, effort, tool bounds, time limit, token limit, and cost limit are recorded before dispatch.

The analyst uses canonical bounded trace tools and cannot mutate the source workspace or conversation.

Analysis runs in a separate runtime execution context and has its own cancellation and cost.

### Analysis result

The result stores analyst identity, source digest, question or recipe, findings, exact citations, uncertainty, deterministic checks, errors, usage, cost, latency, and package versions.

A finding without a valid citation is labeled unsupported and cannot be promoted as a cited finding.

Citation validation proves that each reference resolves inside the frozen event or span range and that quoted snippets obey redaction policy.

The analysis node attaches to its source with an `analyzed` edge.

It does not append a user or assistant message to the source branch.

### Promotion

`Send findings to branch` lets the user select findings and creates an explicit attachment with analysis identifier, source digest, selected text, and citations.

`Fork from analysis` creates a new branch whose portable context includes that explicit attachment.

The destination agent sees that the content is an external analysis rather than prior assistant output.

Promotion is a user action and never follows automatically from analyst completion.

## Named analyses

`/analyze failure` runs deterministic trace checks and the configured failure-mode analyst.

`/analyze cost` reports every captured token, model, tool, latency, and cost field before interpreting waste.

`/analyze tools` examines tool selection, attempts, failures, output use, and missing evidence.

`/analyze improvement` produces cited candidate changes without editing the profile or workspace.

Recipes are registered through `agent-eval` and versioned by exact identifier.

Braid may add presentation aliases but cannot duplicate analyst logic in a command handler.

## Comparison

`/compare` freezes two source records and calls the appropriate `agent-eval` paired comparison.

Before a verdict, Braid displays source digests, profiles, runners, models, efforts, connections, attempts, outcomes, tokens, cost, wall time, tool activity, completeness, trace coverage, and every asymmetry present in the records.

Missing values remain visible as unavailable rather than being omitted.

A semantic judge may compare usefulness or correctness only after deterministic facts are computed.

The judge version, calibration record, rubric, and confidence remain attached to the comparison.

A comparison node has explicit left and right edges and does not change the selected branch result automatically.

## Feedback trajectory

Braid records approval, rejection, revision, corrected input, fork choice, retry choice, selected run, selected analysis finding, and automation override as structured user decisions.

The user can inspect and export these decisions as an `agent-eval` `FeedbackTrajectory` after redaction.

A decision event includes source state, offered options, chosen option, optional feedback, timestamp, profile and run references, and automation involvement.

Secret answers and raw credentials are never feedback content.

Feedback capture can be disabled globally or per conversation without disabling the operational decision itself.

## Automation rules

Automation rules answer matching interactions and are not general shell or agent automation.

Each rule has identifier, enabled state, profile digest or selector, connection and runner scope, interaction kind, subject matcher, answer, response scope, creation source, expiration, maximum uses, and audit counters.

An interaction whose answer specification contains any `secret` field is ineligible for automation in the first release.

`/automate` rejects that request with a stable error, and no rule, journal event, audit row, or export stores the secret answer value.

A future design may automate a credential reference, but it must never persist or replay the resolved secret value.

Matchers are structured fields rather than regular expressions over rendered text whenever the interaction subject exposes structure.

A rule cannot grant a broader permission than the originating interaction offers.

Persistent allow rules require explicit confirmation and are disabled when profile digest, runner, workspace trust, or connection scope changes outside their selector.

The queue evaluates rules in deterministic priority order and records matched, skipped, conflicted, expired, and applied outcomes.

Conflicting rules fail closed and require user response.

`/automate` always supports list, inspect, disable, delete, and dry-run against pending interactions.

## Graph and analysis acceptance

| ID | Required proof |
| --- | --- |
| CF-01 | Graph property tests generate 1,000 operation sequences and retain acyclicity, valid boundaries, immutable terminal runs, and valid environment bindings. |
| CF-02 | Native continuation submits only the new turn after a matching provider boundary proof, while an unavailable or mismatched boundary becomes a fresh-session handoff with one canonical portable context. |
| CF-03 | Context planning preserves all selected normalized message parts, reports every transformation or omission by stable part identifier, dispatches nothing when rejected, and produces a receipt matching the accepted plan digest when executed. |
| CF-04 | An oversized context is never truncated silently and each shortening option produces a distinct visible context digest. |
| CF-05 | Branch, clone, full fork, cross-runner handoff, retry, checkpoint, and environment fork each produce the specified identifiers and graph edges. |
| CF-06 | A real cloud workspace fork proves source checkpoint, destination environment, independent file mutation, and unchanged source workspace. |
| CF-07 | Pending interactions, queued future turns, opaque provider state, and unselected analyses never enter inherited context. |
| CF-08 | Restart during each external fork step reconciles by idempotency key and request digest without duplicate branch, checkpoint, environment, session, or context transfer, and confirms cleanup of recovered remote resources. |
| CF-09 | Export and import preserve graph checksum, receipts, citations, completeness, and redaction while leaving external controls disabled until reconciliation. |
| CF-10 | A missing provider session produces a fresh-session handoff or honest unavailable state and never a false native resume label. |
| AN-01 | `/ask` freezes one immutable source digest and late events cannot change the running or completed analysis. |
| AN-02 | `/ask` creates no message or context mutation in the source branch before explicit promotion. |
| AN-03 | Every cited finding resolves to the frozen event or span range and an invalid citation is deterministically rejected. |
| AN-04 | Analysis result shows source, analyst profile, model, tools, tokens, cost, wall time, completeness, deterministic checks, and every finding field. |
| AN-05 | Failure, cost, tools, improvement, and comparison recipes execute through `agent-eval`, not duplicated Braid logic. |
| AN-06 | A calibrated judge separates seeded useful and useless analyses before evaluating release cases. |
| AN-07 | Promoting selected findings creates an explicit provenance attachment and excludes every unselected finding. |
| AN-08 | Feedback export represents every supported user decision, honors disabled capture, and contains zero seeded secret values. |
| AN-09 | Automation dry-run, match, conflict, expiry, use limit, profile change, workspace change, revoke, and secret-answer rejection cases all fail closed and leave exact non-secret rule, request, decision, and result events. |
| AN-10 | Cancelling an analysis never cancels or mutates its source runtime run. |

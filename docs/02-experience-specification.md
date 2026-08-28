# Experience specification

## Experience target

Braid should feel as immediate as Pi, as deliberate about approvals as Kimi Code, and more explicit than either about profiles, execution location, replay, and fork provenance.

The transcript and composer remain visually dominant.

Configuration, event detail, graphs, and supervision appear only when requested or when a run needs attention.

No screen uses decorative cards, repeated labels, or explanatory copy that restates visible controls.

When a run is active or selected, its immutable execution receipt is the source for displayed runner, model, reasoning, visible, reasoning, and total output limits, connection, and environment values.

The pending profile is shown only when no run receipt exists for the focused context.

## Launch behavior

`braid` opens the current directory in full-screen alternate-screen mode.

`braid --inline` uses the terminal's main screen and preserves scrollback.

`braid --plain` emits a non-interactive readable event stream with color and cursor control disabled.

`braid rpc` starts the JSONL headless interface defined in the verification plan.

`braid --conversation <id>` opens an existing conversation.

`braid --profile <ref>` selects a profile for a new conversation or proposes a profile change for the opened branch.

`braid --connection <id>` selects a configured connection.

Command-line profile, connection, runner, model, and effort values are run defaults and never silently rewrite a profile source.

An invalid argument exits nonzero with a one-line error and one actionable correction.

Interactive mode restores Braid's local journal and opens the selected conversation, while JSONL mode exposes the same state and control path to another process.

Opening a conversation is an attach to Braid's durable record, not a claim that Braid has taken over an arbitrary native runner process.

## Startup states

### Ready configuration exists

Braid restores the most recent conversation for the current workspace when that preference is enabled.

Otherwise it opens an empty conversation with the last valid profile and connection selected for the workspace.

The first frame renders before any network discovery completes, and asynchronous status appears in the status line without blocking editor input.

### First run

The first-run overlay asks for a profile and a connection.

The profile step lists discovered project profiles, user profiles, and importable paths.

The connection step offers detected local CLI Bridge, Tangle inference, and Tangle sandbox setup.

The confirmation view shows profile name and digest, connection, runner, model, effort, working directory, and unsupported profile dimensions.

Only the credential or endpoint fields required by the selected connection are requested.

The overlay can be cancelled without creating files or partially storing credentials.

### Recoverable startup failure

If the local database is locked, incompatible, or fails integrity checking, Braid shows the exact state and offers retry, read-only export, or restore from the pre-migration backup.

Braid never creates an empty replacement database over an unreadable one.

If a connection is unavailable, the conversation opens offline and retains full navigation and export behavior.

## Main shell

### Standard layout from 60 to 99 columns

```text
 user   Explain the failing integration test.

 agent  I found the failure in the session replay path.
        ├ tool  rg "Last-Event-ID" src
        └ result  4 matches

        The reconnect starts one event too early …

 › _


 profile Release engineer · pi / glm-5.2 · via Local CLI Bridge
 in 1.2k · out 567 · $0.0312 · latency 120ms
```

The main shell has no persistent header.

The transcript begins at the top of the viewport and remains visually primary.

The calm context rail uses one compact identity/status row from 60 through 99 columns.

At 100 columns and above, the first row labels the profile, harness, model, and backend.

It adds a distinct connection, configured reasoning and caps, known sandbox facts, and measured values when they fit.

Remote or sandbox execution appears there only when location changes the user's mental model.

The composer has separators above and below normal input and keeps at least three usable rows.

Autocomplete appears below the composer separator without adding another outer panel.

The composer grows to at most 40% of terminal height, then scrolls internally.

During work, the context rail gives priority to state, cancel, queue, and steer controls.

At rest, it gives priority to execution identity and measured usage.

Transient confirmations temporarily replace the context line so they remain visible at 40 columns.

The context rail omits unavailable values instead of displaying placeholders.

At widths below 60, it keeps only the profile and status.

The activity view keeps direct turn totals, analysis totals, and worker-tree totals separate.

Each visible total identifies reported values, estimates, or observed minimums without inventing zeroes.

### Usage and execution inspector

The wide context rail shows sandbox host, machine, verified region, complete resource groups, and direct token, cost, or latency measurements when known.

It labels estimates and observed minimums explicitly.

It omits an unreported metric from the main shell and activity summary.

Focused run details label the metric as not reported.

It never displays missing spend as zero.

Analysis calls and Runtime worker trees have separate totals.

This separation prevents double counting until Runtime reports one stable model-call identity across the complete worker tree.

`/activity` includes one execution row for each local CLI Bridge, direct inference, or sandbox run.

The execution row shows the provider, connection, endpoint location, lifecycle, cleanup, continuity, and provider environment identifier.

Sandbox details also show requested resources, verified placement, CPU and RAM samples, GPU billing, and account usage when reported.

Requested resources and verified resources are never presented as the same fact.

Account sandbox spend and per-run model spend are never presented as the same fact.

The physical machine IP, effective resource allocation, and per-sandbox CPU, RAM, and storage cost remain unavailable when the provider does not report them.

Headless state retains complete measurement status, including unavailable fields, for automation and audit.

### Wide layout at 100 columns and above

```text
 user   Fix the replay race and run the focused tests.          │ live work
                                                               │ > running  replay fix
 agent  I found the stale cursor update.                        │ > running  test worker
        I am applying the fix now.                              │ · waiting  approval

 › _


 profile reviewer · harness codex · model openai/gpt-5.6 · backend Sandbox · think xhigh
 working · Ctrl+C cancel
```

The main shell has no activity pane, including while a run is active.

F2 opens the focused activity browser for active and historical work.

The activity browser uses one list/detail surface and keeps direct turns, analyses, and workers distinct.

Each running analysis lists the selected analysts and their exact registry progress.

The analysis scope exposes promote, cancel, and refresh keys without hiding the current result.

The worker scope exposes steer, cancel, attach, and refresh keys only through reported runtime capabilities.

An unavailable attach action explains the missing runtime contract and does not create a replacement run.

Graph, details, and workspace views use focused overlays.

No secondary surface reduces the transcript below its minimum width because secondary surfaces replace the shell.

### Narrow layout below 80 columns

The transcript, composer, and one compact status line remain visible.

There is no top line.

The bottom context keeps the profile at rest and gives active controls priority during work.

Selectors, interactions, details, activity, and graph occupy the full viewport as focused overlays.

Long status values truncate in the middle so identity suffixes remain visible.

No primary action requires a side-by-side pane.

At 40×12, the composer remains at least three rows while focused and the active interaction response remains reachable without mouse input.

## Transcript

User messages, assistant text, reasoning, tool calls, tool results, artifacts, warnings, errors, analyses, and system notices use distinct semantic styles.

Role and state are never communicated by color alone.

Repeated streaming updates replace the affected message part by stable part identifier instead of appending a new row.

The terminal combines only repeated text, reasoning, and part updates within one 16 millisecond display interval.

Lifecycle, selection, interaction, storage, and explicit refresh transitions render immediately, while plain and RPC subscribers receive every committed event.

While the transcript follows an active response, it formats at most the final 32 KiB of UTF-8 text, including the truncation marker, and starts only at a complete Unicode grapheme so long responses remain responsive and visually intact.

Page Up or Alt+Home materializes the complete response history on demand while the composer is focused, and Alt+End resumes the bounded live tail without discarding stored content.

Collapsed reasoning shows a one-line summary, elapsed time, and disclosure marker.

Expanded reasoning is visually subordinate to the final answer and can be disabled by profile, provider policy, or user preference.

Tool calls show state, concise subject, duration, and an expandable sanitized preview.

Known tool subjects receive specialized views for shell commands, diffs, files, URLs, searches, agents, skills, and task lists.

Unknown tools render name, arguments, result, and error through a generic safe inspector.

Large outputs use bounded previews and open in a searchable overlay without discarding the original event.

Binary data is represented by metadata and an explicit open or save action rather than emitted into the terminal.

Warnings remain attached to the run event that caused them.

A terminal error shows whether the run is failed, cancelled, expired, or unknown and never implies that a retry is safe when idempotency is unavailable.

Selecting a transcript item opens details with source event identifier, run, provider cursor, timing, usage, profile digest, and raw normalized data after secret redaction.

## Composer

The editor supports multiline input, selection, undo and redo, kill ring behavior, clipboard paste, history, completion, Unicode, combining marks, wide characters, emoji, and IME composition.

`Enter` sends when the run is idle.

`Alt+Enter` and configurable `Ctrl+J` insert a newline.

When a run is active, ordinary `Enter` queues the input for the next turn by default.

`/steer <text>` delivers text to the active run only when the runtime reports live steering support.

`/queue <text>` always adds a next-turn input and displays its position.

The busy composer labels its current behavior as `queue` or `steer`, and `Alt+S` toggles the mode when steering is available.

Queued inputs can be opened, reordered, edited, or removed before admission.

Pasted text larger than the configured preview threshold appears as a folded paste block and requires the normal send action.

Dropped or pasted file paths can be attached only after workspace-path validation.

Image attachments appear only when both the active provider path and terminal support the required input and preview capabilities.

The composer preserves unsent content per branch across navigation and restart, but encrypts or excludes content marked secret.

## Command system

Slash commands are typed, discoverable, capability-aware operations registered in one command registry.

The registry owns parsing, completion, availability, help, confirmation, execution, and headless command identity.

Built-in commands have priority over profile resource commands.

Profile commands are addressed as `/profile:<name>` when their name conflicts with a built-in.

Typing `//text` sends `/text` to the agent as ordinary prompt content.

An unknown slash command is not sent to the agent and opens a correction list.

| Command | Required behavior |
| --- | --- |
| `/new` | Create an empty conversation after preserving the current draft |
| `/open [query]` | Search and open conversations by title, workspace, profile, runner, branch, and date |
| `/profile [ref]` | Inspect, select, import, or edit an `AgentProfile` |
| `/connection [id]` | Inspect, create, test, select, or remove a connection reference |
| `/runner [name]` | Set or clear a run-level runner preference through canonical compatibility helpers |
| `/model [name]` | Set or clear a run-level model override and show whether the runner honors it |
| `/effort [level]` | Set or clear reasoning effort using canonical allowed values |
| `/branch [message]` | Create a new conversation branch at the selected or named message boundary |
| `/clone` | Duplicate the active branch into a new conversation with fresh execution identity |
| `/fork [--workspace]` | Preview and create a conversation fork, optionally with a real environment checkpoint and fork |
| `/graph` | Open the conversation, analysis, run, environment, and worker graph |
| `/ask <question>` | Run a cited trace analysis against the selected frozen source |
| `/analyze <failure|cost|tools|improvement>` | Run a named trace-analysis recipe against the selected source |
| `/compare <left> <right>` | Create a paired comparison of two frozen run or branch sources |
| `/approve [scope]` | Accept the focused pending interaction using an allowed scope |
| `/reject [feedback]` | Decline the focused pending interaction with optional feedback when accepted by its schema |
| `/automate <list|create|update|dry-run|disable|delete>` | Inspect and manage scoped interaction response rules |
| `/queue <text>` | Add input to the active branch's admission queue |
| `/steer <text>` | Deliver runtime steering to the active run when supported |
| `/cancel` | Request explicit cancellation and wait for a confirmed terminal or honest unknown state |
| `/activity` | Open run events, tools, workers, usage, receipts, and logs |
| `/export` | Export selected conversation, branch, trace, analysis, or redacted diagnostic bundle |
| `/import <path>` | Restore a redacted Braid conversation as an offline local copy |
| `/settings` | Open user, workspace, appearance, retention, keymap, and update settings |
| `/help [query]` | Search commands, keys, concepts, and current capability explanations |
| `/quit` | Persist drafts, leave durable runs detached unless explicitly cancelled, and exit |

Command completion searches names, aliases, descriptions, profile commands, and currently valid arguments.

Unavailable commands remain searchable and explain the exact missing capability rather than disappearing without explanation.

Destructive or externally consequential commands show the resolved target before confirmation.

## Global keyboard behavior

| Key | Behavior |
| --- | --- |
| `Ctrl+P` | Open the command palette |
| `Ctrl+O` | Open the conversation selector |
| `Ctrl+G` | Open or focus the graph |
| `Ctrl+K` | Open the profile, connection, runner, model, and effort switcher |
| `Tab` | Accept or advance completion; move focus only when no completion is active |
| `Shift+Tab` | Move focus backward |
| `Esc` | Close the top overlay or leave the current selection mode |
| `Ctrl+C` | Clear selected composer text, otherwise clear composer text, otherwise request active-run cancellation, otherwise require a second press to exit |
| `Ctrl+D` | Exit only when the composer is empty, no modal is open, and no foreground action requires a decision |
| `PageUp` / `PageDown` | Scroll the focused transcript or list by one viewport |
| `Home` / `End` | Move within the editor or to list boundaries according to focus |
| `Alt+Up` / `Alt+Down` | Navigate adjacent branches or graph nodes |
| `F2` | Open the focused activity browser |
| `?` | Open contextual help outside the composer, or type a question mark inside it |

Keybindings are remappable from named actions rather than raw handler code.

The UI detects keybinding conflicts at configuration load and refuses ambiguous mandatory actions.

Kitty keyboard mode is enabled only after terminal capability negotiation and always has a legacy fallback.

## Selectors and overlays

Every searchable selector shares one behavior for query, result count, current selection, paging, loading, empty, error, and cancel states.

The title names the object being selected and does not repeat an instruction already implied by the editor.

Search starts immediately and never moves selection to a different item after the user has navigated unless the selected item disappears.

Long lists virtualize rows and preserve the selected stable identifier across refresh.

The footer shows only keys valid in the current overlay.

At 100 columns and 16 rows, entity browsers keep the selected list row and its details visible together.

Smaller terminals show the same list first and open details without layering content over the transcript.

`Up` and `Down` change selection, while `PageUp` and `PageDown` page through the selected details.

`Home` and `End` move to list boundaries.

`Left` and `Esc` perform the same back or close action at every browser depth.

Overlays are coordinated by one modal controller so an interaction cannot appear behind a profile picker or another interaction.

Foreground interactions preempt non-destructive selectors after preserving their query and selection.

No overlay can trap focus or leave the composer receiving hidden keystrokes.

## Profile and run configuration

The compact switcher opens on five rows: profile, connection, runner, model, and effort.

Changing profile replaces the effective agent definition only after validation and confirmation when a branch already has activity.

Changing connection affects the next admitted run and may require a new environment or provider session.

Changing runner, model, or effort creates a branch-local run override and never edits the source profile unless the user explicitly selects `Save to profile`.

Each selector marks values as exact, snapped, ignored, unavailable, or unverified against the active provider.

The confirmation view lists every profile dimension the connection cannot honor.

Unsupported required fields block the run.

Unsupported optional fields require an explicit continue decision and become part of the run receipt.

The full profile editor groups identity, prompt, models, runner, permissions, tools, MCP, Hub connections, subagents, resources, hooks, modes, confidentiality, and extensions without creating a parallel schema.

Unknown extension fields remain round-trippable and visible in a raw validated view.

## Interactions

An interaction is a runtime-delivered request with a stable identifier, kind, prompt, answer specification, optional subject, timeout behavior, and allowed outcomes.

Questions, permissions, and plans have specialized views, while unknown kinds use the generic answer specification.

The modal header shows the requesting run, profile, runner, and remaining timeout when present.

The body shows the prompt and a sanitized subject preview.

The response area is generated from text, number, boolean, select, or secret answer specifications and enforces required values, defaults, and constraints before submission.

Permission views show only response scopes allowed by the request, such as once, session, or persistent policy.

Boolean decisions use an explicit vertical action list with one selected row and one short consequence description.

`Up` and `Down` move between allowed actions, and `Enter` confirms the selected action.

Number keys remain direct shortcuts for decisions.

The compatibility keys `y` and `n` select an equivalent allowed action when one exists.

Persistent approval requires a second confirmation that names the exact subject pattern and storage scope.

`Alt+A` turns the current non-secret answer into a scoped rule through a keyboard editor, while `/automate` opens the searchable rule manager without requiring JSON.

Plan review offers accept, request revision with feedback, and reject only when those outcomes can be encoded by the shared interaction contract.

Secret responses are masked, excluded from history and persistence, and passed directly to the provider response call.

An interaction with any secret answer field cannot create or match an automation rule in the first release; `/automate` explains that the response must remain manual.

Concurrent interactions enter a stable FIFO queue per arrival sequence and display the total waiting count.

Session-scoped automation may resolve matching non-secret queued requests only after its exact rule is persisted and shown in the interaction audit.

Automatic responses persist their operation and exact non-secret rule with the waiting interaction before provider dispatch, so restart does not depend on retained journal history.

Provider response calls have a configurable acknowledgement deadline; expiry aborts the call, records an unknown outcome, and releases interaction, rule, and shutdown work.

Timeout displays whether the provider applied a default, declined, cancelled, or remains unknown.

Restart restores unresolved interaction metadata and asks the provider whether each request is still active before accepting a response.

A response retry reuses the same operation identifier and never answers twice.

## Run lifecycle experience

| State | Display and allowed action |
| --- | --- |
| `starting` | Spinner with resolved profile, connection, runner, and operation identifier; cancel is available |
| `running` | Streaming output, elapsed time, usage, queue, activity, steer when supported, and cancel |
| `waiting` | Interaction count and focused decision; unrelated branches remain navigable |
| `detached` | Run continues remotely; reconnect and cancel remain available when supported |
| `reconnecting` | Last accepted cursor and retry attempt are visible; no duplicate local submission occurs |
| `cancelling` | Input admission stops and Braid waits for a terminal provider snapshot |
| `completed` | Terminal outcome, usage, duration, receipts, and follow-up composer |
| `cancelled` | Provider-confirmed cancellation and any partial output remain visible |
| `failed` | Structured failure, retry safety, provider state, and diagnostic export |
| `expired` | Environment or session expiry is explicit and continuation is disabled |
| `unknown` | Braid states that provider truth is unavailable and offers only safe status refresh, export, or a new run |

Transport disconnect changes a durable run to detached or reconnecting, never directly to cancelled or failed.

Closing Braid leaves detachable runs active by default and lists them on next launch.

Non-detachable foreground runs require an explicit choice to cancel or keep Braid open before exit.

The JSONL `detach` command leaves a provider-owned durable run active when the connection supports detachment.

The JSONL `reconnect` command resumes event delivery from the last committed cursor only after the provider proves that the run and cursor are available.

If that proof is unavailable, the run remains detached, incomplete, expired, unauthorized, or unknown rather than being displayed as resumed.

A runner change is a new provider session with an explicit portable-context handoff, not native process-memory continuation.

## Conversation selector

The selector searches title, workspace, branch, profile, runner, model, connection, status, and date.

Each result shows title, active branch, last activity, profile, workspace, and any running or waiting count.

Running and waiting conversations sort ahead of recent idle conversations unless the query defines another order.

Archive is reversible and does not cancel runs.

Delete names the conversation and retained external environments, then uses the operating system trash path when possible.

Opening a conversation restores its graph, selected branch, scroll anchor, draft, and current provider bindings.

## Fork preview

The fork preview is one comparison, not a wizard of decorative steps.

It shows source and destination values for transcript boundary, profile digest, run overrides, provider session, environment, checkpoint, working tree state, untracked files, queued input, and pending interactions.

A conversation fork marks provider session as `new` and environment as `shared` unless a real workspace fork is selected.

A workspace fork requires checkpoint and fork capabilities and shows the resulting environment as `new from checkpoint`.

Cross-runner forks show that process memory does not transfer and list the normalized context that will be sent.

Pending interactions never copy into a fork as answerable requests.

## Graph

The graph is a terminal tree whose nodes are conversations, branches, turns, runs, analyses, environments, checkpoints, supervisors, and workers.

Edges name their meaning: continued, branched at, cloned, handed off, analyzed, compared, checkpointed, forked environment, spawned, or supervised.

Node rows show type, concise title, status, runner, elapsed time, and cost when known.

`/graph` opens a focused full-viewport browser, so the transcript never remains visually layered beneath it.

`Up` and `Down` select a node, while `Enter` or `Right` opens its details.

Within details, `Up` and `Down` move to the previous or next node without returning to the list.

`Left` and `Esc` perform the same back action: details return to the list, and the list closes.

The selected stable node identifier survives runtime refreshes and list reordering.

The graph supports collapse, search, status filtering, runner filtering, and jump to waiting interaction.

It never fabricates causality from timestamps when an explicit identifier link is absent.

## Analysis experience

`/ask` defaults to the active completed or failed run and prompts for a source when the branch contains multiple eligible runs.

`/ask`, `/analyze`, and `/compare` save results as analysis activity and open the exact saved result in the shared browser.

`/ask <question>` is a free-form question about one frozen source and never becomes a user message on that source branch.

`/analyze <recipe>` selects a named `agent-eval` recipe such as failure, cost, tools, or improvement.

`/compare <left> <right>` freezes two sources, exposes their measured asymmetries, and stores a paired result with explicit left and right edges.

All three commands use separate analysis execution identity, budget, usage, and cancellation from the source run.

The analysis header identifies the action, frozen source, selected profile, runner, and model when those values are known.

Analysis navigation uses the same list, details, arrow, `Left`, and `Esc` behavior as graph and runtime activity.

At wide sizes, two or more results use a list-and-detail split.
One result uses the full detail width and does not reserve an empty navigation rail.

Detail text wraps before pagination, so citations and measured fields never disappear through horizontal clipping.

The pending analysis row shows source, analyst profile, analysis recipe, budget, and cancel action.

Completed findings show severity or confidence only when provided by the analyst contract, followed by exact trace citations.

Every citation opens the bounded source event or span and identifies unavailable evidence honestly.

The analysis footer shows source digest, analyst profile digest, model, tokens, cost, wall time, and judge version when evaluated.

`Send findings to branch` creates a quoted user-controlled attachment and records which findings were selected.

`Fork from analysis` creates a new branch with selected findings as explicit context, not hidden system text.

`Compare` shows each measured field for both sides and discloses missing or asymmetric data before a verdict.

## Runtime activity and supervisor experience

The activity view consumes runtime-owned snapshots and controls rather than reading supervisor files.

`/activity` opens the same focused full-viewport browser used by analysis and graph entities.

The browser defaults to all activity and uses `Tab` to cycle through runs, analyses, workers, and all activity.

It lists an explicit root run binding, workers, status, current action, elapsed time, token use, cost, latency, last event, and log tail when reported.

Each activity row retains its source kind, profile digest, runner, model, reasoning effort, visible, reasoning, and total output limits, connection, provider session, and environment when the record reports them.

Direct turns, analyses, and workers keep their own usage totals and are never merged into a single spend number.

An unbound supervisor appears as workspace activity and never inherits the active or latest run.

Worker hierarchy uses indentation and connecting lines, with status text in addition to color.

Braid refreshes runtime snapshots only while activity or graph is open and stops scheduling refreshes when the browser closes.

Closing the browser or application invalidates an in-flight refresh before it can change a notice or request another render.

Unchanged snapshots preserve original creation times and do not append duplicate journal events.

If an active supervisor or worker disappears from a complete snapshot, Braid changes its observed status to `unknown` and preserves its history.

Provider-native child agents appear only when the shared runtime reports a normalized stable identity and parent relation.

Braid does not infer child-agent identity from tool names, text output, or timestamps.

Steering accepts the public Braid supervisor and worker identifiers.

The adapter resolves both identifiers to the exact runtime references before it sends the control request.

Cancellation names the exact run or worker, requires confirmation when descendants are affected, and waits for runtime confirmation.

If runtime control is available only in-process, Braid labels the action unavailable after reconnect instead of writing a file request.

## Appearance and accessibility

Braid supports true color, 256 color, 16 color, `NO_COLOR`, and a high-contrast theme.

Semantic styles always include a textual or structural distinction.

Themes define background, foreground, muted, accent, success, warning, error, selected, border, diff-add, diff-remove, reasoning, and each transcript role.

Braid never assumes a dark background.

All width calculations use terminal cell width and are tested with CJK, combining characters, emoji sequences, and bidirectional text fixtures.

IME composition is never interpreted as a command before commit.

Mouse selection and wheel scrolling are optional enhancements and no operation requires them.

`--plain` and headless state output provide a cursor-control-free route for assistive technology and log capture.

Plain output emits no terminal control metadata, and accessibility-configured TUI output suppresses titles, hyperlinks, and other OSC metadata.

Animation can be disabled, and reduced-motion mode replaces spinners with stable state text.

## Loading, empty, and error states

Every asynchronous list distinguishes loading, loaded-empty, stale, unavailable, unauthorized, and failed.

An empty conversation focuses the composer and shows one concise line naming the selected profile and connection.

An empty profile list offers import and creation.

An empty connection list opens setup.

An empty graph explains that the first run creates its first node.

An offline connection retains cached metadata with a stale marker and does not show an empty list.

Errors preserve user input, identify the failed operation, and state whether retry is idempotent.

Background errors enter the activity view and status line without stealing composer focus unless user action is required.

## Experience acceptance

| ID | Required proof |
| --- | --- |
| UX-01 | Main, wide, and narrow layouts pass virtual-terminal snapshots and real terminal captures at all four reference sizes. |
| UX-02 | A keyboard-only recording completes first-run setup, one turn, one interaction, one fork, one analysis, and conversation reopen at 80×24. |
| UX-03 | Terminal and headless views expose equivalent state for every primary command. They keep direct, analysis, and worker usage separate. They show secret-free execution records for local, inference, and sandbox runs. |
| UX-04 | Streaming replacement by part identifier produces no duplicated text under 1,000 randomized update sequences. |
| UX-05 | CJK, combining-mark, emoji, bidirectional, IME, paste, and resize fixtures retain valid cell layout and input content. |
| UX-06 | Every unavailable feature explains the missing reported capability in both the command palette and direct invocation. |
| UX-07 | Interaction queues, timeouts, restart, manual secret answers, secret-automation rejection, and scoped non-secret automation pass deterministic and live-provider flows. |
| UX-08 | Fork preview accurately describes all three fork types and blocks workspace claims without checkpoint and fork capabilities. |
| UX-09 | Unknown, detached, reconnecting, cancelling, and expired states remain distinct in reducer tests and visual captures. |
| UX-10 | No required workflow contains an unreachable control at 40×12 or depends on color, mouse input, or an unrecorded shortcut. |

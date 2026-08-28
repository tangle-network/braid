# Transcript and composer

## Job

The transcript shows one selected conversation branch while the composer accepts the next user action.

The component preserves reading position, draft text, and action mode across streaming and focus changes.

## Best simple implementation

Render the transcript from semantic message parts instead of raw provider chunks.

Use one Pi editor inside `ComposerView` for text entry, history, paste, selection, and autocomplete.

Use `TerminalDraftController` as the only owner of durable draft synchronization.

Represent submit, queue, and steer as composer modes that change the emitted intent.

Do not create separate transcript implementations for streaming, completed, replayed, or imported messages.

## Component map

| Component | Responsibility |
| --- | --- |
| `TranscriptView` | Render and navigate the bounded semantic document for the selected branch. |
| `ComposerView` | Present the editor and the active submit, queue, or steer mode. |
| `TerminalDraftController` | Save, restore, and clear branch-scoped drafts through typed intents. |

`SafeMarkdown` supplies the sanitized block renderer described in [safe-rendering.md](safe-rendering.md).

## Inputs and outputs

The transcript receives ordered `MessageView` values and semantic parts from `BraidViewModel`.

The composer receives the selected branch, run focus, capabilities, queue state, and current mode.

Submission emits a typed send, queue, or steer intent with a stable operation identifier.

Draft changes emit no provider call.

## State

Scroll position and expanded detail are local presentation state.

Messages, tool parts, usage, and terminal outcomes are durable application state.

Draft text is keyed by conversation and branch so navigation cannot move text into another history.

A submitted draft clears only after the application accepts its operation.

An unavailable action preserves the draft and shows the reason.

## Streaming

Semantic parts update by stable message and part identifiers.

Replacement events replace one part instead of appending duplicate text.

Auto-follow remains active only when the user is already at the end.

Manual scroll remains stable while new background content arrives.

Switching focus changes the visible branch without stopping other run readers.

## Responsive behavior

The composer keeps at least one editable row.

It grows only within a bounded share of terminal height.

The transcript receives the remaining rows and clips whole terminal cells.

Narrow layouts remove secondary part metadata before message content.

## Failure and safety

Provider text passes through the stream sanitizer and terminal sanitizer before rendering.

Incomplete control-sequence candidates never reach the Markdown renderer.

Unknown message parts use the generic semantic presentation and remain bounded.

Secret answers never enter transcript parts or saved drafts.

## Performance

The transcript projects a bounded activity document and renders only its viewport.

Frame delivery coalesces rapid deltas without dropping durable events.

Draft persistence uses operation identity so restart replay cannot duplicate a mutation.

## Proof

Tests cover multiline editing, paste, history, queue, steer, streaming replacement, branch drafts, scroll retention, and restart.

PTY recordings prove prompt entry, editing, streaming, queueing, and cancellation through the real terminal.

## Non-goals

The transcript does not parse provider-native output.

The composer does not decide admission, continuation, queue order, or steering support.


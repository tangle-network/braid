# Activity

## Job

Activity provides one searchable place to find live, queued, waiting, detached, reconnecting, completed, cancelled, and failed work.

## Best simple implementation

Project activity from canonical runs, interactions, queue entries, analyses, supervisors, and workers.

Render the compact summary with `ActivityView` and the searchable full surface with `ActivityBrowserPanel`.

Use stable entity identifiers for focus and detail actions.

Do not create another polling state store inside the terminal.

## Component map

| Component | Responsibility |
| --- | --- |
| `ActivityView` | Render the bounded activity document and indicate whether live work exists. |
| `ActivityBrowserPanel` | Search activity rows, open detail, and focus an explicit run. |

## Inputs and outputs

Each activity row carries a kind, stable identifier, status, title, summary, timestamp, and available actions.

Run rows also carry conversation and branch identity.

Selecting a run emits `focus-run` for that exact run.

Selecting another entity opens its details without changing run focus.

## Ordering and state

Live and attention-required rows appear before terminal history.

Rows within a group use canonical event or update order.

The browser preserves selection by entity identifier across refreshes.

Filters operate over the projected bounded row set.

Detached work remains visible because local silence is not completion.

## Failure and safety

Unknown status values render as unknown and never as success.

Missing cost, duration, or usage stays unknown and never becomes zero.

Untrusted titles and summaries are sanitized.

Unavailable row actions remain visible with their reason.

## Performance

Projection uses bounded recent worker and supervisor sets with required ancestors.

The browser renders only visible rows and one selected detail document.

Closing the surface stops runtime-backed refresh.

## Proof

Tests cover ordering, filtering, focus switching, background interactions, detached runs, two supervisors, unchanged snapshots, and refresh cleanup.

Captures show activity with concurrent work at all required terminal sizes.

## Non-goals

Activity does not duplicate transcript content or replace the Work Strip.

It does not assign a worker to a different run.


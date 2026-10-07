# Task feedback proof

The locally packed binary at `b63c6fcec638c04ee422357295a35128286eea1a` completed the feedback keyboard flow at 40×12, 80×24, 120×40, and 200×60 on Beelink2. The [manifest](manifest.json) records the package digest and capture tools.

The flow opens the empty conversation feedback list, completes a deterministic task, records acceptance with a reason, inspects the saved judgment, closes and reopens the list, and exits successfully. The browser did not exist before this feature; the empty and populated captures show its two states, not a historical before-and-after comparison.

| Size | Empty | Saved judgment |
| --- | --- | --- |
| 40×12 | [PNG](40x12-empty.png) | [PNG](40x12-detail.png) |
| 80×24 | [PNG](80x24-empty.png) | [PNG](80x24-detail.png) |
| 120×40 | [PNG](120x40-empty.png) | [PNG](120x40-detail.png) |
| 200×60 | [PNG](200x60-empty.png) | [PNG](200x60-detail.png) |

[Keyboard recording](feedback-keyboard.gif) · [uncut input/output recording](raw/feedback-keyboard.cast)

PNGs rasterize the captured terminal cells. The GIF replays the original terminal output and retains its colors. Plain frames, source casts, and the [capture driver](raw/capture.mjs) are retained. The driver runs after `pnpm build` and accepts the repository and output directory as arguments. It needs `agg` at `/tmp/braid-feedback-tools/agg` on `PATH`, plus `ffmpeg`.

The execution fixture and its clock are deterministic. This evidence proves the terminal workflow, not a live runner or cloud integration. The separate `test/task-feedback.test.ts` suite passed eight tests on Beelink2. It covers encrypted RPC restart and exact retries, conflicting input, secret redaction, concurrent deletion, legacy decision replay, permission-decision exclusion, conversation scope, unfinished-run rejection, and keyboard controls at the four sizes. The complete repository gate belongs to the combined feature change.

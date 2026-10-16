# Remote Runtime supervision proof

The packed Braid consumer reads the existing settled Discovery run `proximity-gap-floor-20261011a` through the published Runtime remote reader. No play was pressed, run resumed, worker spawned, or provider turn sent by Braid. The temporary read-only API host closed after capture; Runtime's original forest hash stayed unchanged (`source-cleanup.json`).

The existing capture owner is `node scripts/capture-visual.mjs --remote-env NAME`. `NAME` is an operator-provided protected environment reference containing Runtime's `readOnly` handle. Never put its value in a screenshot, profile, journal or command argument. The capture checks that the capability values do not occur in its output.

| Terminal | Agents in normalized view | Selected event reads | Exit | Evidence |
| --- | ---: | ---: | ---: | --- |
| 40x12 | 5 | 5 | 0 | [tree](40x12-tree.png), [agent](40x12-agent.png) |
| 80x24 | 5 | 5 | 0 | [tree](80x24-tree.png), [agent](80x24-agent.png) |
| 120x40 | 5 | 5 | 0 | [tree](120x40-tree.png), [agent](120x40-agent.png) |
| 200x60 | 5 | 5 | 0 | [tree](200x60-tree.png), [agent](200x60-agent.png) |

[Uncut terminal recording](80x24-flow.mp4) · [asciicast](80x24-flow.cast) · [decoded review frames](80x24-flow-review.png) · [capture manifest](manifest.json) · [actual source](source.json) · [source details](120x40-source.png).

The flow opens the remote graph, visits every agent through keyboard selection, opens its details, closes the graph, reopens the persisted graph, and quits cleanly. The source has one recorded completed agent and four pending agents; pending never renders complete, and a parent precedes its descendants. At narrow widths details show name, structural role, status, parent, stream availability and Runtime identity. Larger terminals use the existing split pane.

This settled run has no retained process-local live event buffers. Braid correctly reports `live events unavailable: not-captured`; this recording does not claim historical event replay or native provider completion. The real network integration `test/remote-supervision.test.ts` separately drives two actual code executors, normalized text/tool output, a queued worker, short newline-free output, a credential split across updates, selected cursor deduplication, encrypted SQLite restart, listener closure, source selection across two authenticated listeners, and an empty replacement tree whose omitted agents become unknown in both graph and details. No new unit or mock test is added.

The `*-before.png` images show the actual previous packed Braid revision's offline conversation shell, with no fake remote agents or provider result; see `before-provenance.json`. They are a shell comparison, not a remote-provider baseline.

Capture source: the exact commit and packed tarball hash are in `manifest.json`. Beelink capture receipt: `beelink2-1ed531904662750d10bbfeb3c6ab5808`, exit 0. All four tree/detail image pairs and decoded recording frames were reviewed.

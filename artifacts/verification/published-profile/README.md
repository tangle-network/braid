# Published operator proof

The globally installed candidate selected Operator 1.3 without a source checkout,
completed three real Codex turns, and reopened the same conversation in the
`braid-operator` tmux session on Beelink1. No play was approved or pressed.

Source: `aa94e07a2c646c4bf49929e79a944e7ea089a5e7`.
Lab profile: `4494ab671d556bcb414025bc8766915c89345647`.
Gate: `beelink1-881c5b0da67ba7fa45fb8ed8abe8e1f7`, exit 0.
Type checking, changed-file Biome checks, all 10 startup tests, build and packed
global installation passed. Lab's five materialization/provenance checks passed
in `beelink2-936a5dace2153e54d1c449816b47ffd1`.

| Fixed case | Braid run duration | Observed completion | Result |
| --- | ---: | ---: | --- |
| Small-question routing | 4.151 s | 5.058 s | Answered 391 without drafting a play |
| Existing-run observation | 43.601 s | 47.115 s | Read report, scorecard, receipt and run page; retained conflicting settlement and unknown accounting |
| Two unapproved intents | 325.274 s | 329.215 s | Drafted the requested shape experiment and a sourced three-hour overlap-search intent |

Each row is one fixed prompt on the same installed candidate and selected
`codex/openai/gpt-6.1-sol` subscription profile. Run durations come from Braid's
recorded `durationMs`; observed completion includes the recorder's polling delay.
Billed cash is unknown for every turn. Tokens are recorded by Braid, including
continuation context; they are not a billed-cash estimate.

Time to a complete spend card is unmeasured: the request explicitly asked for
intents, and their check proofs, admission, preflight and prices remain pending.
Operator 1.2 was not run because the observed Claude room did not meet the brief's
seat requirement. The historical README cases are 1.0/1.1, not a 1.2 baseline.
No profile-only speedup is claimed across this model change.

The bridge records tool names but omitted arguments in Braid's parts. A private
Traces CLI conversion of native session `01a141be-3a98-72a2-9c33-d4404943c5e5`
confirmed actual status commands, including these trace spans:

- `60796ab50a828415`: `disco report`, `disco scorecard`, `disco receipt`.
- `dea80acef667f346`: the run-page HTTP read and read-result collection.

Native transcripts remain private. Skill availability and exact mounted bytes
were checked; this proof does not claim every mounted skill was applied.

The four PNGs show initial selection at 40×12, 80×24, 120×40 and 200×60.
[The GIF](operator-journey.gif) shows the real visible journey with idle periods
capped for playback. [The uncut cast](120x40-flow-uncut.cast) retains original
event timing. The images and recording frames were reviewed.

The saved intents are `queens21-shapes-rerun-20261015a` and
`erdos-overlap-steering-20261015a`. Their full files remain in the operator's GTR
workspace. Ask the operator to show either current file. Relative file links are
rendered as text by the current terminal link policy.

Follow-ups: Braid/CLI Bridge owns missing tool arguments and duplicated progress
text seen during streaming. Next check: compare one native multi-message turn
with its normalized parts. These existing issues did not prevent the three
completed turns or durable reopening.

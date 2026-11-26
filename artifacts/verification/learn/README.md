# Learning a profile version: terminal proof

The packed binary at `fc6eda3771d2339f3e377bf66019dd6667f045bf` completed the `/learn` keyboard flow on a Beelink gate host. The [manifest](manifest.json) records the tarball digest, the measurement, the served run and the digest of every artifact.

The flow, in one uncut [recording](raw/learn-keyboard.cast) at 120×40:

1. Twelve tasks run to completion. Each becomes a held-out task with `/learn task --family <cleanup|reading> -- node <check>` ([first task](120x40-task.txt)). Half the checks need a tidy answer; the other half pass on any answer.
2. `/learn propose` reads Braid's 12 runs and 3 invented Claude Code sessions with 6 skill invocations. It proposes the skills `tidy` and `audit`, the workflow `tidy-then-audit`, and the removal of the inline skill `legacy-notes` ([proposal](120x40-proposed.txt)).
3. `/learn measure` replays every task in a fresh worktree at the run's commit, under the active profile and under each candidate. Eval's skill eval then decides each candidate ([summary](120x40-measured.txt)):

| Candidate | Decision | Judge (wins–losses, ties) | Pass, candidate vs active | Worst family | Loaded tokens | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| [skill `tidy`](120x40-skill.txt) | keep | 6–0, 6 | 12/12 vs 6/12 | cleanup 6/6 vs 0/6 | 33 vs 13 | promotable (addition) and selected |
| [workflow `tidy-then-audit`](120x40-workflow.txt) | keep | 6–0, 6 | 12/12 vs 6/12 | cleanup 6/6 vs 0/6 | 137 vs 13 | promotable; more tokens than `tidy` |
| [skill `audit`](120x40-ignored-skill.txt) | inconclusive | 0–0, 12 | 6/12 vs 6/12 | cleanup 0/6 vs 0/6 | 34 vs 13 | refused: the skill eval is inconclusive |
| [removal `legacy-notes`](120x40-removal.txt) | inconclusive | 0–0, 12 | 6/12 vs 6/12 | cleanup 0/6 vs 0/6 | 6 vs 13 | promotable (compression): success holds at fewer tokens |

4. `/learn promote` selects `tidy` as `learn.1` ([promoted](120x40-promoted.txt)). `/learn rollback` restores the replaced profile ([rolled back](120x40-rolled-back.txt)), and a second promotion makes `learn.2`.
5. `/new`, then `/runner codex`, then a follow-up task. The panel shows the run served by `learn.2` on `codex` ([served](120x40-served.txt)). The recorded state confirms that this run's admission names profile version `learn.2` and runner `codex`.

A fresh process opens the stored panel at each supported size: [40×12](40x12-panel.txt), [80×24](80x24-panel.txt), [120×40](120x40-panel.txt) and [200×60](200x60-panel.txt). Each has an uncut cast in `raw/`.

[Capture driver](raw/capture.mjs) · run it after `pnpm build` with `node artifacts/verification/learn/raw/capture.mjs <repository> <output>`.

What this proves and what it does not:

- The agent is the offline `--ui-fixture learning` agent. It answers `tidied` only when its profile mounts the `tidy` skill. The skills checkout, transcripts, workspace and checks are invented under one directory in `/tmp`. This recording proves the terminal workflow, the replay and measurement path, the gate and versioning. It does not show live model quality or a provider integration.
- The text frames are the terminal cells after each step. No PNG or GIF was rendered because `agg` is not installed on the gate hosts. The casts carry the original terminal output.
- `test/learning.test.ts` checks the same flow through the headless protocol. It verifies resource provenance, the ledger as replayed by Eval, and Eval's `procedure-registry` command. That command joins the promoted skill's version across the three sessions and the twelve search cells.

# Braid 0.3.9 release notes

## `/learn`: a rule from your own instruction files

- `/learn propose` offers a sixth kind of change: one rule from an instruction
  file your sessions loaded, such as a `CLAUDE.md`, an `AGENTS.md`, a private
  layer or a memory index. A rule is one list item, paragraph, table row, or
  fenced block with the sentence that introduces it.
- Braid splits each file's newest loaded text, so a rule you have since deleted
  is not proposed. Rules are ranked against the held-out tasks your active
  profile failed in its latest measurement, using each task's request and what
  its check printed. Before any measurement, they are ranked against every task.
- The candidate names the file and lines, the digest of the text your sessions
  loaded, and whether the file on disk still holds the rule. A promoted rule is
  composed into the profile's instructions with that record, and the next
  proposal offers it for removal.
- Codex joins the `AGENTS.md` files it finds without naming them, so that text
  has no file and line. It is skipped, and the proposal gives the count of
  sessions.
- The rules stay in your learning store. Braid copies them nowhere else.
- `/learn measure --kind <kind>` measures only that kind of candidate. Headless
  `learn` takes `kinds` for `measure`. A measurement now keeps the active
  profile's result and check output on each task.

## Canary: test a learned procedure pack on new work

- `braid canary pack` learns one procedure pack per skill from your Claude Code
  and Codex sessions, checked against a procedure contract.
- `braid canary seal` writes the protocol as the first entry of a hash-chained
  ledger and seals its analysis rule with Agent Eval's randomized served canary.
- `braid assign <task-id> --skill <name> --repository <owner/name>` puts each new
  task brief in one of two groups, fixed by a keyed hash before the task runs.
  One group's brief goes out as written; the other's carries the pack.
- `braid canary status` and `braid canary observe` verify the ledger and read
  each assignment's procedure mistakes, tokens and time.

## Long reasoning streams

- Braid stays responsive while a model streams a long reasoning part. Each
  provider event was its own durable commit on the terminal's thread, so a
  model that sent its reasoning a few characters at a time, with a progress
  marker per piece, held the terminal for minutes: `/new` and run focus stopped
  answering. Events that are already waiting are now merged before they are
  stored: consecutive updates of one text or reasoning part, and consecutive
  progress markers. Each merged event keeps the last event's id, sequence and
  cursor, so resume and gap detection hold.
- A reasoning part now shows its whole text. Its text stayed at the first update,
  because each later update was appended as an empty delta.

## Release proofs

- A Sandbox proof whose permission response Braid refuses now names the refusal's
  code and message.

## Dependencies

- Agent Eval 2.0.19: session records name the instruction files the harness
  loaded. The managed trace-analysis runtime pins `agent-eval-rpc` 2.0.19.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.9
```

# Braid 0.3.8 release notes

## `/learn`: profiles that improve from your own work

- `/learn` reads your Braid runs and task feedback and your Claude Code and Codex
  sessions, joined to the change ledger the harness hooks and CLI Bridge write.
  It proposes profile changes: mount a skill you already use, compose two skills
  you run in order, add lessons from your feedback, remove a skill, or add a
  child profile. A skill, workflow or child profile shows how many of its
  sessions made a change, made none, or are unknown.
  A mounted skill brings the text files beside its `SKILL.md`, such as its
  references, each pinned to the same commit.
- A subagent your Claude Code sessions start becomes a child-profile candidate
  when its definition is committed: Braid adds it to the profile's `subagents`,
  pinned to its commit, and every runner with subagents writes it.
- Each change is replayed on your own finished tasks. It is promoted only when it
  keeps your worst task family's success rate, and every promotion is a version
  you can roll back.
- Every later run's receipt names the learned version it ran, on any runner.
- How Braid learns is a versioned profile too. `/learn learner measure` builds
  one-change variants of the learner. Each variant picks a change on some of your
  tasks, and the pick is judged on the tasks it held out. `/learn learner promote`
  keeps a learner only when its pick does better there, and you can roll it back.

## First published here: the 0.3.7 changes

0.3.7 was not published to npm, so its changes ship in 0.3.8: recovery across a
provider restart and read-only attach. See the [0.3.7 notes](release-notes-0.3.7.md).

## Published Discovery Operator 1.4.0

- Braid bundles the same `discovery-operator` profile as the Disco device and
  controller release. The [source notice](../../THIRD_PARTY_NOTICES.md#published-discovery-operator)
  records the exact Disco revision and the source of each mounted skill.
- The operator is device-first: ordinary plays are authored, saved, preflighted
  and pressed on the requester's device (`disco workspace run --operation`, with
  receipt recovery through `disco workspace reconcile`), hosted and explicit
  publication stays opt-in, and spend authorization by exact play id and revision
  is unchanged.
- Private drafting and settled-play observation need no forge credential. The
  operator carries the trace-reading instructions used by the shipped Disco reader.
- Select it as before: `braid --profile discovery-operator`.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.8
```

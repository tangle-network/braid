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
- A skill your profile already loads, inline or by a GitHub reference, is not
  proposed again; the proposal lists it as skipped.
- Every later run's receipt names the learned version it ran, on any runner.
- How Braid learns is a versioned profile too. `/learn learner measure` builds
  one-change variants of the learner. Each variant picks a change on some of your
  tasks, and the pick is judged on the tasks it held out. `/learn learner promote`
  keeps a learner only when its pick does better there, and you can roll it back.

## First run

- Setup in a workspace without a `.braid` directory now saves. "Apply and start"
  failed with `ENOENT: openat '.braid'`, because it took the configuration lock
  beside `.braid/config.json` before the directory existed. The lock now creates
  the private directory first.

- A profile that mounts a large resource library now starts. Braid kept a
  redacted copy of the profile in its state and run receipts with limits sized
  for event payloads (256 entries, depth 8), so a profile with more entries was
  cut down with markers and refused as "not a canonical AgentProfile". The copy
  now uses the profile's own limits, and a profile past them is refused by name.

## Native terminals

- Keys you type right after Ctrl+] now reach Braid. Braid's terminal splits one
  read into separate keys, so the keys typed with the chord arrived before the
  native session had released the terminal, and they were dropped. Braid now
  takes them as typed when it redraws.

## Release proofs

- The Sandbox release proofs treat a Sandbox that the API reports as `deleted` as
  gone. After a delete, the API answers a read by id with a `deleted` record that
  has no name or metadata rather than a 404, so LIVE-07 refused to clean up its
  own Sandbox and no release passed live evidence.

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

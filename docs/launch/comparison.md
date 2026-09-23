# Braid, Claude Code, Codex CLI, OpenCode, and Pi: observed capabilities (draft)

> Draft for Drew's review. Not published.
> Every row below comes from a command run on 2026-09-23 or from a cited Braid proof record.
> This page reports whether a capability was present when we tried it. It does not rank answer quality.

## What we tested and how

We ran each CLI in a new throwaway directory with short, cheap prompts.
The script is [`evidence/probe.py`](evidence/probe.py); every run is a row in [`evidence/results.jsonl`](evidence/results.jsonl), with redacted output in [`evidence/raw/`](evidence/raw/).
Versions are in [`evidence/versions.txt`](evidence/versions.txt): Claude Code 2.1.280, Codex CLI 0.156.1, OpenCode 1.18.32, Pi 0.87.1, Braid 0.3.0 built from `ff3f20aa3`.

Claude Code, OpenCode, and Pi all ran GLM-5.2 on the Z.AI coding plan, so three of the four share one model.
Codex CLI runs only OpenAI models, so it used its configured default at low reasoning effort.
Claude Code reached GLM-5.2 through Z.AI's Anthropic-compatible endpoint, because this machine had no valid Anthropic login.
That substitution does not change the session, background, or cloud features that the probe checks.

Calibration came first.
The first attempt failed for three of the four CLIs on credentials: an expired Claude login, an empty DeepSeek balance, and a failed Anthropic token refresh for Pi.
Pi exited 0 on its failure, so the probe judges each step by its output, not by the exit code alone ([`calibration-auth-failures.jsonl`](evidence/calibration-auth-failures.jsonl)).

The recall test uses a random 12-character code, so a correct answer cannot be a guess.
Each CLI also ran a negative control: a fresh session got the same question and had to answer `NONE`.
All four did, so a pass on resume means the session carried the code.

Two host-specific wrappers affected OpenCode rows.
This machine wraps `opencode run` to give each call a disposable data directory, and it starts OpenCode under GNU `timeout`.
The first OpenCode resume and terminal-close rows are marked `invalid` in `results.jsonl` and were rerun: with a named data directory for resume, and with the real binary for terminal close.

## Results

| Capability | Claude Code | Codex CLI | OpenCode | Pi | Braid 0.3.0 |
| --- | --- | --- | --- | --- | --- |
| One non-interactive turn with machine-readable events and token counts | Yes: `-p --output-format json`, one result with usage and cost | Yes: `exec --json`, 4 events with usage | Yes: `run --format json`, 3 events with tokens and cost | Yes: `-p --mode json`, 47 events with usage and cost | Yes, offline test provider only: `braid rpc` emitted `run.usage` and `run.finished`, and `export` wrote a conversation record with run receipts ([fixture evidence](evidence/braid-fixture/)) |
| Resume a session in a new process after the first exits | Yes (`--resume <id>`) | Yes (`exec resume <id>`) | Yes (`run --session <id>`) | Yes (`--session <id>`) | Not rerun for 0.3.0 (see below). Earlier proof: Pi and Codex through CLI Bridge kept one provider session across a Braid restart on 2026-08-09 |
| Foreground turn keeps running after its terminal closes | No: the process exited and the 20 s shell task never finished | No, same result | No, same result | No, same result | Not tested locally. Tangle Sandbox retained runs: see the cloud row |
| Detached background session that outlives the launching command | **Yes**: `claude --bg` returned in 0.7 s, the task finished, and `claude logs`, `stop`, and `rm` worked | Not tested. `--help` lists `agents` (sessions on a shared local daemon), `queue`, and `remote-control` | Not observed in this probe: with `opencode serve` running, closing the `run --attach` client stopped the task | Not observed in `--help` | `/detach` and `/reconnect`, retained Tangle Sandbox connections only |
| Run the agent in a hosted cloud environment | Not tested. `--help` lists `--cloud` and `--remote-control` | Not tested. `--help` lists `cloud` (browse Codex Cloud tasks and apply them locally) | Not observed in `--help`; `serve` and `attach <url>` connect to a server you run | Not observed in `--help` | Yes, from Braid's own production proofs (below); no cloud resources were created for this page |
| Turn survives the client process being killed, then continues | Not tested | Not tested | Not tested | Not tested | Yes on Tangle Sandbox: SIGKILL, restart, and exact replay in 3 of 3 proofs on 2026-08-15, before 0.2.2 |
| Fork a conversation | Listed in `--help` (`--fork-session`) | Listed in `--help` (`fork`) | Listed in `--help` (`--fork`) | Listed in `--help` (`--fork`) | `/fork`, `/branch`, `/clone`; `/fork --runner` hands off to another runner |
| Fork the workspace files as well as the conversation | Not tested | Not tested | Not tested | Not tested | `/fork --workspace`. Passed on staging in #35; fails on production today (LIVE-09, below) |
| One agent definition runs on more than one runner | Not observed in `--help` | Not observed in `--help` | Not observed in `--help`; one CLI, many model providers | Not observed in `--help`; one CLI, many model providers | Yes: one `AgentProfile` plus `/runner` or `--runner`. Proven for Pi and Codex on 2026-08-09; this session's 0.3.0 rerun did not complete |

Every CLI switches models or providers with a flag.
The last row asks about a different thing: running the same agent definition through a different agent program.

## Braid's cloud evidence

These records are Braid's own production proofs against Tangle Sandbox.
None of them was produced for this page.

- **2026-09-01, retained, two conversations at once:** [`tangle-sandbox-braid-multirun-production-1788260107206.json`](../../artifacts/verification/live/tangle-sandbox-braid-multirun-production-1788260107206.json).
  OpenCode with `tangle-router/glm-5.3`: two active runs, both shown in the Work Strip, focus switched twice without changing either run's status, both replayed after restart with no duplicate events, one cancelled by id, and both sandboxes deleted and confirmed.
- **2026-08-15, retained process loss:** [verification record](../08-verification.md#current-core-path-observations).
  Braid was killed with SIGKILL and restarted, restored each run from the provider reference, replayed without overlap, and completed a follow-up turn in the same provider session; 3 of 3 proofs passed.
- **2026-08-12, ephemeral:** 20 sandbox jobs at four-way concurrency, all 20 environments deleted afterwards (same record).
- **2026-09-23, release candidate `ff3f20aa3`:** Live Evidence run [35832917283](https://github.com/tangle-network/braid/actions/runs/35832917283) ran LIVE-06 (Tangle inference), LIVE-07 (sandbox), and LIVE-08 (retained interaction answered after reconnect), then failed at LIVE-09.
  The uploaded bundle records all six checks as failed because they share one command, and it has no receipt for each row.
  The pass for LIVE-06 to LIVE-08 is inferred from the script: a failing row throws before LIVE-09 starts (`scripts/live-required/tangle.mjs`, `classifyExternalFailure`).
  It does not rule out a row reported `unavailable`.
  Treat it as supporting evidence until a run publishes receipts for each row.

## Where Braid is not ahead

- Claude Code already has background sessions that outlive the terminal, and a cloud session flag.
  "Survives closing the laptop" is not unique to Braid.
  Braid's claim is narrower: a retained run lives in a Tangle cloud sandbox, so it keeps working with the laptop off, and Braid restores it exactly after a crash.
  The Claude Code background session in this probe ran on the local machine.
- Every CLI resumes and forks sessions.
- Every CLI emits machine-readable events with token counts.
  Braid adds a stored run record with the profile snapshot, capabilities, and a label on each cost value: reported, estimated, lower bound, or unknown.

## Not proven in this session

- **Braid on local runners, 0.3.0.** A Braid RPC run through a private CLI Bridge (Pi, then Codex, under one profile) stalled in `reconnecting` for 240 s with no provider events.
  Transcript: [`evidence/braid-bridge/`](evidence/braid-bridge/).
  A later diagnosis found three causes:
  - Braid crashed with an unhandled rejection when the Bridge refused a turn. [#66](https://github.com/tangle-network/braid/pull/66) fixes this.
  - The Bridge's `fs-jail` left Pi's session directory read-only, so Pi failed with `EROFS`. [drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235) fixes this (merged as `de0c588`).
  - The probe profile pins effort `none` ([`evidence/braid-bridge/profile.json`](evidence/braid-bridge/profile.json)). Codex's default model rejects `none` and accepts only `low`, `medium`, `high`, `xhigh`, and `max`.

  Do not claim 0.3.0 local multi-runner behavior until a rerun passes on 0.3.0 with the fixed Bridge.
- **Braid through Claude Code.** `claude-code` is a valid runner name, but it has no live proof in the repository.
  The checked-in demo recording used Claude Code on 2026-08-15 with Braid 0.1.3-era code.

## Spend

About 21 billed model turns across the four CLIs, all with one-line prompts.
The Braid Bridge attempts admitted up to three more Pi runs; we did not confirm whether they reached the model.
No Tangle Sandbox credential was used, and no cloud resource was created.

## Reproduce

```bash
cd docs/launch/evidence
export PROBE_WORK_ROOT="$(mktemp -d)"
for h in claude codex opencode pi; do python3 probe.py turn1 $h; python3 probe.py resume $h; python3 probe.py control $h; python3 probe.py hangup $h; done
python3 probe.py bg
python3 probe.py serve
```

The probe reads a Z.AI key from `~/.pi/agent/.env` for Claude Code and never writes it to disk.

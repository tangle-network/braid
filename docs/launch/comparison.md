# Braid, Claude Code, Codex CLI, OpenCode, and Pi: observed capabilities

Every row below comes from a command run on 2026-09-23 or from a cited Braid proof record.
This page reports whether a capability was present when we tried it. It does not rank answer quality.

## What we tested and how

We ran each CLI in a new throwaway directory with short, cheap prompts.
The script is [`evidence/probe.py`](evidence/probe.py); every run is a row in [`evidence/results.jsonl`](evidence/results.jsonl).
Each current row links to its own redacted raw output.
The first probe used fixed raw filenames: eight historical outputs were overwritten, and two manual cleanup rows had no separate capture.
Those 10 rows are marked `raw_unavailable` in the ledger.
The corrected runs keep separate files for each attempt.
Versions are in [`evidence/versions.txt`](evidence/versions.txt): Claude Code 2.1.280, Codex CLI 0.156.1, OpenCode 1.18.32, Pi 0.87.1, Braid 0.3.0 built from `ff3f20aa3`.

Claude Code, OpenCode, and Pi requested the GLM-5.2 alias on the Z.AI coding plan.
Pi's completed response reported `responseModel: "glm-5.3"` ([raw event](evidence/raw/pi-turn1.stdout)), so we cannot claim the three received the same model.
Codex CLI used this host's configured default at low reasoning effort because no Z.AI GLM route was configured for it.
The tested Codex version also lists `--oss` and local providers in its [help](evidence/help/codex.txt); this probe did not test those routes.
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
The first OpenCode resume row is marked `invalid` in `results.jsonl` and was rerun with a named data directory.
The reproduction commands below select that real binary explicitly for OpenCode.
The original terminal-close detector also matched `sleep` text in each CLI's prompt before the shell task began.
All six earlier terminal-close rows are marked `invalid` in `results.jsonl`, including the wrapper-affected OpenCode row.
The corrected probe waits for an actual `sleep` executable with the exact duration, under the launched process or in the attached server's workspace.
It observed that child before closing each client terminal in the five recheck rows near the end of `results.jsonl`.
The final OpenCode serve rerun allocated a loopback port and confirmed the spawned server owned its listening socket before attaching.

## Results

| Capability | Claude Code | Codex CLI | OpenCode | Pi | Braid 0.3.0 |
| --- | --- | --- | --- | --- | --- |
| One non-interactive turn with machine-readable events and token counts | Yes: `-p --output-format json`, one result with usage and cost | Yes: `exec --json`, 4 events with usage | Yes: `run --format json`, 3 events with tokens and cost | Yes: `-p --mode json`, 47 events with usage and cost | Yes, offline test provider only: `braid rpc` emitted `run.usage` and `run.finished`, and `export` wrote a conversation record with run receipts ([fixture evidence](evidence/braid-fixture/)) |
| Resume a session in a new process after the first exits | Yes (`--resume <id>`) | Yes (`exec resume <id>`) | Yes (`run --session <id>`) | Yes (`--session <id>`) | Yes on 0.3.0 through CLI Bridge: LIVE-04 (restart reconciliation) passed on Pi, and LIVE-02 continued one conversation from Pi to Codex ([evidence](../../artifacts/verification/live/bridge/evidence.json)) |
| A started shell task finishes after the client terminal closes | No: the shell child stopped; no completion marker | No completion marker; the shell child was still present 2 s after close | **Yes:** with the real binary, the completion marker appeared after close | No: the shell child stopped; no completion marker | Not tested locally. Tangle Sandbox retained runs: see the cloud row |
| Detached or served work that outlives the launching client | **Yes**: `claude --bg` returned in 0.7 s, the task finished, and `claude logs`, `stop`, and `rm` worked | Not tested. `--help` lists `agents` (sessions on a shared local daemon), `queue`, and `remote-control` | **Yes for the shell task:** with `opencode serve` running on a port owned by the spawned server, the task finished after the `run --attach` client's terminal closed; the server was still running at measurement time | Not observed in `--help` | `/detach` and `/reconnect`, retained Tangle Sandbox connections only |
| Run the agent in a hosted cloud environment | Not tested. `--help` lists `--cloud` and `--remote-control` | Not tested. `--help` lists `cloud` (browse Codex Cloud tasks and apply them locally) | Not observed in `--help`; `serve` and `attach <url>` connect to a server you run | Not observed in `--help` | Yes, from Braid's own production proofs (below); no cloud resources were created for this page |
| Turn survives the client process being killed, then continues | Not tested | Not tested | Not tested | Not tested | Yes on Tangle Sandbox: SIGKILL, restart, and exact replay in 3 of 3 proofs on 2026-08-15, before 0.2.2 |
| Fork a conversation | Listed in `--help` (`--fork-session`) | Listed in `--help` (`fork`) | Listed in `--help` (`--fork`) | Listed in `--help` (`--fork`) | `/fork`, `/branch`, `/clone`; `/fork --runner` hands off to another runner |
| Fork the workspace files as well as the conversation | Not tested | Not tested | Not tested | Not tested | `/fork --workspace`. Passed on production in LIVE-09 of a protected run ([run 35912417993](https://github.com/tangle-network/braid/actions/runs/35912417993)); the full run failed because LIVE-06 and LIVE-07 were unavailable |
| One agent definition runs on more than one runner | Not observed in `--help` | Not observed in `--help` | Not observed in `--help`; one CLI, many model providers | Not observed in `--help`; one CLI, many model providers | Yes: one `AgentProfile` plus `/runner` and `/model` overrides. LIVE-02 passed on 0.3.0 with Pi and Codex in one conversation ([evidence](../../artifacts/verification/live/bridge/evidence.json)) |

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
- **2026-09-23, release candidate `fd785c9b6`:** In protected [Live Evidence run 35912417993](https://github.com/tangle-network/braid/actions/runs/35912417993), LIVE-08 passed native terminal input after reconnect, LIVE-09 passed the workspace fork, and LIVE-10 passed its supported confidential-fork refusal path.
  LIVE-06 and LIVE-07 were `unavailable` because the protected configuration lacked required keys, so the full release gate did not pass.
  LIVE-08 did not test answering a question, permission, or plan after reconnect; its implementation exercises a retained native terminal process and provider input.

## Where Braid is not ahead

- Claude Code has local background sessions that outlive the terminal and a cloud session flag.
  An OpenCode shell task also completed after its client terminal closed, both directly and through a running `serve` process.
  Braid's proven path is a retained run in a Tangle cloud sandbox, with recovery after a client crash.
  The Claude Code and OpenCode tasks in this probe ran on the local machine.
- Every CLI resumes and forks sessions.
- Every CLI emits machine-readable events with token counts.
  Braid adds a stored run record with the profile snapshot, capabilities, and a label on each cost value: reported, estimated, lower bound, or unknown.

## Earlier failed probe and remaining gaps

- **Earlier Braid probe on local runners, 0.3.0.** A Braid RPC run through a private CLI Bridge (Pi, then Codex, under one profile) stalled in `reconnecting` for 240 s with no provider events.
  Transcript: [`evidence/braid-bridge/`](evidence/braid-bridge/).
  A later diagnosis found three causes:
  - Braid crashed with an unhandled rejection when the Bridge refused a turn. [#66](https://github.com/tangle-network/braid/pull/66) fixes this.
  - The Bridge's `fs-jail` left Pi's session directory read-only, so Pi failed with `EROFS`. [drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235) fixes this (merged as `de0c588`).
  - The probe profile pins effort `none` ([`evidence/braid-bridge/profile.json`](evidence/braid-bridge/profile.json)). Codex's default model rejects `none` and accepts only `low`, `medium`, `high`, `xhigh`, and `max`. [#67](https://github.com/tangle-network/braid/pull/67) stops the release proof from pinning an effort.

  **Resolved after this probe:** the 0.3.0 packed CLI Bridge release proof ([`artifacts/verification/live/bridge/evidence.json`](../../artifacts/verification/live/bridge/evidence.json), merged in [#68](https://github.com/tangle-network/braid/pull/68)): LIVE-01..05 passed on Braid `5cafc42ff` with CLI Bridge `de0c588`, and LIVE-02 handed one conversation from Pi (`pi/tangle-router/glm-5.2`) to `codex/default`.
- **Braid through Claude Code.** `claude-code` is a valid runner name, but it has no live proof in the repository.
  The checked-in demo recording used Claude Code on 2026-08-15 with Braid 0.1.3-era code.

## Spend

The first comparison probe used about 21 billed model turns across the four CLIs, all with one-line prompts.
The corrected terminal-close recheck and server ownership check added six short model turns.
The Braid Bridge attempts admitted up to three more Pi runs; we did not confirm whether they reached the model.
No Tangle Sandbox credential was used, and no cloud resource was created.

## Reproduce

```bash
cd docs/launch/evidence
export PROBE_WORK_ROOT="$(mktemp -d)"
export PROBE_OUTPUT_DIR="$PROBE_WORK_ROOT/capture"
export PROBE_OPENCODE_REAL=1  # on this host, bypasses the wrapper for OpenCode
for h in claude codex opencode pi; do python3 probe.py turn1 $h; python3 probe.py resume $h; python3 probe.py control $h; python3 probe.py hangup $h; done
python3 probe.py bg
python3 probe.py serve
```

The probe reads a Z.AI key from `~/.pi/agent/.env` for Claude Code.
It masks the known credential values and standard auth forms before saving output under `PROBE_OUTPUT_DIR`.
By default, that output is in a temporary directory outside the checkout.

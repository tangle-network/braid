# Proposed README hero (draft)

> Draft for Drew's review. `README.md` is unchanged.
> The quickstart works only after 0.3.0 is on npm.

---

<div align="center">
  <h1>Braid</h1>
  <p><strong>Run one coding-agent profile through Pi, Codex, or OpenCode, on your machine or in a Tangle cloud sandbox that keeps working after you disconnect.</strong></p>
</div>

Braid is a terminal client for coding agents.
You define the agent once as an `AgentProfile`: instructions, model, tools, and permissions.
You then choose where each turn runs: a runner on your machine through CLI Bridge, Tangle inference, or a Tangle Sandbox.
Braid keeps every conversation, branch, run, and usage record in one encrypted local journal.

```bash
npm install --global @tangle-network/braid
export BRAID_TANGLE_AUTH=<your Tangle key>   # only for Tangle inference or Tangle Sandbox
braid                                         # first run: pick a profile and a connection
```

Without a Tangle key, choose **Local CLI Bridge** during setup and Braid uses the runners installed on your machine.

### What has been proven

- A retained run on Tangle Sandbox survived Braid being killed with SIGKILL. The restarted Braid replayed it exactly and continued the same session (3 of 3 runs, [verification record](docs/08-verification.md#current-core-path-observations)).
- Two conversations streamed at once in separate cloud sandboxes, and both sandboxes were deleted afterwards ([proof record](artifacts/verification/live/tangle-sandbox-braid-multirun-production-1788260107206.json)).
- Every Braid release is built once, smoke-tested on Linux x64 and macOS arm64, and checked against production Tangle before npm publishes it ([release workflow](https://github.com/tangle-network/braid/actions/workflows/release.yml)).

---

## Notes for Drew

- The headline names three runners because they are the ones with live proof.
  `claude-code` is a valid runner name but has no current live proof; add it only after one exists.
- The 2026-08-09 Pi-then-Codex proof ([Pi](artifacts/verification/live-core/pi.json), [Codex](artifacts/verification/live-core/codex.json)) is off the proven list.
  The 0.3.0 rerun of that flow stalled (see `comparison.md`, "Not proven in this session").
  Restore it only after a rerun passes on 0.3.0 with a Bridge that includes [drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235).
  Codex in the headline then rests on the packed CLI Bridge release proof of 2026-08-29 ([evidence](artifacts/verification/live/bridge/evidence.json)), which passed with effort `none` before Codex's default model stopped accepting it.
- The two remaining proofs predate 0.3.0: 2026-08-15 and 2026-09-01.
  Replace them with 0.3.0 receipts once a Live Evidence run passes and uploads its bundle.
- Retained sandbox runs need a manual `config.json` edit today, so the quickstart cannot show them.
  If setup gains a retained option before launch, add "choose Tangle Sandbox (retained)" to the setup line.
- The signup link belongs on the `BRAID_TANGLE_AUTH` line once the signup URL is decided (see `tangle-funnel.md`).

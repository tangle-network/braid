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
braid  # first run: pick a profile and a connection
```

For Tangle inference or Tangle Sandbox, enter your key during setup or set it before starting Braid:

```bash
export BRAID_TANGLE_AUTH=YOUR_TANGLE_KEY
braid
```

For local runners, install and start [CLI Bridge](https://github.com/drewstone/cli-bridge#install) in another terminal before choosing **Local CLI Bridge** during Braid setup:

```bash
git clone https://github.com/drewstone/cli-bridge.git
cd cli-bridge
pnpm install
BRIDGE_BACKENDS=codex,opencode pnpm start
```

Install and sign in to the runners you want to use, as described in the CLI Bridge setup guide.
Braid connects to the service at `http://127.0.0.1:3344`; it does not launch runners itself.
To enable Pi on Linux, add `pi` to `BRIDGE_BACKENDS` and set `PI_EXECUTOR=host BRIDGE_JAIL_MODE=fs-jail` with bubblewrap installed ([Pi requirements](https://github.com/drewstone/cli-bridge/blob/main/README.md#L163-L165)).

### What has been proven

- A retained run on Tangle Sandbox survived Braid being killed with SIGKILL. The restarted Braid replayed it exactly and continued the same session (3 of 3 runs, [verification record](docs/08-verification.md#current-core-path-observations)).
- Two conversations streamed at once in separate cloud sandboxes, and both sandboxes were deleted afterwards ([proof record](artifacts/verification/live/tangle-sandbox-braid-multirun-production-1788260107206.json)).
- Every Braid release is built once, smoke-tested on Linux x64 and macOS arm64, and checked against production Tangle before npm publishes it ([release workflow](https://github.com/tangle-network/braid/actions/workflows/release.yml)).

---

## Notes for Drew

- The headline names three runners because they are the ones with live proof.
  `claude-code` is a valid runner name but has no current live proof; add it only after one exists.
- Pi-then-Codex in one conversation is proven on 0.3.0: the 0.3.0 packed CLI Bridge release proof ([`artifacts/verification/live/bridge/evidence.json`](artifacts/verification/live/bridge/evidence.json), merged in [#68](https://github.com/tangle-network/braid/pull/68)): LIVE-01..05 passed on Braid `5cafc42ff` with CLI Bridge `de0c588`, and LIVE-02 handed one conversation from Pi (`pi/tangle-router/glm-5.2`) to `codex/default`.
  Users need a CLI Bridge that includes [drewstone/cli-bridge#235](https://github.com/drewstone/cli-bridge/pull/235) (`git pull && pnpm install`, then restart it).
- The two remaining proofs predate 0.3.0: 2026-08-15 and 2026-09-01.
  Replace them with 0.3.0 receipts once a Live Evidence run passes and uploads its bundle.
- Retained sandbox runs need a manual `config.json` edit today, so the quickstart cannot show them.
  If setup gains a retained option before launch, add "choose Tangle Sandbox (retained)" to the setup line.
- The signup link belongs on the `BRAID_TANGLE_AUTH` line once the signup URL is decided (see `tangle-funnel.md`).

# Start a Braid conversation

Braid runs on Linux and macOS with Node.js 22.19 or newer.
Choose local execution to use a coding tool on your machine, or Tangle Sandbox for a cloud workspace.

## Use a local coding agent

### Start CLI Bridge

Install and sign in to the coding tool you want to use.
The [CLI Bridge installation guide](https://github.com/drewstone/cli-bridge#install) lists supported systems, tool requirements, and authentication flows.
You also need [pnpm](https://pnpm.io/installation) to install and run CLI Bridge.

For example, if Codex is already installed and signed in, run this in a separate terminal:

```bash
git clone https://github.com/drewstone/cli-bridge.git
cd cli-bridge
pnpm install
BRIDGE_BACKENDS=codex pnpm start
```

Keep that process running.
Its default address is `http://127.0.0.1:3344`.
Choose only backends you have installed and configured; a listed model does not establish available account quota.

For Pi on Linux, CLI Bridge also requires bubblewrap and its documented `fs-jail` setup.
Use the bridge's installation guide for those requirements.

### Open your project

In another terminal:

```bash
npm install --global @tangle-network/braid
cd your-project
braid
```

Braid reads the bridge's model catalog and offers compatible profiles.
Select a runner/model combination, choose **Local CLI Bridge**, review it, and apply the selection.
Then enter a task.

```text
Find where this project handles authentication. Explain the flow and cite the files. Do not edit anything.
```

Braid uses the current project as the workspace.
Review any permission request before accepting it.
The transcript and status line show the run's activity, runner, and model.

## Use a Tangle cloud sandbox

[Create a Tangle account and API key](https://sandbox.tangle.tools/).
Your account needs available credit for inference and compute; installing Braid does not fund it.

Install Braid if you have not installed it yet:

```bash
npm install --global @tangle-network/braid
```

Cloud setup needs a profile even when no local bridge is running.
In the project where you want to use Braid, create `.braid/profile.json`:

```json
{
  "name": "Coding agent",
  "harness": "opencode",
  "model": {
    "provider": "tangle-router",
    "default": "tangle-router/glm-5.3"
  },
  "prompt": {
    "instructions": ["Inspect the repository before changing it."]
  }
}
```

Create the `.braid` directory first if it does not exist.
The example selects OpenCode and GLM-5.3; use a model your account can access from the [Tangle model catalog](https://router.tangle.tools/models).
The `harness` field means the coding program that runs the task.
It does not store an API key.

```bash
braid --profile .braid/profile.json
```

Select **Coding agent**, then **Tangle Sandbox**.
Enter your key in the masked prompt.
Review the workspace source and connection before applying them.
A cloud workspace does not automatically receive your local files or browser sessions.

### Keep a cloud workspace between turns

Setup defaults to an **ephemeral** sandbox connection, which deletes its environment after one turn.
To keep the workspace between turns, select **Tangle Sandbox** and open the **files · lifetime** page with Ctrl+L.
Choose **retained**, then enter the idle timeout in seconds, such as `1800`.
Review the workspace source, lifetime, and masked credential before applying the selection.
You can reopen Setup to inspect or change these values before sending a task.
Retained execution requires provider support and is subject to the configured idle timeout and account limits.

During a retained run, `/detach` leaves the run with its provider.
Reopen the same workspace and conversation with `braid --conversation <id>`, then use `/reconnect`.
A local conversation record alone does not keep a cloud workspace alive.

## Review a finished run

Use `/ask` for a question about the last completed or failed run.
A Tangle Sandbox connection cannot run this analysis.
For a sandbox run, first use `/connection` to select a configured Local CLI Bridge or Tangle Inference connection.
Then ask your question:

```text
/ask What changed, what checks passed, and what is still unverified? Cite the run.
```

This starts a separate analysis with its own model usage.
Braid may need to download its managed Python analysis environment on first use.
The analysis route must have working credentials and available quota.
See [trace analysis](06-conversations-forks-and-analysis.md#ask-contract) for source selection, recipes, comparison, and promoting findings.
The [recorded coding example](examples/coding-review.md) shows the resulting citations.

## Setup has no profiles

The profile chooser uses workspace profiles and compatible models advertised by CLI Bridge.
If neither source is available, setup has nothing to select.

- **Local execution:** start CLI Bridge, configure a backend, and restart Braid.
  Check the bridge's startup output for authentication or model-catalog errors.
- **Cloud execution:** create the profile above, then pass its path with `--profile`.
- **Existing profile:** Braid also reads `braid.profile.json` in the workspace, or a JSON file passed with `--profile <path>`.

A profile must name a compatible runner and model before it can run.
An unsupported combination stays unavailable rather than silently selecting a different model.

## A saved credential needs replacement

In the same workspace, run:

```bash
braid --reauthenticate
```

Keep the same `--config` and `--database-key-file` options if you use them.
Select the connection, enter its credential in the masked prompt, and review the destination before applying it.
This preserves the existing conversation database.

## Linux has no operating-system keyring

Braid needs secure storage for credentials and the conversation database key.
On a headless machine, use the protected external key-file options described in [security and storage](07-security-and-privacy.md#local-state-encryption).
Do not put a database key inside the agent's workspace or regenerate it for an existing database.

## More controls

Use `/help <word>` to search the command registry.

| Task | Entry point |
| --- | --- |
| Select another profile, connection, or reasoning effort | `/profile`, `/connection`, `/effort` |
| Answer a waiting question, permission, or plan | `/approve`, `/reject` |
| View and focus concurrent work | `/activity`, then select a run |
| Send live guidance to a supported active run | `/steer <text>` |
| Open a retained native terminal | `/interactive`, `/attach` |
| Run named analyses or compare saved sources | `/analyze`, `/compare` |

Actions depend on the selected provider's capabilities.
Braid explains a missing capability before accepting the action.

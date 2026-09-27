# Braid

**One terminal for coding agents, conversation branches, and reviews of finished runs.**

Use Pi, Codex, or OpenCode through the same interface, on your machine or in a Tangle cloud sandbox.
Keep the instructions you give an agent, compare different approaches, and see which runner, model, and workspace each turn used.

[Install and start](#start-with-a-local-coding-agent) · [Cloud setup](docs/getting-started.md#use-a-tangle-cloud-sandbox) · [Commands](#while-you-work)

![Braid reviewing a completed code change, with citations to the edited function and passing tests](docs/assets/run-review.png)

A real run: the agent fixed a `slugify` function and passed eight tests.
Then `/ask` reviewed the result, citing the code and test output and identifying a coverage gap.
[Read the captured example](docs/examples/coding-review.md).

## Start with a local coding agent

You need **Node.js 22.19+**, **Linux or macOS**, and a coding agent that is installed and signed in.
Start [CLI Bridge](https://github.com/drewstone/cli-bridge#install) in a separate terminal; it connects Braid to your local coding tools.
[The setup guide](docs/getting-started.md#use-a-local-coding-agent) has the complete commands.

With CLI Bridge running at `http://127.0.0.1:3344`:

```bash
npm install --global @tangle-network/braid
cd your-project
braid
```

1. Choose a profile from the runner and model combinations advertised by your bridge.
2. Choose **Local CLI Bridge**, review the selection, and apply it.
3. Type a task in the conversation, for example:

```text
Find where this project handles authentication. Explain the flow and cite the files. Do not edit anything.
```

The transcript shows the response and tool activity.
The status line identifies the selected runner and model.
Use `/help` for commands, or `/quit` to leave.

A **profile** is the saved set of instructions and settings for an agent.
Braid can generate one from your bridge's model catalog, so this local path needs no profile JSON.
If setup says **No AgentProfiles**, [check discovery or supply a profile](docs/getting-started.md#setup-has-no-profiles).

**Prefer a cloud workspace?** Follow [Tangle Sandbox setup](docs/getting-started.md#use-a-tangle-cloud-sandbox).
It requires a Tangle account, an API key, and available credit.
New cloud connections delete the sandbox after one turn; choose retained execution before relying on files or background work.

## While you work

| What you want to do | Command |
| --- | --- |
| See running work, waiting questions, and usage | `/activity` or `F2` |
| Try another approach from this conversation | `/fork` |
| Inspect the conversation's branches | `/graph` |
| Add the next task while a run continues | `/queue <task>` |
| Stop the selected run | `/cancel` |
| Ask what a completed run established | `/ask <question>` |
| Change the next turn's runner or model | `/runner`, then `/model` |

`/fork` previews what carries over before you confirm.
A conversation fork shares the workspace by default; `/fork --workspace` requests a separate workspace when the provider supports it.
Changing runners uses a new provider session with an explicit context transfer.
It does not copy a runner's private memory.

`/ask` runs a separate analysis of a completed or failed run.
It can make additional model calls and charges; its findings cite the saved run without changing that conversation.
Read the [analysis setup and commands](docs/getting-started.md#review-a-finished-run) before using it.

Commands that need an unavailable provider feature explain what is missing.
See the [conversation and control reference](docs/06-conversations-forks-and-analysis.md) for continuation, permissions, queueing, and worker controls.

## Your work, accounts, and costs

- **Local work:** CLI Bridge uses the coding tools and accounts you configure.
  Their subscription limits and API charges still apply.
- **Cloud work:** Tangle provides model access and sandbox compute.
  Review the selected connection, workspace source, and lifecycle before sending a task.
- **Saved work:** Braid keeps conversations and run records in an encrypted local database.
  A saved conversation does not imply that a remote process or its files still exist.
- **Credentials:** enter keys through the masked setup prompt.
  Keep them out of profiles and prompts; inspect exported run content before sharing it.
- **Usage:** reported, estimated, and unavailable costs remain distinct.
  An unavailable cost is not zero.

[Security and storage](docs/07-security-and-privacy.md) · [Profiles and connections](docs/05-profiles-and-connections.md) · [Recorded capability comparisons](docs/launch/comparison.md)

## Use Braid from another program

`braid rpc` exposes JSON Lines commands over the same application core.
For scripts and integrations, start with the [headless interface guide](docs/components/headless-and-accessibility.md).
For terminal scrollback, use `braid --inline`; for plain text, use `braid --plain`.

## Contribute

Read the [product contract](docs/01-product-contract.md), [component map](docs/components/README.md), and [verification guide](docs/08-verification.md).
Braid uses [agent-runtime](https://github.com/tangle-network/agent-runtime) for execution and [pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui) for terminal rendering.
See [third-party notices](THIRD_PARTY_NOTICES.md) for attribution.

[MIT license](LICENSE).

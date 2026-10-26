# Braid 0.3.6 release notes

## Profile startup

- Send one initial message with `braid --profile <file> --prompt <text>`.
  First-run setup completes before the message is sent.
- An initial prompt targeting `--conversation <id>` requires that exact saved ID.
  Missing and fuzzy IDs show the next command without starting a model request.
- Unattended callers can use the existing config and protected external database key.
  Paired `BRAID_CLI_BRIDGE_ENDPOINT` and `BRAID_CLI_BRIDGE_AUTH` authorize only an
  unreferenced loopback Bridge at the trusted origin. Stored credential references
  take precedence; bearer values stay out of arguments, config and SQLite.

## Runtime graph observation

- Open an existing Runtime worker graph with `braid --remote-env NAME`.
  The protected read capability arrives through that environment reference.
  Observation starts no Braid execution turn, and closing the graph restores composer input.

## Installation

- The published Runtime, Eval and Interface dependency cohort resolves compatible
  Knowledge peers during a fresh installation. Sandbox retains its admitted peer range.
- Startup and credential setup share the existing connection-option assembly.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.6
```

Cloud execution still requires a Tangle account, available credit, and a supported profile.

# Braid 0.3.7 release notes

## Recovery across a provider restart

- A run whose provider restarts mid-turn now recovers instead of ending as
  `outcome unverified`. When the connection is refused or dropped, Braid asks again
  after 250 ms, doubling to 2 s, for up to 30 s from the first refusal, then replays
  from the committed cursor.
- A provider that never comes back still ends the run as `unknown`, within about the
  same time as a silent provider.

## Read-only attach

- `braid --read-only [--conversation <id>] [--plain]` watches runs that another live
  Braid owns, from the same encrypted journal.
- A read-only Braid claims no run lock and changes nothing. Every send, command and
  cancel returns `READ_ONLY` and names the Braid that owns the run.
- `--read-only` cannot be combined with `--prompt`, `--reauthenticate`, `--fixture`
  or `--remote-env`.

## Dependencies

- Pins the current published `@tangle-network` packages, `hono` 4.13.18 and
  `@hono/node-server` 2.1.8.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.7
```

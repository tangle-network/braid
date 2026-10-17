# Braid 0.3.5 release notes

## Interactions

- A permission request from a background run no longer takes over the composer.
  It waits behind `alt+p`, and an unsent draft stays where you left it.

## Reconnect

- A reconnect is acknowledged as soon as the re-attach is proven: a pending interaction is
  visible, the replay commits a new event, or the provider's status confirms the run.
  A reconnect to a run with no pending interaction no longer waits for the run to finish.
- Every reconnect step is bounded. A re-attach that proves none of those ends the run as
  `unknown` with its cause within the stream idle bound plus one status read, and the request
  returns a retryable `RECONNECT_FAILED` that names the cause.

## Release proof

- A live headless run that ends `unknown` reports the provider's last status detail.
- Live-proof process cleanup reads ownership of a new terminal child only after it has exec'd,
  so cleanup no longer fails on a loaded host.
- Releases run from one command, `scripts/release/live-release.mjs`.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.5
```

Cloud execution still requires a Tangle account, available credit, and a supported profile.

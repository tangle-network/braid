# Braid 0.3.3 release notes

## Setup

- Setup offers Retry when profile discovery fails or returns no profiles.
  Retry discovery reloads the available profile catalog.
  Select a discovered profile to continue to connection setup.
- Setup shows discovery details on request.
  Cancel exits setup without applying configuration.
- Escape during a pending discovery request closes setup without a later redraw.

## Documentation

- The README explains profile selection, connection setup, the first coding turn, and `/ask`.
- The first-use example includes a saved coding review and terminal captures.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.3
```

This version retains the credential origin binding and redaction fixes from 0.3.2.
Existing connections that require authentication use `braid --reauthenticate` in the same workspace.

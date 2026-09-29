# Braid 0.3.4 release notes

## Cloud setup

- Set a cloud workspace's repository, Git ref, starting directory, and file lifetime in Setup.
  Choose retained files and an idle timeout before the first task when you need to reconnect later.
- Reopen Setup to inspect or edit saved workspace choices.
  A successful credential save is shown as saved and hidden; a pending or failed save is never shown as complete.
- Open Setup from the run switcher.
  Setup saves the selection without starting a task.
- Switching from connection A to B and back to A now applies A to the next task.

## Runs and conversations

- Run controls and RPC requests keep their selected target when the active conversation changes.
- The fork preview makes the source and destination clearer before a fork.
- Packed RPC proof now waits for its writes and process exit before checking results.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.4
```

Cloud execution still requires a Tangle account, available credit, and a supported profile.
The setup proof for this release confirms save, reopen, encrypted reload, and authenticated preflight.
It does not claim that a task completed in a live cloud sandbox.

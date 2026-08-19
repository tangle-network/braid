# Braid launch workflow

## Goal

Ship one durable interaction path across CLI Bridge and Tangle Sandbox.

## Structure

Three source-package tracks run in parallel.
Package publication is the only barrier because Braid must consume released artifacts.

1. Agent SDK: finish CLI Bridge discovery, replay, request forwarding, and process-restart proof.
2. Agent Runtime: merge exact retained event identity and publish it.
3. Sandbox: finish exact process control, browser attachment, and restart proof.
4. Braid: adopt the releases, remove temporary paths, and run both real recovery flows.
5. Release: capture the terminal flow, merge, publish, and verify a clean install.

## Coordination

- Four existing workers cover disjoint Agent SDK, Runtime, and Sandbox files.
- The operator owns integration, commits, package publication, and production claims.
- Each source-package change receives an independent adversarial review.
- A worker failure does not stop the other package tracks.

## Acceptance

- Pi survives Bridge process restart and resumes from a nonzero event cursor without duplicates.
- A Tangle cloud process survives client restart and rejects stale process identities.
- Questions, permissions, plans, and worker activity use canonical typed events.
- Braid contains no provider output parser or duplicate execution path.
- A clean published install reproduces both real flows and the recorded terminal UX.

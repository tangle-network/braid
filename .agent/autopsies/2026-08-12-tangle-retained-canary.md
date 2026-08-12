# Tangle cloud canary autopsy

## Run

The production checks used Braid commit `8f066cc` plus the retained-session worktree.
They used OpenCode, `tangle-router/glm-5.2`, Runtime through `0.132.12`, and Sandbox SDK `0.21.1`.
The checks used fresh bounded credentials that were revoked after each check.

## Verified findings

- The post-hardening retained canary failed before allocation in 4.695 seconds.
- The published provider lacks exact lookup after an unacknowledged dispatch.
- Active Sandboxes stayed at four.
- Total Sandboxes stayed at 9,241.
- Compute, GPU, and cost counters had zero measured change.
- The exact Braid owner-tag query matched zero resources.
- An earlier retained diagnostic reached an older sidecar and was rejected for its `runControlRef` field.
- That earlier attempt moved total Sandboxes from 9,239 to 9,240 but returned active count to four.
- A later ephemeral Braid canary timed out after 182.581 seconds with no environment identifier.
- The Braid run remained `streaming` after Runtime emitted only `backend_start`.
- A direct SDK create with the same route failed in 2.177 seconds.
- The outer response was HTTP 400 with `CONFIG_ERROR`.
- The nested response was HTTP 403 with `Service "sandbox" is not authorized for this endpoint`.
- The same key authenticated Sandbox usage and Router model discovery.
- Direct SDK account counts stayed at four active and 9,241 total Sandboxes.
- Runtime `0.132.12` still treats the permanent error as retryable because its message contains `provision failed`.
- Sandbox npm `latest` points at `0.21.0`, but Runtime `0.132.12` requires Sandbox `>=0.21.1 <0.22.0`.

## Classification

Retained mode is safely unavailable because the provider does not supply exact recovery lookup.
Ephemeral cloud creation is currently blocked by internal platform authorization.
Runtime then hides that terminal failure behind an excessive retry.
The npm tag can also install an incompatible SDK version.
These are three independent upstream failures.
Braid created no resource during either post-hardening canary.

## Action

Issue `tangle-network/agent-dev-container#5249` tracks the earlier missing-turn response mismatch.
Issue `tangle-network/agent-dev-container#5251` tracks the retained sidecar rollout.
Issue `tangle-network/agent-dev-container#5277` tracks the current platform authorization failure.
Issue `tangle-network/agent-dev-container#5278` tracks the incorrect npm tag.
Issue `tangle-network/agent-runtime#808` tracks permanent-error retry classification.
Braid keeps retained mode fail-closed and defaults new Sandbox connections to ephemeral mode.
The production canary must pass before the bounded durability cohort starts.

## Artifacts

- `artifacts/verification/live/tangle-sandbox-braid-retained-canary-production-20260812.json`
- `artifacts/verification/live/tangle-sandbox-braid-retained-safe-preflight-production-20260812.json`
- `artifacts/verification/live/tangle-sandbox-braid-retained-post-hardening-production-20260812.json`
- `artifacts/verification/live/tangle-sandbox-braid-execution-canary-post-hardening-production-20260812.json`

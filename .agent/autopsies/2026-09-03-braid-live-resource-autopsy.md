# Braid live interactive resource autopsy

## Run

The failed protected Live Evidence run was `33712441720`, job `100514611475`, at Braid commit `a1ca4f56eb3e29c5371d8631db640b20b963dbb8`.
The diagnostic artifact was `9877446888`, named `braid-live-evidence-diagnostic-a1ca4f56eb3e29c5371d8631db640b20b963dbb8`.
The raw diagnostic was read from `/tmp/braid-live-diagnostic.AdsDwG`.
The failed command was `pnpm test:live:tangle`, executed six times for `live-tangle`, `LIVE-06`, `LIVE-07`, `LIVE-08`, `LIVE-09`, and `LIVE-10`.

## Verified findings

- All six rows exited with code `1` and produced an `uncaptured` measurement.
- Each raw failure said the Braid run `run-b485afe6-5ce0-4e46-b1c8-7e574b9db530` remained `streaming` with `retainedAdmission=interactive_started` and an exact control reference present.
- The last terminal screen contained `or directory | (exit 1)`, matching the native-input shell write failing before its parent directory existed.
- The candidate source at `a1ca4f56` builds `native-input.txt` under `.braid-live/<proofId>` and emits `>>` without creating that directory (`scripts/live-required/tangle-sandbox-braid-interactive.mjs:177-200`).
- The diagnostic envelope recorded `liveResources: []` and `cleanup: []`, so it did not prove provider cleanup or provider absence.
- A protected read-only Sandbox census found exactly one resource named `braid-interactive-run-b485afe6-5ce0-4e46-b1c8-7e574b9db530`.
- The resource was `sandbox-85a1700b67c6` and had `owner=braid`, `lifecycle=retained`, and `surface=interactive-agent`.
- The exact-owner cleanup re-listed the same name, re-read the exact ID, revalidated all tags, deleted only that ID, and confirmed both `get(id) === null` and zero same-name resources.
- The existing merged cleanup path uses the same bounded run-derived name and ownership predicate, refuses multiple same-name resources, re-reads before delete, and verifies the final census (`scripts/live-required/tangle-sandbox-braid-interactive.mjs:394-423,508-590`).
- No unrelated or untagged Sandbox resource was deleted.

## Classification

This run is an `infra-bug`: the interactive proof harness generated a write into a missing parent directory, then retained one exact Braid-owned Sandbox resource after its failure.

## Disproven hypotheses

- A Sandbox quota or authentication failure is not supported by this run: the current raw failure contains no HTTP error, and the exact resource was visible to the authenticated census.
- A broad account cleanup is not justified: one exact same-name resource with all Braid ownership tags was found and removed.
- The empty diagnostic `liveResources` and `cleanup` arrays do not establish absence; the direct census disproved absence before cleanup.

## Action

The harness fix must create `.braid-live/<proofId>` before the native input and reconnect writes, then rerun Live Evidence against the exact candidate commit.
The rerun must retain the exact control reference and emit positive stopped-resource and zero-remaining cleanup evidence.

## Ground-truth commands

```text
jq -r '.envelope.checks[] | [.id,.result,(.failureDetails.exitCode|tostring),(.measurements[0].kind),(.measurements[0].reason|split("; ")[0])] | @tsv' /tmp/braid-live-diagnostic.AdsDwG/checks.partial.json
gh-drew api repos/tangle-network/braid/contents/.github/workflows/release-live-evidence.yml?ref=a1ca4f56eb3e29c5371d8631db640b20b963dbb8 --jq .content
```

The resource census and cleanup used the decrypted `TANGLE_API_KEY` without printing its value, against `https://sandbox.tangle.tools`.

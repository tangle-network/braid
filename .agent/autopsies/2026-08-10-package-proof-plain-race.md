# Plain package proof race autopsy

## Verdict

The failed package proof exposed a design flaw in its completion boundary.

The proof sent the next line after `run.finished`, before the completed execution effect was observable.

The release artifact remains valid, but the proof was vulnerable to a timing-dependent false failure.

## Failed run

- Command: `BRAID_RELEASE_TARBALL=/tmp/braid-e5414c1-proof.SJqzib/tangle-network-braid-0.1.0.tgz node scripts/verify-package.mjs --record artifacts/verification/w6/package-proof.json`.
- Source commit: `055e7aff17c56794aa776a0f1cec0691a80cc74f`.
- Package SHA-256: `32dda757d252bff4e120a8c69d776cb76b3ee971e3f2649d661875e77a20f7b8`.
- Expected result: all plain, RPC, and terminal flows pass against one package.
- Observed result: the plain flow rejected the third send with `run.operationId is not a valid operation identifier`.
- The proof then timed out while it waited for the cancellation run to start.

## Raw evidence

The failed stdout emitted the second `run.finished` event before its final `effect.upserted` event.

The proof used only the `run.finished` text as its synchronization boundary.

The next prompt could therefore overlap the previous operation's final bookkeeping.

## Disproven explanations

- The package was not stale.
  The failed run read the expected package SHA-256.
- The normal plain flow was not consistently broken.
  Twelve concurrent isolated repetitions passed 12 of 12 runs.
- The complete package flow was not consistently broken.
  One exact rerun passed all six flows in plain, RPC, and terminal modes.
- The operation identifier format was not invalid by construction.
  `op-plain-<time>-<uuid>` satisfies the committed identifier rules.

## Classification

This was a design flaw in the black-box proof synchronization.

The failed output does not prove a repeatable product defect.

## Correction

The plain proof now waits for two observable facts after each completed run.

It requires `run.finished` and a completed execution effect before it sends the next line.

The exact package proof must pass again after this change.

Next: rerun the same package proof and require all three user interfaces to complete all six flows.

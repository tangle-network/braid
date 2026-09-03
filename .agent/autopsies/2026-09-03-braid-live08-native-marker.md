# LIVE-08 native marker failure

Run: protected Braid LIVE-08 run `33712441720` with provider `1.1.4`.

Cause class: infra-bug.

The native shell mutation command appended to `.braid-live/<proof>/native-input.txt` before creating its parent directory.

The exact pre-fix command was:

```text
printf '%s\n' 'INPUT_VALUE' >> '.braid-live/proof-quote/input file.txt'
```

Replaying that command in an empty workspace returned exit code `2` with `Directory nonexistent`.

The fix creates `dirname(path)` with quoted `mkdir -p --` before the append.

Replaying the generated command in an empty workspace returned exit code `0` and wrote `INPUT_VALUE\n` to the requested path.

The same run exposed a diagnostic loss in `runTangleFlows`.

An unavailable `LiveRequiredError` retained its top message but hid nested cleanup failures.

The aggregate now uses `interactiveFailureMessages`, which redacts credentials and preserves nested reasons for LIVE-08.

The focused wiring test passed `49/49` cases after both fixes.

Fix: `scripts/live-required/tangle-sandbox-braid-interactive.mjs:200` creates the quoted proof parent before appending the marker, then rerun LIVE-08.

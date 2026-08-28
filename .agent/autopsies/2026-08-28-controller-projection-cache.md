# Controller projection cache autopsy

The `pnpm run test` command at commit `a3f07f4` passed 827 functional tests and failed 1 of 16 performance tests.

The failed test expected stable controller reads to remain below a 10 ms p90.
The assertion did not print the measured p90.

`ApplicationUiController.view()` cached the cloned application state but called `#project()` on every read.
The source check was `src/adapters/tui/application-ui-controller.ts:80` before the fix.

The host also ran multiple compiler and model processes during the failure.
Two isolated repetitions passed, so host saturation determined when the repeated work crossed the threshold.

Classification: infra-bug.

The fix caches the immutable final view by state, failure signals, and local presentation inputs.
The deterministic check now requires the same view object for every unchanged revision.

Fix: cache the projection in `src/adapters/tui/application-ui-controller.ts`, then rerun the performance and full test commands.

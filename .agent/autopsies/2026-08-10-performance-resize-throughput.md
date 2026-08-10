# Resize throughput autopsy

## Verdict

The 99.10 events/s failure came from the load generator.

The generator added its interval after Braid finished each event.

It therefore measured the requested delay plus product processing time.

## Failed run

- Command: `node scripts/performance/run.mjs`.
- Candidate tarball: `sha256:ff787cdd289317e5e59d63a27e4d4e45f91db0483a83c4efe1c45de16d992ff7`.
- Input: 1,000 resizes across four reference terminal sizes.
- Intended offered rate: 125 events/s.
- Required accepted rate: 100 events/s.
- Produced: 1,584 events.
- Accepted: 1,584 events.
- Missing: zero events.
- Duplicate: zero events.
- Measured interval: 15,983.281 ms.
- Offered rate: 99.104 events/s.
- Accepted rate: 99.104 events/s.
- Resize p95: 18.923 ms against a 100 ms requirement.

The product accepted every offered event.

The producer itself failed to offer 100 events/s.

## Root cause

`streamingExecution` yielded one event, waited for the consumer, and then slept eight milliseconds.

The sleep started only after Braid requested the next event.

Each producer interval therefore included Braid processing before the requested delay.

The producer cadence was not independent enough to test product backpressure.

## Disproven explanations

- Braid did not drop an event.
- Braid did not duplicate an event.
- The run stayed active through all 1,000 resizes.
- Every terminal cell was valid.
- Resize latency passed with an 81.077 ms p95 margin.
- The 100 events/s requirement did not need to change.

## Permanent correction

The producer now schedules each event against a fixed wall-clock deadline.

Fast product processing leaves the remaining interval as producer sleep.

Slow product processing produces zero sleep and remains visible as backpressure.

A focused test proves both the ahead-of-schedule and behind-schedule cases.

The existing calibration test still rejects a 90 events/s producer.

## Exact focused rerun

The same packed candidate completed 1,000 resizes after the correction.

- Produced: 2,007 events.
- Accepted: 2,007 events.
- Missing: zero events.
- Duplicate: zero events.
- Invalid cells: zero.
- Measured interval: 16,053.347 ms.
- Producer rate: 125.033 events/s.
- Offered rate: 125.021 events/s.
- Accepted rate: 125.021 events/s.
- Resize minimum: 7.839 ms.
- Resize median: 16.087 ms.
- Resize p90: 18.037 ms.
- Resize p95: 18.673 ms.
- Resize p99: 20.631 ms.
- Resize maximum: 26.368 ms.

The focused packed rerun passed every throughput and terminal invariant.

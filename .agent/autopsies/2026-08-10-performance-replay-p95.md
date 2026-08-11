# Encrypted replay p95 autopsy

## Verdict

The 10,000-event replay miss was real.

Repeated SQL queries and credential reads dominated encrypted event loading.

One bulk-read context removed that repeated work without weakening replay validation.

## Failed run

- Command: `pnpm test:performance`.
- Candidate: packed Braid `0.1.0` from the active release worktree.
- Environment: Node `24.13.0` on a 32-thread AMD Ryzen AI Max+ 395 system.
- Input: one encrypted SQLite conversation with 10,000 committed events.
- Repetitions: 20.
- Minimum: 1,569.681 ms.
- Median: 1,678.056 ms.
- p90: 2,004.635 ms.
- p95: 2,037.444 ms.
- Maximum: 2,062.410 ms.
- Required p95: at most 2,000 ms.

Three of 20 samples exceeded the target.

The nearest-rank p95 calculation selected the nineteenth sorted sample correctly.

Every sample replayed all 10,000 events and produced the expected projection checksum.

## Stage measurement

The replay probe now records database open, encrypted read, envelope decode, and reducer time separately.

The first packed stage measurement reported these values:

| Stage | Time | Share |
| --- | ---: | ---: |
| Database open | 90.557 ms | 4.7% |
| Read and decrypt | 1,086.871 ms | 56.0% |
| Envelope decode | 1.686 ms | 0.1% |
| Reducer | 761.241 ms | 39.2% |
| Total | 1,940.354 ms | 100.0% |

`SqliteContentStorage.storedEvent` queried the tombstone and resolved the same conversation key for every event.

One 10,000-event replay therefore issued about 20,000 avoidable SQL queries and 10,000 avoidable credential resolutions.

## Disproven explanations

- The percentile implementation was not wrong.
- The replay did not omit events.
- The projection checksum did not change.
- Garbage collection did not explain the complete tail.
- A higher target was not required.
- Intermediate state validation was not removed.

## Permanent correction

`SqliteContentStorage.storedEvents` now shares tombstone and content-key lookups within one bounded bulk read.

The cache is local to one call.

The cache is partitioned by conversation identifier.

Every cached key is zeroed in a `finally` block.

Single-event reads preserve their previous behavior.

The journal now uses the bulk read for `events` and `replay`.

A focused storage test proves one key resolution per conversation for each bulk operation.

The complete storage scope passed 57 of 57 tests.

That scope includes restart, encryption, wrong-key rejection, redaction, backups, tamper detection, and forced-kill recovery.

## Exact focused rerun

The packed 10,000-event replay ran 20 times after the correction.

- Minimum: 974.766 ms.
- Median: 1,073.363 ms.
- p90: 1,144.569 ms.
- p95: 1,172.933 ms.
- Maximum: 1,176.575 ms.
- Projection checksum: `6d32ab39a724c7fd400e327edadbfac0b1ba9658cafa95eab298fa93bf769bb3`.

The p95 decreased by 864.511 ms, or 42.4%.

The corrected stage p95 values were 106.392 ms for open and 169.302 ms for read and decrypt.

Envelope decode p95 was 2.031 ms.

Reducer p95 was 916.412 ms.

The measured result passes the 2,000 ms requirement by 827.067 ms.

## Follow-up finding

The startup probe exposed a separate 255.289 ms first-frame sample against a 250 ms requirement.

The encrypted database used PBKDF2 on a random 32-byte database key.

SQLite's raw-key format preserves the same random key and skips redundant password derivation.

A 30-run database-open benchmark measured 83.923 ms p95 before and 0.087 ms p95 after that change.

The packed smoke path then reached its useful frame in 143.476 ms.

The raw-key material is zeroed after SQLite receives it.

No Braid package existed on npm before this format change.

The v1 contract requires cryptographically random 32-byte database keys.

Pre-release password-derived databases fail closed without an automatic fallback.

# ADR 003: Use a local append-only event journal and derived views

Status: accepted

Date: 2026-08-01

## Context

Braid needs local conversation trees, branch provenance, queued inputs, interaction decisions, profile snapshots, run bindings, and crash recovery.

Providers already own native process state and may retain their own session transcripts.

A local client cannot make a provider process durable by copying its displayed text, and a provider cannot reconstruct Braid-only branch and analysis decisions.

Mutable JSON files make concurrent event ingestion, idempotency, migrations, and partial-write recovery unnecessarily fragile.

## Decision

Braid will persist a logically append-only event journal in SQLite and derive queryable conversation, branch, run, interaction, and analysis views in transactions.

The journal is authoritative for Braid's product graph and user decisions.

The provider remains authoritative for the live process, native session, cloud environment, and provider-specific replay cursor.

Every ingested local event uses a unique `(run_id, event_id)` key.

Provider event identity is stored separately because a provider's event identifier has provider-session scope and must not become Braid's global identity.

Every user operation uses a stable operation identifier bound to a canonical request digest so retry after a crash cannot submit a turn, response, cancel, or fork twice and changed input cannot reuse the identity.

Rendered frames and transient focus state are not persisted.

Secrets and raw credential values are not journal events.

Conversation payloads are encrypted inside the encrypted database with a separate random content key held only by the operating-system credential facility.

Deleting a conversation destroys its content key and leaves only non-sensitive tombstones.

Redacting one event is an explicit maintenance operation that rewrites the remaining conversation payloads under a new content key, records a verified rotation phase, verifies full replay, atomically installs the result, and destroys the old key only after verification.

Restoring a backup is an explicit manifest-driven operation protected by an exclusive lock and directory synchronization, so startup can recover a forced death between any filesystem transition.

Normal application operation never mutates a committed event; deletion and redaction maintenance are the only physical rewrites.

## Consequences

Braid can reconstruct the same view after restart and can detect missing provider history honestly.

Reducers remain pure and are shared by the terminal and headless interfaces.

Schema migrations and event upcasters become release responsibilities.

The SQLite implementation must use write-ahead logging, foreign keys, bounded transactions, backups before destructive migrations, and integrity checks after abnormal termination.

The W5 implementation uses the maintained `better-sqlite3-multiple-ciphers@12.11.1` binding behind `StoragePort` and verifies key activation, encrypted database artifacts, WAL, backups, and wrong-key rejection in the production-adapter test suite.

The deterministic `MemoryJournal` is test-only behavior behind the same application ports; non-fixture composition fails closed unless a durable encrypted adapter is available.

## Rejected alternatives

Treating provider transcripts as the only source was rejected because Braid's graph and analysis nodes are provider-independent.

Treating Braid's transcript cache as proof that a provider run still exists was rejected because CLI Bridge may lose its in-memory registry after restart.

Using one JSON file per conversation was rejected because atomic multi-entity updates and duplicate-event prevention would need to be rebuilt poorly.

## Verification

| ID | Required proof |
| --- | --- |
| ST-01 | Raw database, WAL, and backup bytes are encrypted and cannot be opened without the database key, and conversation payloads remain unreadable without their separate content keys. |
| ST-02 | Journal append and every affected projection commit atomically or leave neither change visible. |
| ST-03 | Repeating provider event or user operation identifiers produces one durable event and no duplicate external effect. |
| ST-04 | Forced death before and after each commit boundary resumes from the last durable cursor with no missing or duplicated display event. |
| ST-05 | Full replay and incremental reduction produce matching canonical projection checksums for every property-test history. |
| ST-06 | Every migration succeeds atomically or restores an openable encrypted pre-migration backup with the original schema and data. |
| ST-07 | Lock, disk-full, corruption, wrong-key, and failed-integrity cases block write mode without creating a replacement database. |
| ST-08 | Retention, deletion, redaction rewrite, export, WAL checkpoint, compaction, and key rotation preserve graph integrity; every retained artifact opened with every active key contains zero deleted seeded marker. |
| ST-09 | A cached provider binding remains historical until live reconciliation and never turns missing provider state into a local terminal claim. |
| ST-10 | Concurrent run ingestion preserves each run sequence, serializes writes, bounds memory, and survives reader cancellation without a partial projection. |

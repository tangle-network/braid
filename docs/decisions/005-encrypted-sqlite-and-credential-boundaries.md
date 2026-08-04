# ADR 005: Encrypt the journal and keep keys outside SQLite

Status: accepted

Date: 2026-08-02

## Context

Braid retains conversation events, provider-neutral operation records, projection state, and user decisions locally.

The database, its WAL and shared-memory files, and backups must remain unreadable if copied from disk.

Conversation deletion must remain effective for retained ciphertext even when a backup still exists.

Headless deployments cannot rely on an interactive credential prompt and must not accept secret material from environment variables or loose workspace files.

## Decision

Braid pins `better-sqlite3-multiple-ciphers@12.11.1` and rejects bindings that do not expose SQLCipher-compatible key operations.

SQLite uses WAL, foreign keys, FULL synchronous commits, bounded serialized write transactions, schema versioning, encrypted pre-migration backups, integrity checks, and projection checksums.

Backups use SQLite `VACUUM INTO` to produce a transactionally consistent encrypted snapshot, then Braid reopens that snapshot with the database key, runs quick and full integrity checks, synchronizes it, and publishes it through a no-clobber hard link followed by directory synchronization.

Backup and restore paths must remain under the approved workspace root, source files are opened through `O_NOFOLLOW` descriptors with one-link identity checks, and restore uses an exclusive lock plus a durable manifest for every move, install, cleanup, and manifest-removal transition.

First-time database creation writes a protected initialization marker before the encrypted file and removes it only after schema and projection initialization complete, so a forced process death can safely resume or replace an unexposed partial database.

The database key and one random 32-byte content key per conversation are held through `CredentialPort` and never stored in SQLite.

Redaction rewrites the conversation ciphertext under a new content key, records prepared and rewritten phases, verifies every rewritten row, installs the new reference transactionally, and destroys the old key only after verified recovery state is durable.

Conversation destruction writes a non-sensitive tombstone in the same transaction as the destroyed-key marker and destroys its content key; Braid never treats unreadable content as an empty conversation and restart can rebuild the journal through the tombstone.

Post-commit key-cleanup failures are recorded as unknown outcomes and repaired only through startup reconciliation; they are never replayed blindly under a new operation identifier.

The production credential adapters use `@napi-rs/keyring@1.3.0` to access macOS Keychain, Linux Secret Service, and Windows Credential Manager through native APIs.

Credential bytes never enter shell commands, process arguments, or environment variables, and temporary native buffers are erased after each operation.

Headless key material is accepted only from an inherited protected file descriptor or an external mode-0600 file with a non-symlink path, one filesystem link, and matching ownership where the platform exposes ownership.

File-backed headless keys are opened once without following the final symlink, validated through that descriptor, read with a fixed byte bound, and never reopened by path.

## Consequences

The application cannot start in production when the encrypted SQLite binding or credential facility is unavailable.

Raw credential values and secret-designated interaction answers are rejected before a journal transaction.

Provider diagnostics and credential-bearing connection references are rejected or reduced before durable storage.

Storage tests must use the production adapter for encryption, crash, backup, restore, key destruction, and concurrent-access claims.

The deterministic memory adapter remains useful for reducer and coordinator tests but cannot establish encryption or crash behavior.

## Verification

`test/storage` covers encrypted artifacts, duplicate and gap handling, replay cursors, projections, backups, restore, approved roots, descriptor identity, no-clobber publication, retention, redaction, migration interruption, integrity failure, wrong-key byte preservation, and commit failure.

`test/crash` kills a child process before and after each SQLite durable commit and filesystem transition boundary and reopens the same encrypted database.

`test/security` covers protected headless sources, environment rejection, credential-facility failure, secret canaries, and secret-designated payload rejection.

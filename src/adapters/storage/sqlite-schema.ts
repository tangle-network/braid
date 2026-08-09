import type { SqliteDatabase } from './sqlite-driver.js'
import { StorageError } from './sqlite-errors.js'

export const SQLITE_SCHEMA_VERSION = 8

export function pragmaNumber(database: SqliteDatabase, sql: string): number {
  const value = database.pragma(sql, { simple: true })
  const number =
    typeof value === 'string'
      ? ({ off: 0, normal: 1, full: 2, extra: 3 }[value.toLowerCase()] ?? Number(value))
      : typeof value === 'bigint'
        ? Number(value)
        : Number(value)
  if (!Number.isSafeInteger(number))
    throw new StorageError('SQLITE_PRAGMA', `Invalid numeric pragma ${sql}`)
  return number
}

function scalarString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length === 1 && value[0] && typeof value[0] === 'object') {
    const first = value[0] as Record<string, unknown>
    const child = Object.values(first)[0]
    return typeof child === 'string' ? child : null
  }
  if (value && typeof value === 'object') {
    const child = Object.values(value as Record<string, unknown>)[0]
    return typeof child === 'string' ? child : null
  }
  return null
}

export function pragmaString(database: SqliteDatabase, sql: string): string | null {
  return scalarString(database.pragma(sql))
}

export function applyConnectionPragmas(
  database: SqliteDatabase,
  busyTimeoutMs: number,
): { readonly wal: boolean; readonly foreignKeys: boolean; readonly synchronousFull: boolean } {
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA synchronous = FULL')
  const journalMode = pragmaString(database, 'journal_mode = WAL')?.toLowerCase()
  const foreignKeys = pragmaNumber(database, 'foreign_keys') === 1
  const synchronousFull = pragmaNumber(database, 'synchronous') === 2
  if (journalMode !== 'wal' || !foreignKeys || !synchronousFull) {
    throw new StorageError(
      'SQLITE_PRAGMAS',
      'SQLite did not accept WAL, foreign keys, and FULL synchronous mode',
    )
  }
  return { wal: journalMode === 'wal', foreignKeys, synchronousFull }
}

function createVersionOne(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS braid_conversations (
      conversation_id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS braid_conversation_keys (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES braid_conversations(conversation_id),
      credential_ref TEXT NOT NULL,
      destroyed INTEGER NOT NULL DEFAULT 0 CHECK (destroyed IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS braid_journal_events (
      storage_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES braid_conversations(conversation_id),
      run_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      run_sequence INTEGER NOT NULL CHECK (run_sequence > 0),
      kind TEXT NOT NULL,
      cursor TEXT,
      operation_id TEXT,
      payload BLOB NOT NULL,
      payload_checksum TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
      redacted INTEGER NOT NULL DEFAULT 0 CHECK (redacted IN (0, 1)),
      UNIQUE (run_id, event_id),
      UNIQUE (run_id, run_sequence)
    );
    CREATE INDEX IF NOT EXISTS braid_journal_conversation_idx
      ON braid_journal_events(conversation_id, storage_id);
    CREATE TABLE IF NOT EXISTS braid_run_cursors (
      run_id TEXT PRIMARY KEY NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES braid_conversations(conversation_id),
      last_sequence INTEGER NOT NULL DEFAULT 0,
      last_cursor TEXT,
      missing_from INTEGER,
      missing_to INTEGER,
      terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS braid_operation_records (
      operation_id TEXT PRIMARY KEY NOT NULL,
      operation_kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'failed', 'unknown', 'conflict', 'terminal')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS braid_effect_records (
      effect_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL,
      effect_kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'acknowledged', 'failed', 'unknown', 'conflict', 'terminal')),
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      detail TEXT,
      external_reference TEXT,
      conflict_with_digest TEXT
    );
    CREATE INDEX IF NOT EXISTS braid_effect_operation_idx
      ON braid_effect_records(operation_id, effect_sequence);
    CREATE TABLE IF NOT EXISTS braid_projection_state (
      projection_name TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS braid_conversation_tombstones (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES braid_conversations(conversation_id),
      reason TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS braid_effect_admissions (
      operation_id TEXT PRIMARY KEY NOT NULL,
      effect_kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function createVersionTwo(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS braid_operation_conflicts (
      operation_id TEXT NOT NULL REFERENCES braid_operation_records(operation_id),
      attempted_digest TEXT NOT NULL,
      original_digest TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      PRIMARY KEY (operation_id, attempted_digest)
    );
    CREATE TABLE IF NOT EXISTS braid_redaction_records (
      conversation_id TEXT NOT NULL REFERENCES braid_conversations(conversation_id),
      event_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      rewritten_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, event_id)
    );
  `)
}

function createVersionThree(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS braid_content_key_rotations (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES braid_conversations(conversation_id),
      old_credential_ref TEXT NOT NULL,
      new_credential_ref TEXT NOT NULL,
      prepared_at TEXT NOT NULL
    );
  `)
}

function createVersionFour(database: SqliteDatabase): void {
  database.exec(`
    DROP INDEX IF EXISTS braid_journal_event_id_unique;
  `)
}

function hasColumn(database: SqliteDatabase, table: string, column: string): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as readonly {
    readonly name?: unknown
  }[]
  return rows.some((row) => row.name === column)
}

function createVersionFive(database: SqliteDatabase): void {
  if (!hasColumn(database, 'braid_journal_events', 'provider_event_id')) {
    database.exec('ALTER TABLE braid_journal_events ADD COLUMN provider_event_id TEXT')
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS braid_journal_provider_event_idx
      ON braid_journal_events(run_id, provider_event_id);
    CREATE TABLE IF NOT EXISTS braid_conversation_tombstones (
      conversation_id TEXT PRIMARY KEY NOT NULL REFERENCES braid_conversations(conversation_id),
      reason TEXT NOT NULL,
      deleted_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS braid_effect_admissions (
      operation_id TEXT PRIMARY KEY NOT NULL,
      effect_kind TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  if (!hasColumn(database, 'braid_content_key_rotations', 'redacted_event_id')) {
    database.exec('ALTER TABLE braid_content_key_rotations ADD COLUMN redacted_event_id TEXT')
  }
  if (!hasColumn(database, 'braid_content_key_rotations', 'phase')) {
    database.exec('ALTER TABLE braid_content_key_rotations ADD COLUMN phase TEXT')
  }
}

function createVersionSix(database: SqliteDatabase): void {
  database.exec(`
    INSERT INTO braid_effect_admissions(
      operation_id, effect_kind, request_digest, attempt, created_at, updated_at
    )
    SELECT operation_id, effect_kind, request_digest, MAX(attempt), MIN(created_at), MAX(updated_at)
    FROM braid_effect_records
    WHERE status <> 'conflict'
    GROUP BY operation_id, effect_kind, request_digest
    ON CONFLICT(operation_id) DO NOTHING;
  `)
}

function createVersionSeven(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS braid_state_snapshots (
      snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      storage_id INTEGER NOT NULL,
      event_id TEXT NOT NULL,
      journal_sequence INTEGER NOT NULL CHECK (journal_sequence > 0),
      revision INTEGER NOT NULL CHECK (revision > 0),
      state_checksum TEXT NOT NULL,
      key_ref TEXT NOT NULL,
      state_ciphertext BLOB NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (scope_id, generation)
    );
    CREATE INDEX IF NOT EXISTS braid_state_snapshot_scope_sequence_idx
      ON braid_state_snapshots(scope_id, journal_sequence DESC, snapshot_id DESC);
    CREATE TABLE IF NOT EXISTS braid_state_snapshot_keys (
      scope_id TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0),
      credential_ref TEXT NOT NULL,
      retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, generation),
      UNIQUE (scope_id, credential_ref)
    );
    CREATE INDEX IF NOT EXISTS braid_state_snapshot_key_retired_idx
      ON braid_state_snapshot_keys(retired, scope_id, generation);
  `)
}

function createVersionEight(database: SqliteDatabase): void {
  if (hasColumn(database, 'braid_state_snapshots', 'state_json')) {
    // State snapshots are derived and encrypted with a separate credential.
    // Discard the pre-release plaintext design rather than carrying it forward.
    database.exec('DROP TABLE braid_state_snapshots')
    database.exec('DROP TABLE IF EXISTS braid_state_snapshot_keys')
    createVersionSeven(database)
  } else {
    database.exec(`
      CREATE INDEX IF NOT EXISTS braid_state_snapshot_scope_sequence_idx
        ON braid_state_snapshots(scope_id, journal_sequence DESC, snapshot_id DESC);
      CREATE TABLE IF NOT EXISTS braid_state_snapshot_keys (
        scope_id TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        credential_ref TEXT NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope_id, generation),
        UNIQUE (scope_id, credential_ref)
      );
      CREATE INDEX IF NOT EXISTS braid_state_snapshot_key_retired_idx
        ON braid_state_snapshot_keys(retired, scope_id, generation);
    `)
  }
}

export function migrateSchema(
  database: SqliteDatabase,
  targetVersion = SQLITE_SCHEMA_VERSION,
): void {
  const current = pragmaNumber(database, 'user_version')
  if (current > targetVersion) {
    throw new StorageError(
      'SQLITE_SCHEMA_NEWER',
      `Database schema ${current} is newer than ${targetVersion}`,
    )
  }
  if (current < 1) createVersionOne(database)
  if (current < 2) createVersionTwo(database)
  if (current < 3) createVersionThree(database)
  if (current < 4) createVersionFour(database)
  if (current < 5) createVersionFive(database)
  if (current < 6) createVersionSix(database)
  if (current < 7) createVersionSeven(database)
  if (current < 8) createVersionEight(database)
  database.exec(`PRAGMA user_version = ${targetVersion}`)
}

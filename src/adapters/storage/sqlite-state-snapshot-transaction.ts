import type { SqliteDatabase } from './sqlite-driver.js'
import type { SnapshotRuntime } from './sqlite-state-snapshot-types.js'

type SnapshotDurabilityRuntime = Pick<SnapshotRuntime, 'durableBoundary'>

export function beginSnapshotTransaction(database: SqliteDatabase): void {
  database.exec('BEGIN IMMEDIATE')
}

export function commit(
  runtime: SnapshotDurabilityRuntime,
  database: SqliteDatabase,
  boundary: string,
): void {
  runtime.durableBoundary?.(`before:${boundary}`)
  database.exec('COMMIT')
  try {
    runtime.durableBoundary?.(`after:${boundary}`)
  } catch {
    // An observer cannot invalidate a transition that has already committed.
  }
}

export function rollbackSnapshotTransaction(database: SqliteDatabase): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // Preserve the original storage failure if rollback itself is unavailable.
  }
}

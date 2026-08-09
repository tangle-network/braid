import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { StorageError } from './sqlite-errors.js'

export const SQLITE_DRIVER_PACKAGE = 'better-sqlite3-multiple-ciphers'
export const SQLITE_DRIVER_VERSION = '13.0.3'

export type SqliteValue = string | number | bigint | Buffer | null

export interface SqliteStatement {
  run(...parameters: readonly SqliteValue[]): {
    readonly changes: number
    readonly lastInsertRowid?: number | bigint
  }
  get<T extends Record<string, unknown> = Record<string, unknown>>(
    ...parameters: readonly SqliteValue[]
  ): T | undefined
  all<T extends Record<string, unknown> = Record<string, unknown>>(
    ...parameters: readonly SqliteValue[]
  ): readonly T[]
}

export interface SqliteDatabase {
  readonly open: boolean
  prepare(sql: string): SqliteStatement
  exec(sql: string): void
  pragma(sql: string, options?: { readonly simple?: boolean }): unknown
  key?(key: Buffer): unknown
  rekey?(key: Buffer): unknown
  backup?(destination: string): Promise<unknown>
  close(): void
}

export type SqliteDatabaseFactory = (
  filename: string,
  options: { readonly timeout: number },
) => SqliteDatabase

function packageVersion(resolvedModule: string): string | undefined {
  try {
    const packagePath = join(dirname(dirname(resolvedModule)), 'package.json')
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
      readonly version?: unknown
    }
    return typeof packageJson.version === 'string' ? packageJson.version : undefined
  } catch {
    return undefined
  }
}

export function loadCipherDatabaseFactory(): SqliteDatabaseFactory {
  const require = createRequire(import.meta.url)
  let resolvedModule: string
  try {
    resolvedModule = require.resolve(SQLITE_DRIVER_PACKAGE)
  } catch (error) {
    throw new StorageError(
      'SQLITE_CIPHER_UNAVAILABLE',
      `${SQLITE_DRIVER_PACKAGE}@${SQLITE_DRIVER_VERSION} is not installed`,
      { cause: error },
    )
  }
  const version = packageVersion(resolvedModule)
  if (version !== undefined && version !== SQLITE_DRIVER_VERSION) {
    throw new StorageError(
      'SQLITE_DRIVER_VERSION',
      `Expected ${SQLITE_DRIVER_PACKAGE}@${SQLITE_DRIVER_VERSION}, found ${version}`,
    )
  }
  let moduleValue: unknown
  try {
    moduleValue = require(resolvedModule) as unknown
  } catch (error) {
    throw new StorageError(
      'SQLITE_CIPHER_UNAVAILABLE',
      'The encrypted SQLite native binding failed to load',
      {
        cause: error,
      },
    )
  }
  const Constructor = (moduleValue as { readonly default?: unknown }).default ?? moduleValue
  if (typeof Constructor !== 'function') {
    throw new StorageError(
      'SQLITE_CIPHER_UNAVAILABLE',
      'The encrypted SQLite module has no constructor',
    )
  }
  return (filename, options) => {
    try {
      return new (Constructor as new (path: string, options: unknown) => SqliteDatabase)(
        filename,
        options,
      )
    } catch (error) {
      throw new StorageError(
        'SQLITE_CIPHER_UNAVAILABLE',
        'The encrypted SQLite native binding failed to initialize',
        { cause: error },
      )
    }
  }
}

export function configureCipherDatabase(
  database: SqliteDatabase,
  key: Buffer,
  options: { readonly newDatabase?: boolean } = {},
): void {
  if (!database.key || !database.rekey) {
    throw new StorageError(
      'SQLITE_CIPHER_UNAVAILABLE',
      'The SQLite binding does not expose key and rekey operations',
    )
  }
  if (key.length !== 32)
    throw new StorageError('SQLITE_KEY_INVALID', 'SQLite keys must be exactly 32 bytes')
  try {
    database.pragma("cipher = 'sqlcipher'")
    database.pragma('legacy = 4')
    const material = Buffer.from(key)
    try {
      if (options.newDatabase) database.rekey(material)
      else database.key(material)
    } finally {
      material.fill(0)
    }
    database.prepare('SELECT count(*) AS count FROM sqlite_master').get()
  } catch (error) {
    throw new StorageError('SQLITE_KEY_REJECTED', 'The encrypted SQLite key was rejected', {
      cause: error,
    })
  }
  const cipher = database.pragma('cipher', { simple: true })
  if (typeof cipher !== 'string' || cipher.toLowerCase() !== 'sqlcipher') {
    throw new StorageError(
      'SQLITE_CIPHER_UNAVAILABLE',
      'The SQLite binding did not activate SQLCipher mode',
    )
  }
}

import { join } from 'node:path'
import type { AgentProfile } from '@tangle-network/agent-interface'
import {
  ensurePrivateDirectory,
  readNoFollow,
  replacePrivateFile,
} from '../../adapters/persistence/safe-file.js'
import { AppError } from '../errors.js'
import { readProfileFile, saveProfileFile } from '../profile-persistence.js'
import type {
  LearningMeasurement,
  LearningProposal,
  LearningTask,
  LearningVersion,
} from './learning-types.js'

const MAX_RECORD_BYTES = 64 * 1024 * 1024

/**
 * The user's local learning store. Tasks, proposals, measurements, versions
 * and learned profiles live here and nowhere else: none of it is shared.
 *
 * | Path | Holds |
 * |---|---|
 * | `tasks.json` | held-out tasks with their checks |
 * | `proposal.json` | the latest proposal |
 * | `measurements/<id>.json` | one measurement round |
 * | `searches/<id>/ledger.jsonl` | the round's search ledger, read by the procedure registry |
 * | `versions.jsonl` | promotions and rollbacks, oldest first |
 * | `profiles/<version>.json` | each promoted or restored profile |
 * | `replays/` | replay directories while a measurement runs |
 */
export class LearningStore {
  readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  path(...parts: string[]): string {
    return join(this.directory, ...parts)
  }

  ensure(...parts: string[]): string {
    const path = this.path(...parts)
    ensurePrivateDirectory(path)
    return path
  }

  tasks(): LearningTask[] {
    return this.#readJson<LearningTask[]>('tasks.json') ?? []
  }

  saveTasks(tasks: readonly LearningTask[]): void {
    this.#writeJson('tasks.json', tasks)
  }

  proposal(): LearningProposal | null {
    return this.#readJson<LearningProposal>('proposal.json') ?? null
  }

  saveProposal(proposal: LearningProposal): void {
    this.#writeJson('proposal.json', proposal)
  }

  measurement(id?: string): LearningMeasurement | null {
    const target = id ?? this.#readJson<{ id: string }>('measurement.json')?.id
    if (target === undefined) return null
    return (
      this.#readJson<LearningMeasurement>(join('measurements', `${safeName(target)}.json`)) ?? null
    )
  }

  saveMeasurement(measurement: LearningMeasurement): void {
    this.ensure('measurements')
    this.#writeJson(join('measurements', `${safeName(measurement.id)}.json`), measurement)
    this.#writeJson('measurement.json', { id: measurement.id })
  }

  versions(): LearningVersion[] {
    const bytes = readNoFollow(this.path('versions.jsonl'), MAX_RECORD_BYTES)
    if (bytes === undefined) return []
    return bytes
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as LearningVersion)
  }

  appendVersion(version: LearningVersion): void {
    const previous = readNoFollow(this.path('versions.jsonl'), MAX_RECORD_BYTES)?.toString('utf8')
    this.ensure()
    replacePrivateFile(
      this.path('versions.jsonl'),
      `${previous ?? ''}${JSON.stringify(version)}\n`,
      { overwrite: true, maxExistingBytes: MAX_RECORD_BYTES },
    )
  }

  /** Save a profile version as a canonical profile file and return its path. */
  saveProfile(name: string, profile: AgentProfile): string {
    this.ensure('profiles')
    const path = this.path('profiles', `${safeName(name)}.json`)
    saveProfileFile(path, profile, { overwrite: true, trusted: true })
    return path
  }

  readProfile(path: string): AgentProfile {
    return readProfileFile(path).imported.profile as AgentProfile
  }

  #readJson<T>(relative: string): T | undefined {
    const bytes = readNoFollow(this.path(relative), MAX_RECORD_BYTES)
    if (bytes === undefined) return undefined
    try {
      return JSON.parse(bytes.toString('utf8')) as T
    } catch {
      throw new AppError(
        'LEARNING_STORE_INVALID',
        `The learning store file ${relative} is not JSON`,
      )
    }
  }

  #writeJson(relative: string, value: unknown): void {
    this.ensure()
    replacePrivateFile(this.path(relative), `${JSON.stringify(value, null, 2)}\n`, {
      overwrite: true,
      maxExistingBytes: MAX_RECORD_BYTES,
    })
  }
}

function safeName(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value) || value.startsWith('.'))
    throw new AppError('INVALID_PARAMS', 'A learning record name must be a plain file name')
  return value
}

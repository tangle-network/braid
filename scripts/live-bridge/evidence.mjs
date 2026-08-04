import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { evidenceValue, redactString } from './redaction.mjs'

export function errorEvidence(error) {
  if (error?.code !== undefined)
    return evidenceValue({
      code: error.code,
      message: error.message,
      exitCode: error.exitCode,
      details: error.details,
    })
  return evidenceValue({
    code: 'UNEXPECTED_ERROR',
    message: error instanceof Error ? error.message : String(error),
  })
}

export async function removeTemp(paths) {
  const results = await Promise.all(
    paths.filter(Boolean).map(async (path) => {
      try {
        await rm(path, { recursive: true, force: true })
        return { path, removed: true }
      } catch (error) {
        return {
          path,
          removed: false,
          error: safeErrorMessage(error),
        }
      }
    }),
  )
  return {
    ok: results.every((result) => result.removed),
    results,
  }
}

export async function writeEvidence(evidence) {
  const destination =
    process.env.BRAID_LIVE_BRIDGE_EVIDENCE ?? join(tmpdir(), `braid-live-bridge-${Date.now()}.json`)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, `${JSON.stringify(evidenceValue(evidence), null, 2)}\n`, {
    mode: 0o600,
  })
  return destination
}

export function safeErrorMessage(error) {
  return redactString(error instanceof Error ? error.message : String(error))
}

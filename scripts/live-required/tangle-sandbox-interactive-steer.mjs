import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { initializedSession, rpcRequest } from './headless.mjs'
import { closeBraidWithProof } from './tangle-sandbox-braid-stress.mjs'

/**
 * Steer the live run twice with one operation id from a second `braid rpc` process. The first
 * delivers the prompt; the second must replay it, so Runtime journals exactly one turn.
 */
export async function steerTwiceThroughBraid(packed, config, identity) {
  const runId = identity.run.id
  const text = 'Reply with one short sentence and change no files.'
  const operationId = `op-live-interactive-steer-${randomUUID()}`
  const initialized = await initializedSession(packed.binary, config)
  try {
    const first = await rpcRequest(initialized.session, 'steer', { runId, text }, operationId)
    const second = await rpcRequest(initialized.session, 'steer', { runId, text }, operationId)
    assert.equal(first.outcome, 'accepted', 'the first steer was not accepted')
    assert.ok(
      second.outcome === 'replayed' || second.outcome === 'already-applied',
      `the repeated steer was ${second.outcome}, not a replay`,
    )
    return { operationId, outcomes: [first.outcome, second.outcome] }
  } finally {
    await closeBraidWithProof(initialized.session, 'Braid interactive steer RPC process')
  }
}

/** Count Runtime's `agent.turn` records per steer operation in the run's observer journal. */
export async function steerTurnsFromJournal(config, sessionId, operationIds) {
  const path = join(
    dirname(config.environment.BRAID_STATE_PATH),
    'runtime-journal',
    sessionId,
    'observer.jsonl',
  )
  const turns = (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((record) => record.event?.target === 'agent.turn')
    .map((record) => record.event.payload?.operationId)
  const counts = Object.fromEntries(
    operationIds.map((id) => [id, turns.filter((turn) => turn === id).length]),
  )
  for (const [id, count] of Object.entries(counts))
    assert.equal(count, 1, `steer ${id} journaled ${count} turns in ${path}`)
  return { path, counts, once: Object.values(counts).every((count) => count === 1) }
}

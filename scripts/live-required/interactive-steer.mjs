import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { runFromState } from '../live-bridge/protocol.mjs'
import { initializedSession, rpcRequest, rpcState } from './headless.mjs'
import { closeBraidWithProof } from './tangle-sandbox-braid-stress.mjs'

/**
 * Steer the live run with one operation id from a second `braid rpc` process, then repeat it from a
 * third. The first delivers the prompt; Braid's durable control ledger must replay the repeat, so
 * Runtime journals exactly one turn.
 */
export async function steerTwiceThroughBraid(packed, config, identity) {
  const params = { runId: identity.run.id, text: 'Reply with one short sentence; change no files.' }
  const operationId = `op-live-interactive-steer-${randomUUID()}`
  const steerOnce = async () => {
    const initialized = await initializedSession(packed.binary, config)
    try {
      const startedAt = Date.now()
      const { outcome, replayed } = await rpcRequest(
        initialized.session,
        'steer',
        params,
        operationId,
      )
      // The acknowledgement carries control disposition; the run row names current state.
      const { state } = await rpcState(initialized.session)
      const run = runFromState(state, params.runId)
      return {
        outcome,
        replayed,
        acknowledgement: initialized.session.responses
          .filter((entry) => entry.type === 'event' && JSON.stringify(entry).includes(operationId))
          .at(-1),
        elapsedMs: Date.now() - startedAt,
        initialStatus: runFromState(initialized.state.state, params.runId)?.status,
        run: { status: run?.status, controls: run?.controls, lastError: run?.lastError },
      }
    } finally {
      await closeBraidWithProof(initialized.session, 'Braid interactive steer RPC process')
    }
  }
  const attempts = [await steerOnce(), await steerOnce()]
  const evidence = JSON.stringify(attempts)
  for (const attempt of attempts) {
    assert.match(
      attempt.initialStatus ?? '',
      /^(running|streaming|detached)$/u,
      `steer startup changed run state: ${JSON.stringify(attempt)}`,
    )
    assert.match(
      attempt.run.status ?? '',
      /^(running|streaming|detached)$/u,
      `steer changed run state: ${JSON.stringify(attempt)}`,
    )
  }
  assert.equal(attempts[0].outcome, 'accepted', `the first steer was not accepted: ${evidence}`)
  assert.equal(attempts[1].replayed, true, `the repeated steer was not a replay: ${evidence}`)
  return { operationId, attempts }
}

/**
 * Count Runtime's `agent.turn` records per steer operation in the run's observer journal.
 * Returns false when the proof ran without `--steer`.
 */
export async function steerTurnsFromJournal(config, sessionId, steers) {
  if (!steers.every(Boolean)) return false
  const operationIds = steers.map((attempt) => attempt.operationId)
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

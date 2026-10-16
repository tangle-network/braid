import assert from 'node:assert/strict'
import { join } from 'node:path'

import { runCommand } from '../live-bridge/command.mjs'
import { defaultTimeoutMs } from '../live-bridge/constants.mjs'

export async function runDeterministicRpcProof(binary, repository) {
  const proof = await runCommand(
    process.execPath,
    [join(repository, 'examples/rpc-first-task.mjs'), '--fixture'],
    {
      cwd: repository,
      env: { BRAID_BIN: binary, BRAID_FIRST_TASK: 'packed rpc proof' },
      timeoutMs: defaultTimeoutMs,
    },
  )
  assert.equal(proof.code, 0, `Packed first-task example failed: ${JSON.stringify(proof)}`)
  assert.equal(proof.cleanupOk, true, 'Packed first-task processes did not finish cleanly')
  const result = JSON.parse(proof.stdout.trim())
  assert.equal(result.status, 'completed')
  assert.equal(result.output, 'Fixture response through pi: packed rpc proof')
  assert.equal(result.shutdownAcknowledged, true)
  process.stdout.write(`Packed public first-task proof passed: ${result.runId}\n`)
}

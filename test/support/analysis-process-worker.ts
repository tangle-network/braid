import { writeFile } from 'node:fs/promises'
import { EncryptedAnalysisRepository } from '../../src/analysis/repository.js'
import { EncryptedBraidStatePort } from '../../src/analysis/encrypted-state-port.js'
import { MemoryStateKeyPort } from '../../src/analysis/state-port.js'

const mode = process.argv[2]
const statePath = process.argv[3]
const ownerId = process.argv[4] ?? 'owner-process'
if (!statePath || (mode !== 'reserve' && mode !== 'crash-temp')) process.exit(2)

if (mode === 'crash-temp') {
  await writeFile(`${statePath}.tmp`, 'crash-before-rename\n', { mode: 0o600 })
  process.kill(process.pid, 'SIGKILL')
} else {
  const repository = new EncryptedAnalysisRepository(
    new EncryptedBraidStatePort(statePath, new MemoryStateKeyPort(new Uint8Array(32).fill(21))),
  )
  const result = await repository.reserve({
    operationId: 'process-reservation-op',
    kind: 'analysis',
    targetId: 'process-reservation-analysis',
    requestDigest: 'sha256:process-reservation-request',
    ownerId,
    leaseUntil: '2099-01-01T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  })
  process.stdout.write(JSON.stringify({ created: result.created, ownerId: result.record.ownerId }))
}

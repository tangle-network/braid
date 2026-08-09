import { installPackedBraid } from './packed-binary.mjs'
import { runDeterministicRpcProof } from './packed-rpc/deterministic.mjs'
import { runPackedFirstRun } from './packed-rpc/first-run-tui.mjs'
import { runBuiltStartupProof } from './packed-rpc/production-startup.mjs'

const repository = new URL('../', import.meta.url).pathname
const packed = await installPackedBraid(repository)

try {
  await runBuiltStartupProof(packed.binary, repository)
  const startupProof = await runPackedFirstRun(packed.binary, repository)
  process.stdout.write(
    `Packed first-run setup, immediate send, restart, and persisted ${startupProof.model} send passed\n`,
  )
  await runDeterministicRpcProof(packed.binary, repository)
} finally {
  await packed.cleanup()
}

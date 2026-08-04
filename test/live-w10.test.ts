import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

interface LiveW10Adapter {
  runCrossRunnerHandoff(input: {
    readonly endpoint: string
    readonly credentialRef: string
  }): Promise<{ readonly passed: boolean }>
  runWorkspaceFork(input: {
    readonly endpoint: string
    readonly credentialRef: string
  }): Promise<{ readonly passed: boolean; readonly cleanupConfirmed: boolean }>
}

const endpoint = process.env.BRAID_TANGLE_ENDPOINT
const credentialRef = process.env.BRAID_TANGLE_CREDENTIAL_REF
const adapterPath = process.env.BRAID_W10_LIVE_ADAPTER
const skipReason =
  !endpoint || !credentialRef
    ? 'Tangle cloud cases require BRAID_TANGLE_ENDPOINT and BRAID_TANGLE_CREDENTIAL_REF'
    : !adapterPath
      ? 'Tangle deployment adapter is unavailable; set BRAID_W10_LIVE_ADAPTER to a real-provider adapter'
      : false

async function liveAdapter(): Promise<LiveW10Adapter> {
  if (!adapterPath) throw new Error('BRAID_W10_LIVE_ADAPTER is required')
  const loaded = (await import(pathToFileURL(adapterPath).href)) as {
    readonly default?: LiveW10Adapter
  }
  if (!loaded.default) throw new Error('The configured live adapter must export a default adapter')
  return loaded.default
}

test('LIVE-02 cross-runner handoff uses a fresh provider session', {
  skip: skipReason,
}, async () => {
  const result = await (await liveAdapter()).runCrossRunnerHandoff({
    endpoint: endpoint as string,
    credentialRef: credentialRef as string,
  })
  assert.equal(result.passed, true)
})

test('LIVE-09 workspace fork confirms independent destination and cleanup', {
  skip: skipReason,
}, async () => {
  const result = await (await liveAdapter()).runWorkspaceFork({
    endpoint: endpoint as string,
    credentialRef: credentialRef as string,
  })
  assert.equal(result.passed, true)
  assert.equal(result.cleanupConfirmed, true)
})

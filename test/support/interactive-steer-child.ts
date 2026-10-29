import { join } from 'node:path'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { NativeInteractiveRunBroker } from '../../src/adapters/runtime/native-interactive-run-broker.js'
import type { PreparedTangleRetainedConnection } from '../../src/adapters/runtime/production-tangle-sandbox-backend.js'
import { TangleRetainedInteractiveExecutionPort } from '../../src/adapters/runtime/tangle-retained-interactive-execution.js'
import { canonicalDigest } from '../../src/domain/canonical.js'
import { createOperationId, parseDigestValue } from '../../src/domain/ids.js'
import type { RuntimeEventEnvelope } from '../../src/domain/runtime-events.js'
import { createDurableBraidApplication } from '../../src/startup/durable-runtime.js'
import { FileCredentialStore } from './file-credentials.js'
import { networkInteractiveProvider } from './interactive-provider-network.js'

const root = process.env.STEER_TEST_ROOT ?? ''
const profile = defineAgentProfile({
  name: 'interactive process integration',
  harness: 'claude-code',
  model: { default: 'anthropic/claude-sonnet-4-5', provider: 'anthropic' },
})
const provider = networkInteractiveProvider(process.env.STEER_TEST_ENDPOINT ?? '')
const broker = new NativeInteractiveRunBroker()
const execution = new TangleRetainedInteractiveExecutionPort({
  resolve: async () =>
    ({
      profile,
      model: profile.model?.default,
      runner: profile.harness,
      provider,
      capabilities: await provider.capabilities(),
      idleTtlSeconds: 1_800,
      observation: {
        snapshot: async () => ({
          kind: 'sandbox',
          provider: 'tangle-sandbox',
          lifecycle: 'ready',
          lifecycleMode: 'retained',
          cleanup: 'explicit',
          continuity: 'session',
          location: 'remote',
          createdAt: '2026-10-28T00:00:00.000Z',
          observedAt: '2026-10-28T00:00:00.000Z',
          unavailable: [],
        }),
      },
    }) as unknown as PreparedTangleRetainedConnection,
  broker,
  journalRoot: join(root, 'runtime-journal'),
})
const { app } = await createDurableBraidApplication({
  path: join(root, 'braid.db'),
  storageRoot: root,
  profile,
  execution,
  credentialStore: new FileCredentialStore(join(root, 'credentials')),
  ...(Number(process.env.STEER_TEST_TIMEOUT ?? 5_000) < 1_000 ? { cancelTimeoutMs: 30 } : {}),
  ...{ steerTimeoutMs: Number(process.env.STEER_TEST_TIMEOUT ?? 5_000) },
})
await app.whenDurable()
process.send?.({ ready: true, state: app.state() })
process.on(
  'message',
  (input: {
    id: number
    command: string
    operationId: string
    runId: string
    text: string
    event?: unknown
  }) => {
    void (async () => {
      let result: unknown
      if (input.command === 'send') {
        app.initialize(root)
        await app.whenDurable()
        const sent = app.send({
          operationId: input.operationId,
          text: input.text,
          mode: 'interactive',
        })
        await sent.admissionReady
        while ((app.state().runs[0]?.lastProviderSequence ?? 0) < 1)
          await new Promise((resolve) => setTimeout(resolve, 5))
        result = { runId: sent.runId }
      } else if (input.command === 'steer') {
        const receipt = await app.steer(input)
        await receipt.completion
        result = { acknowledgement: receipt.acknowledgement, replayed: receipt.replayed }
      } else if (input.command === 'detach') {
        const receipt = await app.detachRun(input)
        await receipt.completion
      } else if (input.command === 'duplicate') {
        const event = input.event as RuntimeEventEnvelope
        await app.ingestRuntimeEvent(event)
        await app.ingestRuntimeEvent(event)
      } else if (input.command === 'cancel') {
        const receipt = await app.cancelRun(input)
        await receipt.completion
        result = { acknowledgement: receipt.acknowledgement }
      } else if (input.command === 'reconnect') {
        const completion = app.reconnectRun(input)
        await Promise.race([
          broker.waitForHandle(input.runId),
          completion.then(() => {
            throw new Error('Reconnect ended before handle publication')
          }),
        ])
        void completion.catch(() => undefined)
      } else if (input.command === 'shutdown') {
        await app.shutdown({ operationId: input.operationId }).completion
        await app.close()
      } else if (input.command === 'conditional') {
        const at = new Date().toISOString()
        await app.configuration.requestOperation({
          expectedRevision: app.state().revision,
          operation: {
            id: createOperationId(input.operationId),
            kind: 'connection-change',
            requestDigest: parseDigestValue(canonicalDigest(input)),
            status: 'pending',
            createdAt: at,
            updatedAt: at,
          },
        })
      } else if (input.command === 'state') result = app.state()
      else throw new Error(`Unknown command: ${input.command}`)
      await app.whenDurable()
      process.send?.({ id: input.id, result, state: app.state(), events: app.events() })
      if (input.command === 'shutdown') process.disconnect?.()
    })().catch((error: unknown) => process.send?.({ id: input.id, error: String(error) }))
  },
)

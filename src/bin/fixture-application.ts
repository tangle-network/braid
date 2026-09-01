import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { createBraidApplication } from '../app/composition.js'
import { DEFAULT_RUN_CAPABILITIES } from '../ports/execution.js'
import { deterministicBackend } from '../testing/deterministic-backend.js'
import { PRODUCT_DEMO_CONNECTION, PRODUCT_DEMO_PROFILE } from '../testing/product-demo-fixture.js'
import { createSupervisionUiFixture } from '../testing/supervision-ui-fixture.js'
import type { CliOptions } from './args.js'

export function openFixtureApplication(options: CliOptions) {
  if (options.fixture === undefined) throw new Error('Fixture application requires a fixture')
  const productDemo = options.uiFixture === 'product-demo'
  const cancellationUnavailable = options.uiFixture === 'cancellation-unavailable'
  const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
  const chunkDelayMs = Number.isFinite(configured) && configured >= 0 ? configured : 12
  const app = createBraidApplication({
    fixture: options.fixture,
    ...(productDemo ? { profile: PRODUCT_DEMO_PROFILE } : {}),
    ...(options.uiFixture === 'supervision' ? { intelligence: createSupervisionUiFixture() } : {}),
    ...(cancellationUnavailable
      ? {
          execution: new AgentRuntimeExecutionPort(
            (input) => deterministicBackend(input, { chunkDelayMs }),
            {
              ...DEFAULT_RUN_CAPABILITIES,
              controls: { ...DEFAULT_RUN_CAPABILITIES.controls, cancel: false },
            },
            { admissionMode: 'async' },
          ),
        }
      : {}),
    chunkDelayMs,
  })
  return {
    app,
    close: () => app.close(),
    ...(productDemo
      ? { profileConnectionOptions: { connections: [PRODUCT_DEMO_CONNECTION] } }
      : {}),
  }
}

import { createBraidApplication } from '../app/composition.js'
import { PRODUCT_DEMO_CONNECTION, PRODUCT_DEMO_PROFILE } from '../testing/product-demo-fixture.js'
import { createSupervisionUiFixture } from '../testing/supervision-ui-fixture.js'
import type { CliOptions } from './args.js'

export function openFixtureApplication(options: CliOptions) {
  if (options.fixture === undefined) throw new Error('Fixture application requires a fixture')
  const productDemo = options.uiFixture === 'product-demo'
  const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
  const app = createBraidApplication({
    fixture: options.fixture,
    ...(productDemo ? { profile: PRODUCT_DEMO_PROFILE } : {}),
    ...(options.uiFixture === 'supervision' ? { intelligence: createSupervisionUiFixture() } : {}),
    chunkDelayMs: Number.isFinite(configured) && configured >= 0 ? configured : 12,
  })
  return {
    app,
    close: () => app.close(),
    ...(productDemo
      ? { profileConnectionOptions: { connections: [PRODUCT_DEMO_CONNECTION] } }
      : {}),
  }
}

import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import { createBraidApplication, createDeterministicExecution } from '../app/composition.js'
import { createProfileRecord } from '../app/profiles.js'
import { SystemClock } from '../ports/clock.js'
import { DEFAULT_RUN_CAPABILITIES } from '../ports/execution.js'
import { deterministicBackend } from '../testing/deterministic-backend.js'
import { LEARNING_FIXTURE_PROFILE, learningFixtureResponse } from '../testing/learning-fixture.js'
import { createNativeChildUiFixture } from '../testing/native-child-ui-fixture.js'
import { PRODUCT_DEMO_CONNECTION, PRODUCT_DEMO_PROFILE } from '../testing/product-demo-fixture.js'
import {
  createProfileHandoffFixture,
  PROFILE_HANDOFF_REVIEWER,
} from '../testing/profile-handoff-fixture.js'
import { createSupervisionUiFixture } from '../testing/supervision-ui-fixture.js'
import type { CliOptions } from './args.js'
import { defaultLearningConfiguration } from './state-path.js'

export function openFixtureApplication(options: CliOptions) {
  if (options.fixture === undefined) throw new Error('Fixture application requires a fixture')
  const profileHandoff = options.uiFixture === 'profile-handoff'
  const productDemo = options.uiFixture === 'product-demo' || profileHandoff
  const cancellationUnavailable = options.uiFixture === 'cancellation-unavailable'
  const configured = Number(process.env.BRAID_FIXTURE_CHUNK_DELAY_MS ?? 12)
  const chunkDelayMs = Number.isFinite(configured) && configured >= 0 ? configured : 12
  const learning = options.uiFixture === 'learning'
  const app = createBraidApplication({
    fixture: options.fixture,
    ...(productDemo ? { profile: PRODUCT_DEMO_PROFILE } : {}),
    ...(learning
      ? {
          profile: LEARNING_FIXTURE_PROFILE,
          // Replays start from the last commit before each run, so runs need real times.
          clock: new SystemClock(),
          execution: createDeterministicExecution({
            chunkDelayMs,
            respond: learningFixtureResponse,
          }),
        }
      : {}),
    ...(options.uiFixture === 'supervision' ? { intelligence: createSupervisionUiFixture() } : {}),
    ...(options.uiFixture === 'native-children' ? { execution: createNativeChildUiFixture() } : {}),
    ...(profileHandoff ? { execution: createProfileHandoffFixture() } : {}),
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
  // A fixture never reads or writes the user's learning store: `/learn` needs an explicit one.
  const learningStore = process.env.BRAID_LEARN_DIRECTORY
    ? { learning: defaultLearningConfiguration() }
    : {}
  return {
    app,
    close: () => app.close(),
    ...(learning ? { profileConnectionOptions: learningStore } : {}),
    ...(productDemo
      ? {
          profileConnectionOptions: {
            connections: [PRODUCT_DEMO_CONNECTION],
            ...(profileHandoff ? { profiles: profileHandoffCatalog() } : {}),
          },
        }
      : {}),
  }
}

/** Two trusted inline catalog entries so `/fork --profile` can select the second one. */
function profileHandoffCatalog() {
  return [PRODUCT_DEMO_PROFILE, PROFILE_HANDOFF_REVIEWER].map((profile) =>
    createProfileRecord(
      {
        kind: 'inline',
        reference: `braid:fixture/${profile.name ?? 'profile'}`,
        label: profile.name ?? 'Fixture profile',
        writable: false,
        trusted: true,
      },
      profile,
    ),
  )
}

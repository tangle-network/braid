import { join } from 'node:path'
import {
  defineAgentProfile,
  type AgentEnvironmentCapabilities,
  type AgentProfile,
  type HarnessType,
} from '@tangle-network/agent-interface'
import { AgentRuntimeExecutionPort } from '../adapters/runtime/agent-runtime-execution.js'
import type {
  ConnectionCapabilitySnapshot,
  ConnectionProviderPort,
} from '../connection/connections.js'
import { createConnectionRecord, type ConnectionRecord } from '../connection/connections.js'
import { RunAdmissionController, type RunAdmissionPort } from '../controllers/run-admission.js'
import { materializationReceiptDigest } from '../controllers/materialization-receipt.js'
import { JsonAdmissionLedger } from '../controllers/json-admission-ledger.js'
import { JsonReceiptStore } from '../controllers/json-receipt-store.js'
import { MemoryReceiptStore } from '../controllers/admission-contracts.js'
import type {
  WorkspaceInspectionFile,
  WorkspaceIdentity,
  WorkspaceTrustStore,
} from '../connection/workspace-trust.js'
import { profileDocumentFromJson, type ProfileDocument } from '../profile/profile-sources.js'
import { validateCanonicalProfile } from '../profile/profile-validation.js'
import { FixedClock, SystemClock, type Clock } from '../ports/clock.js'
import { RandomIds, SequenceIds, type IdSource } from '../ports/ids.js'
import type { ExecutionPort } from '../ports/execution.js'
import { deterministicBackend, unconfiguredBackend } from '../testing/deterministic-backend.js'
import {
  RunAdmissionGate,
  UnconfiguredAdmissionGate,
  type ApplicationAdmissionGate,
} from './admission-gate.js'
import { BraidApplication } from './application.js'

export const STARTER_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
})

export const DETERMINISTIC_PROFILE: Readonly<AgentProfile> = defineAgentProfile({
  name: 'Braid starter',
  description: 'A portable starter profile for the Braid terminal',
  harness: 'pi',
  model: {
    default: 'fixture/deterministic',
    reasoningEffort: 'none',
  },
})

export interface CompositionOptions {
  readonly fixture?: 'deterministic'
  readonly clock?: Clock
  readonly ids?: IdSource
  readonly profile?: Readonly<AgentProfile>
  readonly profileDocument?: ProfileDocument
  readonly chunkDelayMs?: number
  readonly admission?: ApplicationAdmissionGate
  readonly provider?: ConnectionProviderPort
  readonly connection?: ConnectionRecord
  readonly runtime?: RunAdmissionPort
  readonly execution?: ExecutionPort
  readonly workspaceTrust?: WorkspaceTrustStore
  readonly admissionStorageDirectory?: string
  readonly workspaceAuthority?: Readonly<{
    readonly identity: WorkspaceIdentity
    readonly files: readonly WorkspaceInspectionFile[]
  }>
}

function fixtureCapabilities(): ConnectionCapabilitySnapshot {
  const profile = {
    namedProfiles: true,
    systemPrompt: true,
    instructions: true,
    tools: true,
    permissions: true,
    mcp: true,
    subagents: true,
    resources: {
      files: true,
      instructions: true,
      tools: true,
      skills: true,
      agents: true,
      commands: true,
    },
    hooks: true,
    modes: true,
    runtimeUpdate: false,
    validation: true,
    extensions: [],
  }
  const environment: AgentEnvironmentCapabilities = {
    profile,
    streaming: { live: true, replay: true, detach: true, turnIdempotency: true },
    sessions: { continue: true, list: true, messages: true },
    workspace: { read: true, write: true, exec: true, git: true, upload: true, download: true },
    branching: { checkpoint: true, fork: true },
    placement: true,
    usage: true,
    confidential: true,
  }
  return Object.freeze({
    environment,
    supportedRunners: Object.freeze(['pi' as HarnessType]),
    modelIds: Object.freeze(['fixture/deterministic']),
    modelReasoning: Object.freeze({}),
    retrievedAt: '2026-08-01T00:00:00.000Z',
    source: 'deterministic-fixture',
  })
}

function fixtureProvider(): ConnectionProviderPort {
  return {
    kind: 'cli-bridge',
    async health() {
      return { status: 'healthy', checkedAt: '2026-08-01T00:00:00.000Z' }
    },
    async capabilities() {
      return fixtureCapabilities()
    },
    async validateProfile() {
      return { ok: true, issues: [] }
    },
  }
}

function fixtureConnection(): ConnectionRecord {
  return createConnectionRecord({
    id: 'deterministic-fixture',
    kind: 'cli-bridge',
    name: 'Deterministic fixture',
    endpoint: 'http://127.0.0.1:7331',
    now: '2026-08-01T00:00:00.000Z',
  })
}

function fixtureRuntime(): RunAdmissionPort {
  return {
    async confirmCapabilities(input) {
      if (input.capabilityDigest !== input.capabilities.digest) {
        throw new Error('fixture capability binding mismatch')
      }
    },
    async admit(input) {
      const body = {
        requestDigest: input.requestDigest,
        effectiveProfileDigest: input.effectiveProfileDigest,
        capabilityDigest: input.capabilityDigest,
        generatedPaths: [],
        unsupportedDimensions: [],
        normalizedValues: {},
        runtimeRunId: input.operationId,
      } as const
      return {
        materializationDigest: materializationReceiptDigest(body),
        ...body,
      }
    },
  }
}

function internalProfileDocument(profile: Readonly<AgentProfile>): ProfileDocument {
  const validation = validateCanonicalProfile(profile)
  if (
    !validation.ok ||
    validation.profile === undefined ||
    validation.canonicalJson === undefined
  ) {
    throw new Error('Cannot compose an invalid or oversized profile')
  }
  return profileDocumentFromJson(validation.canonicalJson, {
    kind: 'inline',
    value: 'braid:internal',
    label: 'Braid internal profile',
    writable: true,
  })
}

function compositionAdmission(options: {
  readonly source: ProfileDocument
  readonly provider: ConnectionProviderPort
  readonly connection: ConnectionRecord
  readonly runtime: RunAdmissionPort
  readonly workspaceTrust?: WorkspaceTrustStore
  readonly workspaceAuthority?: CompositionOptions['workspaceAuthority']
  readonly admissionStorageDirectory?: string
  readonly now: () => string
}): ApplicationAdmissionGate {
  const receipts =
    options.admissionStorageDirectory === undefined
      ? new MemoryReceiptStore()
      : new JsonReceiptStore(join(options.admissionStorageDirectory, 'receipts.json'))
  const controller = new RunAdmissionController({
    provider: options.provider,
    runtime: options.runtime,
    receipts,
    ...(options.admissionStorageDirectory === undefined
      ? {}
      : {
          ledger: new JsonAdmissionLedger(join(options.admissionStorageDirectory, 'ledger.json')),
        }),
    ...(options.workspaceTrust === undefined ? {} : { workspaceTrust: options.workspaceTrust }),
    now: options.now,
  })
  return new RunAdmissionGate({
    admission: controller,
    provider: options.provider,
    connection: options.connection,
    source: options.source,
    ...(options.workspaceAuthority === undefined
      ? {}
      : { workspaceAuthority: options.workspaceAuthority }),
  })
}

export function createBraidApplication(options: CompositionOptions = {}): BraidApplication {
  const isFixture = options.fixture === 'deterministic'
  const profile =
    options.profile ??
    options.profileDocument?.profile ??
    (isFixture ? DETERMINISTIC_PROFILE : STARTER_PROFILE)
  const profileValidation = validateCanonicalProfile(profile)
  if (!profileValidation.ok || profileValidation.profile === undefined) {
    throw new Error('Cannot compose an invalid or oversized profile')
  }
  const boundedProfile = profileValidation.profile
  const source = options.profileDocument ?? internalProfileDocument(boundedProfile)
  const clock = options.clock ?? (isFixture ? new FixedClock() : new SystemClock())
  const execution =
    options.execution ??
    new AgentRuntimeExecutionPort((input) =>
      isFixture
        ? deterministicBackend(input, {
            ...(options.chunkDelayMs === undefined ? {} : { chunkDelayMs: options.chunkDelayMs }),
          })
        : unconfiguredBackend(input),
    )
  const provider = options.provider ?? (isFixture ? fixtureProvider() : undefined)
  const connection = options.connection ?? (isFixture ? fixtureConnection() : undefined)
  const runtime = options.runtime ?? (isFixture ? fixtureRuntime() : undefined)
  const admission =
    options.admission ??
    (provider !== undefined && connection !== undefined && runtime !== undefined
      ? compositionAdmission({
          source,
          provider,
          connection,
          runtime,
          ...(options.workspaceTrust === undefined
            ? {}
            : { workspaceTrust: options.workspaceTrust }),
          ...(options.workspaceAuthority === undefined
            ? {}
            : { workspaceAuthority: options.workspaceAuthority }),
          ...(options.admissionStorageDirectory === undefined
            ? {}
            : { admissionStorageDirectory: options.admissionStorageDirectory }),
          now: () => clock.now(),
        })
      : new UnconfiguredAdmissionGate())
  return new BraidApplication({
    profile: boundedProfile,
    execution,
    admission,
    clock,
    ids: options.ids ?? (isFixture ? new SequenceIds() : new RandomIds()),
  })
}

import {
  AgentExactRunControlRefSchema,
  AgentInteractiveSessionRefSchema,
  AgentInteractiveSessionStartSchema,
} from '@tangle-network/agent-interface'
import { canonicalDigest } from './canonical.js'
import type { RunRecord } from './entities.js'
import { fail, nonEmpty } from './invariants-base.js'

function assertControlRef(value: unknown, label: string): void {
  if (!AgentExactRunControlRefSchema.safeParse(value).success) fail(`${label} is invalid`)
}

function assertProviderSession(record: RunRecord, sessionId: string): void {
  if (record.providerSessionId !== undefined && sessionId !== record.providerSessionId) {
    fail('run.retainedAdmission session must match run.providerSessionId')
  }
}

function assertNoControlRef(record: RunRecord, phase: string): void {
  if (record.controlRef !== undefined) {
    fail(`run.controlRef is invalid during retained ${phase} admission`)
  }
}

function assertStoredControlRef(record: RunRecord, value: unknown): void {
  assertControlRef(value, 'run.retainedAdmission.controlRef')
  if (record.controlRef === undefined) fail('run.controlRef is required after retained start')
  if (canonicalDigest(value) !== canonicalDigest(record.controlRef)) {
    fail('run.controlRef must match run.retainedAdmission control reference')
  }
}

export function assertRetainedRunAdmission(record: RunRecord): void {
  const admission = record.retainedAdmission
  if (admission === undefined) return
  nonEmpty(admission.idempotencyKey, 'run.retainedAdmission.idempotencyKey')

  switch (admission.phase) {
    case 'intent':
      nonEmpty(admission.provider, 'run.retainedAdmission.provider')
      nonEmpty(admission.turnId, 'run.retainedAdmission.turnId')
      nonEmpty(admission.sessionId, 'run.retainedAdmission.sessionId')
      nonEmpty(admission.executionId, 'run.retainedAdmission.executionId')
      nonEmpty(admission.runId, 'run.retainedAdmission.runId')
      nonEmpty(admission.requestedProfileDigest, 'run.retainedAdmission.requestedProfileDigest')
      nonEmpty(admission.requestDigest, 'run.retainedAdmission.requestDigest')
      assertProviderSession(record, admission.sessionId)
      assertNoControlRef(record, admission.phase)
      return
    case 'environment':
      nonEmpty(admission.provider, 'run.retainedAdmission.provider')
      nonEmpty(admission.environmentId, 'run.retainedAdmission.environmentId')
      nonEmpty(admission.turnId, 'run.retainedAdmission.turnId')
      nonEmpty(admission.sessionId, 'run.retainedAdmission.sessionId')
      nonEmpty(admission.executionId, 'run.retainedAdmission.executionId')
      assertProviderSession(record, admission.sessionId)
      if (
        record.controlRef !== undefined &&
        (admission.provider !== record.controlRef.provider ||
          admission.environmentId !== record.controlRef.environmentId ||
          admission.sessionId !== record.controlRef.sessionId ||
          admission.executionId !== record.controlRef.executionId)
      ) {
        fail('run.controlRef must match run.retainedAdmission recovery coordinates')
      }
      return
    case 'dispatched':
      nonEmpty(admission.turnId, 'run.retainedAdmission.turnId')
      assertProviderSession(record, admission.controlRef.sessionId)
      assertStoredControlRef(record, admission.controlRef)
      return
    case 'interactive_intent':
      nonEmpty(admission.provider, 'run.retainedAdmission.provider')
      nonEmpty(
        admission.interactiveIdempotencyKey,
        'run.retainedAdmission.interactiveIdempotencyKey',
      )
      nonEmpty(admission.sessionId, 'run.retainedAdmission.sessionId')
      nonEmpty(admission.executionId, 'run.retainedAdmission.executionId')
      nonEmpty(admission.runId, 'run.retainedAdmission.runId')
      nonEmpty(admission.requestedProfileDigest, 'run.retainedAdmission.requestedProfileDigest')
      nonEmpty(admission.requestDigest, 'run.retainedAdmission.requestDigest')
      assertProviderSession(record, admission.sessionId)
      assertNoControlRef(record, admission.phase)
      return
    case 'interactive_environment': {
      nonEmpty(admission.provider, 'run.retainedAdmission.provider')
      nonEmpty(admission.environmentId, 'run.retainedAdmission.environmentId')
      nonEmpty(
        admission.interactiveIdempotencyKey,
        'run.retainedAdmission.interactiveIdempotencyKey',
      )
      const request = AgentInteractiveSessionStartSchema.safeParse(admission.request)
      if (!request.success) fail('run.retainedAdmission.request is invalid')
      if (
        request.data.run.provider !== admission.provider ||
        request.data.run.environmentId !== admission.environmentId
      ) {
        fail('run.retainedAdmission.request must match its environment')
      }
      assertProviderSession(record, request.data.run.sessionId)
      assertNoControlRef(record, admission.phase)
      return
    }
    case 'interactive_started': {
      nonEmpty(
        admission.interactiveIdempotencyKey,
        'run.retainedAdmission.interactiveIdempotencyKey',
      )
      const ref = AgentInteractiveSessionRefSchema.safeParse(admission.ref)
      if (!ref.success) fail('run.retainedAdmission.ref is invalid')
      assertProviderSession(record, ref.data.run.sessionId)
      assertStoredControlRef(record, ref.data.run)
      return
    }
  }
}

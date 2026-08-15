import { AgentExactRunControlRefSchema } from '@tangle-network/agent-interface'
import type { RunRecord } from './entities.js'
import { canonicalDigest } from './canonical.js'
import { fail, nonEmpty } from './invariants-base.js'

function assertControlRef(value: unknown, label: string): void {
  if (!AgentExactRunControlRefSchema.safeParse(value).success) fail(`${label} is invalid`)
}

export function assertRetainedRunAdmission(record: RunRecord): void {
  const admission = record.retainedAdmission
  if (admission === undefined) return
  nonEmpty(admission.idempotencyKey, 'run.retainedAdmission.idempotencyKey')
  nonEmpty(admission.turnId, 'run.retainedAdmission.turnId')

  if (admission.phase === 'environment') {
    nonEmpty(admission.provider, 'run.retainedAdmission.provider')
    nonEmpty(admission.environmentId, 'run.retainedAdmission.environmentId')
    nonEmpty(admission.sessionId, 'run.retainedAdmission.sessionId')
    nonEmpty(admission.executionId, 'run.retainedAdmission.executionId')
    if (
      record.providerSessionId !== undefined &&
      admission.sessionId !== record.providerSessionId
    ) {
      fail('run.retainedAdmission.sessionId must match run.providerSessionId')
    }
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
  }

  assertControlRef(admission.controlRef, 'run.retainedAdmission.controlRef')
  if (record.controlRef === undefined) {
    fail('run.controlRef is required after retained dispatch admission')
  }
  if (canonicalDigest(admission.controlRef) !== canonicalDigest(record.controlRef)) {
    fail('run.controlRef must match run.retainedAdmission.controlRef')
  }
}

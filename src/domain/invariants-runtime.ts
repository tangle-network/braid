import { isReplayCursor } from './ids.js'

import type {
  AutomationRuleRecord,
  BindingRecord,
  CheckpointRecord,
  DraftRecord,
  EffectRecord,
  EnvironmentRecord,
  GraphEdgeRecord,
  GraphNodeRecord,
  OperationRecord,
  QueueEntryRecord,
  QueueRecord,
  SupervisorRecord,
  WorkerRecord,
} from './entities.js'
import {
  OPERATION_KINDS,
  OPERATION_STATUSES,
  assertDate,
  assertDigest,
  assertEntityId,
  assertUniqueIds,
  fail,
  finiteNonNegative,
  finitePositive,
  nonEmpty,
} from './invariants-base.js'

export function assertEnvironmentRecord(record: EnvironmentRecord): void {
  assertEntityId('environment', record.id, 'environment.id')
  assertEntityId('workspace', record.workspaceId, 'environment.workspaceId')
  assertEntityId('connection', record.connectionId, 'environment.connectionId')
  nonEmpty(record.placement.provider, 'environment.placement.provider')
  record.secretNames.forEach((name) => {
    nonEmpty(name, 'environment.secretNames')
  })
  assertDate(record.createdAt, 'environment.createdAt')
  assertDate(record.updatedAt, 'environment.updatedAt')
}

export function assertCheckpointRecord(record: CheckpointRecord): void {
  assertEntityId('checkpoint', record.id, 'checkpoint.id')
  assertEntityId('environment', record.sourceEnvironmentId, 'checkpoint.sourceEnvironmentId')
  assertEntityId('branch', record.sourceBranchId, 'checkpoint.sourceBranchId')
  if (record.sourceRunId !== undefined)
    assertEntityId('run', record.sourceRunId, 'checkpoint.sourceRunId')
  if (record.throughMessageId !== undefined)
    assertEntityId('message', record.throughMessageId, 'checkpoint.throughMessageId')
  assertDigest(record.requestDigest, 'checkpoint.requestDigest')
  assertEntityId('operation', record.operationId, 'checkpoint.operationId')
  if (record.stateDigest !== undefined) assertDigest(record.stateDigest, 'checkpoint.stateDigest')
  assertDate(record.createdAt, 'checkpoint.createdAt')
}

export function assertSupervisorRecord(record: SupervisorRecord): void {
  assertEntityId('supervisor', record.id, 'supervisor.id')
  assertEntityId('run', record.rootRunId, 'supervisor.rootRunId')
  assertDate(record.createdAt, 'supervisor.createdAt')
  assertDate(record.updatedAt, 'supervisor.updatedAt')
}

export function assertWorkerRecord(record: WorkerRecord): void {
  assertEntityId('worker', record.id, 'worker.id')
  assertEntityId('supervisor', record.supervisorId, 'worker.supervisorId')
  if (record.parentWorkerId !== undefined)
    assertEntityId('worker', record.parentWorkerId, 'worker.parentWorkerId')
  if (record.runId !== undefined) assertEntityId('run', record.runId, 'worker.runId')
  for (const [name, value] of [
    ['spendUsd', record.spendUsd],
    ['inputTokens', record.inputTokens],
    ['outputTokens', record.outputTokens],
    ['latencyMs', record.latencyMs],
  ] as const) {
    if (value !== undefined) finiteNonNegative(value, `worker.${name}`)
  }
  assertDate(record.createdAt, 'worker.createdAt')
  assertDate(record.updatedAt, 'worker.updatedAt')
}

export function assertDraftRecord(record: DraftRecord): void {
  assertEntityId('draft', record.id, 'draft.id')
  assertEntityId('branch', record.branchId, 'draft.branchId')
  assertDate(record.updatedAt, 'draft.updatedAt')
}

export function assertQueueEntryRecord(record: QueueEntryRecord): void {
  assertEntityId('queueEntry', record.id, 'queueEntry.id')
  assertEntityId('queue', record.queueId, 'queueEntry.queueId')
  assertEntityId('branch', record.branchId, 'queueEntry.branchId')
  assertEntityId('operation', record.operationId, 'queueEntry.operationId')
  finiteNonNegative(record.position, 'queueEntry.position')
  assertDate(record.createdAt, 'queueEntry.createdAt')
  assertDate(record.updatedAt, 'queueEntry.updatedAt')
}

export function assertQueueRecord(
  record: QueueRecord,
  entries?: readonly QueueEntryRecord[],
): void {
  assertEntityId('queue', record.id, 'queue.id')
  assertEntityId('branch', record.branchId, 'queue.branchId')
  record.entryIds.forEach((id) => {
    assertEntityId('queueEntry', id, 'queue.entryIds')
  })
  assertUniqueIds(record.entryIds, 'queue.entryIds')
  if (entries !== undefined) {
    const owned = entries.filter((entry) => entry.queueId === record.id)
    assertUniqueIds(
      owned.map((entry) => entry.id),
      'queue entries',
    )
  }
  assertDate(record.createdAt, 'queue.createdAt')
  assertDate(record.updatedAt, 'queue.updatedAt')
}

export function assertAutomationRuleRecord(record: AutomationRuleRecord): void {
  assertEntityId('rule', record.id, 'rule.id')
  if (record.matcher.profileDigest !== undefined)
    assertDigest(record.matcher.profileDigest, 'rule.matcher.profileDigest')
  if (record.matcher.connectionId !== undefined)
    assertEntityId('connection', record.matcher.connectionId, 'rule.matcher.connectionId')
  if (record.matcher.workspaceId !== undefined)
    assertEntityId('workspace', record.matcher.workspaceId, 'rule.matcher.workspaceId')
  for (const [name, value] of Object.entries(record.answer)) {
    if (
      /(secret|password|passphrase|token|bearer|authorization|credential|private(?:[_-]?key)?|api[-_]?key)/iu.test(
        name,
      )
    ) {
      fail(`rule.answer.${name} is secret-designated and cannot be retained`)
    }
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      !(Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    ) {
      fail('rule.answer contains a secret or unsupported value')
    }
  }
  finiteNonNegative(record.uses, 'rule.uses')
  if (record.maximumUses !== undefined) finiteNonNegative(record.maximumUses, 'rule.maximumUses')
  if (record.expiresAt !== undefined) assertDate(record.expiresAt, 'rule.expiresAt')
  assertDate(record.createdAt, 'rule.createdAt')
}

export function assertBindingRecord(record: BindingRecord): void {
  assertEntityId('binding', record.id, 'binding.id')
  assertEntityId('branch', record.branchId, 'binding.branchId')
  assertEntityId('connection', record.connectionId, 'binding.connectionId')
  if (record.runId !== undefined) assertEntityId('run', record.runId, 'binding.runId')
  if (record.providerSessionId !== undefined)
    assertEntityId('providerSession', record.providerSessionId, 'binding.providerSessionId')
  if (record.environmentId !== undefined)
    assertEntityId('environment', record.environmentId, 'binding.environmentId')
  if (record.checkpointId !== undefined)
    assertEntityId('checkpoint', record.checkpointId, 'binding.checkpointId')
  if (record.replayCursor !== undefined && !isReplayCursor(record.replayCursor))
    fail('binding.replayCursor is invalid')
  if (record.boundaryDigest !== undefined)
    assertDigest(record.boundaryDigest, 'binding.boundaryDigest')
  if (
    record.runId === undefined &&
    record.environmentId === undefined &&
    record.providerSessionId === undefined
  ) {
    fail('binding must identify a run, provider session, or environment')
  }
  assertDate(record.createdAt, 'binding.createdAt')
  assertDate(record.updatedAt, 'binding.updatedAt')
}

export function assertGraphNodeRecord(record: GraphNodeRecord): void {
  assertEntityId('graphNode', record.id, 'graphNode.id')
  assertEntityId(
    record.reference.kind === 'workspace'
      ? 'workspace'
      : record.reference.kind === 'profile'
        ? 'profile'
        : record.reference.kind === 'conversation'
          ? 'conversation'
          : record.reference.kind === 'branch'
            ? 'branch'
            : record.reference.kind === 'turn'
              ? 'turn'
              : record.reference.kind === 'run'
                ? 'run'
                : record.reference.kind === 'message'
                  ? 'message'
                  : record.reference.kind === 'analysis'
                    ? 'analysis'
                    : record.reference.kind === 'environment'
                      ? 'environment'
                      : record.reference.kind === 'checkpoint'
                        ? 'checkpoint'
                        : record.reference.kind === 'supervisor'
                          ? 'supervisor'
                          : 'worker',
    record.reference.id,
    'graphNode.reference.id',
  )
  assertDate(record.createdAt, 'graphNode.createdAt')
  assertDate(record.updatedAt, 'graphNode.updatedAt')
}

export function assertGraphEdgeRecord(record: GraphEdgeRecord): void {
  assertEntityId('graphEdge', record.id, 'graphEdge.id')
  assertEntityId('graphNode', record.source, 'graphEdge.source')
  assertEntityId('graphNode', record.destination, 'graphEdge.destination')
  if (record.provenance.operationId !== undefined)
    assertEntityId('operation', record.provenance.operationId, 'graphEdge.provenance.operationId')
  if (record.provenance.receiptId !== undefined)
    assertEntityId('receipt', record.provenance.receiptId, 'graphEdge.provenance.receiptId')
  if (record.provenance.sourceDigest !== undefined)
    assertDigest(record.provenance.sourceDigest, 'graphEdge.provenance.sourceDigest')
  assertDate(record.createdAt, 'graphEdge.createdAt')
}

export function assertOperationRecord(record: OperationRecord): void {
  assertEntityId('operation', record.id, 'operation.id')
  if (!OPERATION_KINDS.has(record.kind)) fail('operation.kind is not recognized')
  if (!OPERATION_STATUSES.has(record.status)) fail('operation.status is not recognized')
  assertDigest(record.requestDigest, 'operation.requestDigest')
  if (record.target !== undefined) {
    const kind = record.target.kind
    assertEntityId(kind, record.target.id, 'operation.target.id')
  }
  assertDate(record.createdAt, 'operation.createdAt')
  assertDate(record.updatedAt, 'operation.updatedAt')
  if (record.acknowledgedAt !== undefined)
    assertDate(record.acknowledgedAt, 'operation.acknowledgedAt')
}

export function assertEffectRecord(record: EffectRecord): void {
  assertEntityId('effect', record.id, 'effect.id')
  assertEntityId('operation', record.operationId, 'effect.operationId')
  nonEmpty(record.effectKind, 'effect.effectKind')
  assertDigest(record.requestDigest, 'effect.requestDigest')
  if (!OPERATION_KINDS.has(record.kind)) fail('effect.kind is not recognized')
  if (!OPERATION_STATUSES.has(record.status)) fail('effect.status is not recognized')
  finitePositive(record.attempt, 'effect.attempt')
  if (record.externalReceiptId !== undefined)
    assertEntityId('receipt', record.externalReceiptId, 'effect.externalReceiptId')
  if (record.outcomeDigest !== undefined) assertDigest(record.outcomeDigest, 'effect.outcomeDigest')
  assertDate(record.createdAt, 'effect.createdAt')
  assertDate(record.updatedAt, 'effect.updatedAt')
}

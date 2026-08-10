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
import { isReplayCursor } from './ids.js'
import {
  assertDate,
  assertDigest,
  assertEntityId,
  assertJsonValue,
  assertUniqueIds,
  fail,
  finiteNonNegative,
  finitePositive,
  nonEmpty,
  OPERATION_KINDS,
  OPERATION_STATUSES,
} from './invariants-base.js'

export function assertEnvironmentRecord(record: EnvironmentRecord): void {
  assertEntityId('environment', record.id, 'environment.id')
  assertEntityId('workspace', record.workspaceId, 'environment.workspaceId')
  assertEntityId('connection', record.connectionId, 'environment.connectionId')
  nonEmpty(record.placement.provider, 'environment.placement.provider')
  if (record.placement.region !== undefined)
    nonEmpty(record.placement.region, 'environment.placement.region')
  if (record.placement.account !== undefined)
    nonEmpty(record.placement.account, 'environment.placement.account')
  if (
    record.kind !== undefined &&
    !['local-process', 'remote-service', 'sandbox'].includes(record.kind)
  )
    fail('environment.kind is invalid')
  for (const [name, value] of [
    ['providerEnvironmentId', record.providerEnvironmentId],
    ['runtimeEndpointHost', record.runtimeEndpointHost],
    ['machineId', record.machineId],
    ['requestedRegion', record.requestedRegion],
  ] as const) {
    if (value !== undefined) nonEmpty(value, `environment.${name}`)
  }
  if (
    record.lifecycleMode !== undefined &&
    !['request', 'ephemeral', 'retained'].includes(record.lifecycleMode)
  )
    fail('environment.lifecycleMode is invalid')
  if (
    record.cleanup !== undefined &&
    !['delete-after-turn', 'explicit', 'not-applicable'].includes(record.cleanup)
  )
    fail('environment.cleanup is invalid')
  if (
    record.continuity !== undefined &&
    !['session', 'unavailable', 'not-applicable'].includes(record.continuity)
  )
    fail('environment.continuity is invalid')
  if (record.location !== undefined && !['local', 'remote', 'unknown'].includes(record.location))
    fail('environment.location is invalid')
  if (
    record.storagePersistence !== undefined &&
    !['ephemeral-home', 'persistent-home', 'unknown'].includes(record.storagePersistence)
  )
    fail('environment.storagePersistence is invalid')
  if (record.requestedResources !== undefined) {
    for (const [name, value] of [
      ['cpuCores', record.requestedResources.cpuCores],
      ['memoryMB', record.requestedResources.memoryMB],
      ['diskGB', record.requestedResources.diskGB],
    ] as const) {
      if (value !== undefined) finitePositive(value, `environment.requestedResources.${name}`)
    }
    if (record.requestedResources.accelerator !== undefined) {
      nonEmpty(
        record.requestedResources.accelerator.kind,
        'environment.requestedResources.accelerator.kind',
      )
      finitePositive(
        record.requestedResources.accelerator.count,
        'environment.requestedResources.accelerator.count',
      )
      if (record.requestedResources.accelerator.memoryMB !== undefined)
        finitePositive(
          record.requestedResources.accelerator.memoryMB,
          'environment.requestedResources.accelerator.memoryMB',
        )
    }
  }
  if (record.resourceSample !== undefined) {
    finitePositive(record.resourceSample.cgroupVersion, 'environment.resourceSample.cgroupVersion')
    finiteNonNegative(
      record.resourceSample.memoryCurrentMb,
      'environment.resourceSample.memoryCurrentMb',
    )
    if (record.resourceSample.memoryPeakMb !== undefined)
      finiteNonNegative(
        record.resourceSample.memoryPeakMb,
        'environment.resourceSample.memoryPeakMb',
      )
    if (record.resourceSample.memoryLimitMb !== undefined)
      finiteNonNegative(
        record.resourceSample.memoryLimitMb,
        'environment.resourceSample.memoryLimitMb',
      )
    finiteNonNegative(record.resourceSample.cpuUsageUsec, 'environment.resourceSample.cpuUsageUsec')
    assertDate(record.resourceSample.sampledAt, 'environment.resourceSample.sampledAt')
  }
  if (record.gpu !== undefined) {
    nonEmpty(record.gpu.provider, 'environment.gpu.provider')
    nonEmpty(record.gpu.accelerator, 'environment.gpu.accelerator')
    nonEmpty(record.gpu.status, 'environment.gpu.status')
    finitePositive(record.gpu.count, 'environment.gpu.count')
    for (const [name, value] of [
      ['customerPricePerHourUsd', record.gpu.customerPricePerHourUsd],
      ['estimatedCustomerCostUsd', record.gpu.estimatedCustomerCostUsd],
      ['billedSeconds', record.gpu.billedSeconds],
      ['billedCustomerCostUsd', record.gpu.billedCustomerCostUsd],
    ] as const) {
      if (value !== undefined) finiteNonNegative(value, `environment.gpu.${name}`)
    }
  }
  if (record.accountUsage !== undefined) assertSandboxAccount(record.accountUsage)
  record.unavailableTelemetry?.forEach((value) => {
    nonEmpty(value, 'environment.unavailableTelemetry')
  })
  record.secretNames.forEach((name) => {
    nonEmpty(name, 'environment.secretNames')
  })
  assertDate(record.createdAt, 'environment.createdAt')
  if (record.startedAt !== undefined) assertDate(record.startedAt, 'environment.startedAt')
  if (record.lastActivityAt !== undefined)
    assertDate(record.lastActivityAt, 'environment.lastActivityAt')
  if (record.expiresAt !== undefined) assertDate(record.expiresAt, 'environment.expiresAt')
  assertDate(record.updatedAt, 'environment.updatedAt')
}

function assertSandboxAccount(account: NonNullable<EnvironmentRecord['accountUsage']>): void {
  if (account.scope !== 'account') fail('environment.accountUsage.scope is invalid')
  if (account.completeness !== 'provider-reported-possibly-defaulted')
    fail('environment.accountUsage.completeness is invalid')
  for (const [name, value] of [
    ['customerId', account.customerId],
    ['billingOwnerId', account.billingOwnerId],
    ['plan', account.plan],
    ['subscriptionStatus', account.subscriptionStatus],
  ] as const) {
    if (value !== undefined) nonEmpty(value, `environment.accountUsage.${name}`)
  }
  for (const [name, value] of [
    ['computeMinutes', account.computeMinutes],
    ['gpuSeconds', account.gpuSeconds],
    ['gpuCostUsd', account.gpuCostUsd],
    ['activeSandboxes', account.activeSandboxes],
    ['totalSandboxes', account.totalSandboxes],
    ['creditsUsedUsd', account.creditsUsedUsd],
    ['monthlyBalanceUsd', account.monthlyBalanceUsd],
    ['maximumConcurrentSandboxes', account.maximumConcurrentSandboxes],
    ['maximumCpuCores', account.maximumCpuCores],
    ['maximumRamGB', account.maximumRamGB],
    ['maximumStorageGB', account.maximumStorageGB],
  ] as const) {
    if (value !== undefined) finiteNonNegative(value, `environment.accountUsage.${name}`)
  }
  if (account.creditsAvailableUsd !== undefined && !Number.isFinite(account.creditsAvailableUsd))
    fail('environment.accountUsage.creditsAvailableUsd must be finite')
  for (const [name, value] of [
    ['usagePeriodStart', account.usagePeriodStart],
    ['usagePeriodEnd', account.usagePeriodEnd],
    ['subscriptionPeriodEnd', account.subscriptionPeriodEnd],
    ['sampledAt', account.sampledAt],
  ] as const) {
    if (value !== undefined) assertDate(value, `environment.accountUsage.${name}`)
  }
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
  nonEmpty(record.runtimeId, 'supervisor.runtimeId')
  if (record.runtimeId.length > 1_024) fail('supervisor.runtimeId is too long')
  nonEmpty(record.runtimeRoot, 'supervisor.runtimeRoot')
  if (record.rootRunId !== undefined)
    assertEntityId('run', record.rootRunId, 'supervisor.rootRunId')
  if (record.title !== undefined) nonEmpty(record.title, 'supervisor.title')
  if (record.driverModel !== undefined) nonEmpty(record.driverModel, 'supervisor.driverModel')
  if (record.workerModel !== undefined) nonEmpty(record.workerModel, 'supervisor.workerModel')
  if (record.driverUsage !== undefined)
    assertRuntimeUsage(record.driverUsage, 'supervisor.driverUsage')
  if (record.totalUsage !== undefined)
    assertRuntimeUsage(record.totalUsage, 'supervisor.totalUsage')
  if (record.workerCount !== undefined)
    finiteNonNegative(record.workerCount, 'supervisor.workerCount')
  assertDate(record.createdAt, 'supervisor.createdAt')
  assertDate(record.updatedAt, 'supervisor.updatedAt')
}

export function assertWorkerRecord(record: WorkerRecord): void {
  assertEntityId('worker', record.id, 'worker.id')
  nonEmpty(record.runtimeId, 'worker.runtimeId')
  if (record.runtimeId.length > 1_024) fail('worker.runtimeId is too long')
  assertEntityId('supervisor', record.supervisorId, 'worker.supervisorId')
  if (record.parentRuntimeRef !== undefined) {
    nonEmpty(record.parentRuntimeRef, 'worker.parentRuntimeRef')
    if (record.parentRuntimeRef.length > 1_024) fail('worker.parentRuntimeRef is too long')
  }
  if (record.parentWorkerId !== undefined)
    assertEntityId('worker', record.parentWorkerId, 'worker.parentWorkerId')
  if (record.runId !== undefined) assertEntityId('run', record.runId, 'worker.runId')
  if (record.title !== undefined) nonEmpty(record.title, 'worker.title')
  if (record.runner !== undefined) nonEmpty(record.runner, 'worker.runner')
  for (const [name, value] of [
    ['spendUsd', record.spendUsd],
    ['inputTokens', record.inputTokens],
    ['outputTokens', record.outputTokens],
    ['latencyMs', record.latencyMs],
  ] as const) {
    if (value !== undefined) finiteNonNegative(value, `worker.${name}`)
  }
  if (
    record.usageCompleteness !== undefined &&
    !['complete', 'observed-floor', 'unknown'].includes(record.usageCompleteness)
  ) {
    fail('worker.usageCompleteness is invalid')
  }
  assertDate(record.createdAt, 'worker.createdAt')
  assertDate(record.updatedAt, 'worker.updatedAt')
}

function assertRuntimeUsage(
  usage: NonNullable<SupervisorRecord['totalUsage']>,
  label: string,
): void {
  finiteNonNegative(usage.inputTokens, `${label}.inputTokens`)
  finiteNonNegative(usage.outputTokens, `${label}.outputTokens`)
  finiteNonNegative(usage.spendUsd, `${label}.spendUsd`)
  finiteNonNegative(usage.latencyMs, `${label}.latencyMs`)
  if (usage.iterations !== undefined) finiteNonNegative(usage.iterations, `${label}.iterations`)
  if (!['complete', 'observed-floor', 'unknown'].includes(usage.completeness)) {
    fail(`${label}.completeness is invalid`)
  }
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
  if (record.result !== undefined) assertJsonValue(record.result, 'operation.result')
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

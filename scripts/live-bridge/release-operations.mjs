import { profileForBridgeTarget } from './config.mjs'
import { exitCodes, livePrompts } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { RpcSession } from './process.mjs'
import {
  classifyPackedStartup,
  interactionFromResponse,
  requestBase,
  runFromState,
  terminalMessage,
} from './protocol.mjs'
import { evidenceValue } from './redaction.mjs'
import {
  assertContextTransfer,
  assertObservedUsage,
  assertRetainedInteraction,
  assertRetainedRestartProof,
  assertTargetRunIdentity,
  terminalReceipts as collectTerminalReceipts,
} from './release-proof-validation.mjs'
import { initializeTarget, runNormalTurn } from './target-actions.mjs'
import {
  admitOperationTurn,
  applyTargetReceipt,
  executeNamedOperation,
  operationRequest,
  operationState,
  providerSessionId,
  sendOperationRequest,
  terminalOperationState,
} from './target-flow.mjs'

export async function executeCrossRunnerHandoff(
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  sourceTarget,
  destinationTarget,
  token,
  timeoutMs,
) {
  if (sourceTarget === undefined) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_SOURCE_TARGET_UNAVAILABLE',
      'The Codex handoff requires an advertised Pi source target',
      exitCodes.unavailable,
    )
  }
  if (destinationTarget === undefined) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_DESTINATION_TARGET_UNAVAILABLE',
      'The Codex handoff requires an advertised Codex destination target',
      exitCodes.unavailable,
    )
  }
  if (
    sourceTarget.definition.backend !== 'pi' ||
    destinationTarget.definition.backend !== 'codex'
  ) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_HANDOFF_TARGET_INVALID',
      'The Codex handoff requires a Pi source and Codex destination target',
      exitCodes.failed,
      {
        source: sourceTarget.definition.backend,
        destination: destinationTarget.definition.backend,
      },
    )
  }
  const operation = 'cli-bridge.codex.cross-runner-handoff'
  const operationPrefix = 'codex-cross-runner-handoff'
  return await executeNamedOperation({
    binary,
    installRoot,
    root,
    endpoint,
    providerCapabilities,
    target: sourceTarget,
    token,
    timeoutMs,
    operation,
    operationPrefix,
    execute: async ({ result, config, getSession }) => {
      const session = getSession()
      const sourceTurn = await runNormalTurn(session, result, sourceTarget, timeoutMs, {
        operationPrefix: `${operationPrefix}-source`,
        prompt: livePrompts.handoffSource(sourceTarget.key),
        marker: 'LIVE_BRAID_PI_HANDOFF_SOURCE_OK',
      })
      const sourceMessage = terminalMessage(sourceTurn.terminal.state, sourceTurn.runId)
      if (typeof sourceMessage?.id !== 'string') {
        throw new LiveBridgeError(
          'LIVE_RELEASE_HANDOFF_BOUNDARY_MISSING',
          'The Pi handoff did not retain an exact source message boundary',
          exitCodes.failed,
          { runId: sourceTurn.runId },
        )
      }
      const sourceProof = assertTargetRunIdentity(sourceTurn.finalRun, sourceTarget)
      const sourceUsage = assertObservedUsage(sourceTurn.finalRun)
      const destinationProfile = profileForBridgeTarget(destinationTarget)
      const forkParams = {
        conversationId: result.conversationId,
        branchId: result.branchId,
        messageId: sourceMessage.id,
        workspace: false,
        runner: destinationTarget.definition.backend,
        model: destinationProfile.model.default,
        effort: 'none',
      }
      const forkOperationId = `op-${operationPrefix}-fork-${sourceTarget.key}-${destinationTarget.key}`
      const planRequest = {
        ...requestBase(
          `${operationPrefix}-plan-${sourceTarget.key}-${destinationTarget.key}`,
          'plan_fork',
          forkOperationId,
        ),
        params: forkParams,
      }
      const planResponse = await sendOperationRequest(
        session,
        result,
        planRequest,
        'cross-runner fork plan',
        timeoutMs,
      )
      const plan = planResponse.type === 'ack' ? planResponse.result : undefined
      if (
        planResponse.type === 'error' ||
        plan?.allowed !== true ||
        plan.providerSession !== 'new' ||
        typeof plan.digest !== 'string' ||
        typeof plan.destinationBranchId !== 'string' ||
        !Array.isArray(plan.context?.messages) ||
        plan.throughMessageId !== sourceMessage.id ||
        plan.context?.sourceRunId !== sourceTurn.runId ||
        plan.context?.sourceBoundary !== sourceMessage.id ||
        typeof plan.context?.digest !== 'string'
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_HANDOFF_PLAN_INVALID',
          'The named cross-runner handoff did not produce an allowed new-session plan',
          planResponse.type === 'error' && planResponse.code === 'CAPABILITY_UNAVAILABLE'
            ? exitCodes.unavailable
            : exitCodes.failed,
          { response: planResponse },
        )
      }
      const executeRequest = {
        ...requestBase(
          `${operationPrefix}-execute-${sourceTarget.key}-${destinationTarget.key}`,
          'execute_fork',
          forkOperationId,
        ),
        params: { ...forkParams, planDigest: plan.digest },
      }
      const executeResponse = await sendOperationRequest(
        session,
        result,
        executeRequest,
        'cross-runner fork execution',
        timeoutMs,
      )
      const branch = executeResponse.type === 'ack' ? executeResponse.result : undefined
      if (executeResponse.type === 'error' || branch?.id !== plan.destinationBranchId) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_HANDOFF_EXECUTION_INVALID',
          'The named cross-runner handoff did not create the planned destination branch',
          executeResponse.type === 'error' && executeResponse.code === 'CAPABILITY_UNAVAILABLE'
            ? exitCodes.unavailable
            : exitCodes.failed,
          { response: executeResponse, destinationBranchId: plan.destinationBranchId },
        )
      }
      const sourceRun = sourceTurn.finalRun
      const sourceSessionId = providerSessionId(sourceRun)
      if (typeof sourceSessionId !== 'string' || sourceSessionId.length === 0) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_SOURCE_RECEIPT_INVALID',
          'The Pi source run did not retain its runner and provider session receipt',
          exitCodes.failed,
          { run: sourceRun, proof: sourceProof },
        )
      }
      result.sourceProfile = evidenceValue(result.profile)
      result.sourceRunId = sourceTurn.runId
      result.branchId = plan.destinationBranchId
      applyTargetReceipt(result, config, destinationTarget)
      const destinationTurn = await runNormalTurn(session, result, destinationTarget, timeoutMs, {
        operationPrefix: `${operationPrefix}-destination`,
        prompt: livePrompts.handoffDestination(destinationTarget.key),
        marker: 'LIVE_BRAID_CODEX_HANDOFF_OK',
      })
      const destinationSessionId = providerSessionId(destinationTurn.finalRun)
      if (
        typeof destinationSessionId !== 'string' ||
        destinationSessionId.length === 0 ||
        destinationSessionId === sourceSessionId
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_DESTINATION_RECEIPT_INVALID',
          'The Codex destination run did not prove a distinct runner and provider session',
          exitCodes.failed,
          { run: destinationTurn.finalRun, sourceSessionId },
        )
      }
      const destinationProof = assertTargetRunIdentity(destinationTurn.finalRun, destinationTarget)
      const destinationUsage = assertObservedUsage(destinationTurn.finalRun)
      const transfer = assertContextTransfer({
        sourceRunId: sourceTurn.runId,
        sourceMessageId: sourceMessage.id,
        plan,
        destinationRun: destinationTurn.finalRun,
      })
      return {
        runId: destinationTurn.runId,
        runIds: [sourceTurn.runId, destinationTurn.runId],
        targetProof: destinationProof,
        evidence: {
          sourceRunner: sourceProof.harness,
          destinationRunner: destinationProof.harness,
          sourceProvider: sourceProof.provider,
          destinationProvider: destinationProof.provider,
          sourceRun: evidenceValue(sourceRun),
          destinationRun: evidenceValue(destinationTurn.finalRun),
          sourceUsage,
          destinationUsage,
          sourceRunId: sourceTurn.runId,
          destinationRunId: destinationTurn.runId,
          sourceProviderSessionId: sourceSessionId,
          destinationProviderSessionId: destinationSessionId,
          sourceMessageId: sourceMessage.id,
          sourceBoundary: plan.context.sourceBoundary,
          destinationBranchId: plan.destinationBranchId,
          planDigest: plan.digest,
          contextPlanDigest: plan.context.digest,
          providerSession: plan.providerSession,
          transfer: evidenceValue(transfer),
          plan: evidenceValue(plan),
          execution: evidenceValue(branch),
        },
      }
    },
  })
}

export async function executeInteractiveProtocol(
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  target,
  token,
  timeoutMs,
) {
  if (target === undefined) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_INTERACTIVE_TARGET_UNAVAILABLE',
      'The interactive protocol requires an advertised runner target',
      exitCodes.unavailable,
    )
  }
  const operation = 'cli-bridge.interactive-protocol'
  const operationPrefix = 'interactive-protocol'
  return await executeNamedOperation({
    binary,
    installRoot,
    root,
    endpoint,
    providerCapabilities,
    target,
    token,
    timeoutMs,
    operation,
    operationPrefix,
    execute: async ({ result, getSession }) => {
      const session = getSession()
      const started = await admitOperationTurn(
        session,
        result,
        target,
        operationPrefix,
        livePrompts.interactive(target.key),
        timeoutMs,
      )
      await operationState(session, result, operationPrefix, 'active', timeoutMs)
      const interactionResponse = await session.waitFor(
        'named interactive request',
        (response) => interactionFromResponse(response, started.runId) !== undefined,
        timeoutMs,
      )
      const interaction = interactionFromResponse(interactionResponse, started.runId)
      if (
        typeof interaction?.interactionId !== 'string' ||
        interaction.interactionId.length === 0
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_INTERACTION_INVALID',
          'The named interactive operation emitted no usable interaction identity',
          exitCodes.failed,
          { response: interactionResponse },
        )
      }
      const responseRequest = operationRequest(
        result,
        operationPrefix,
        'respond',
        'respond_interaction',
        {
          runId: started.runId,
          interactionId: interaction.interactionId,
          response: { id: interaction.interactionId, outcome: 'declined' },
        },
      )
      const responseAck = await sendOperationRequest(
        session,
        result,
        responseRequest,
        'named interaction response',
        timeoutMs,
      )
      if (responseAck.type !== 'ack') {
        throw new LiveBridgeError(
          'LIVE_RELEASE_INTERACTION_RESPONSE_FAILED',
          'The named interactive operation did not acknowledge its response',
          exitCodes.failed,
          { response: responseAck },
        )
      }
      const duplicateRequest = operationRequest(
        result,
        operationPrefix,
        'duplicate',
        'respond_interaction',
        responseRequest.params,
      )
      const duplicateResponse = await sendOperationRequest(
        session,
        result,
        duplicateRequest,
        'stale duplicate interaction response',
        timeoutMs,
      )
      const staleCodes = new Set([
        'INTERACTION_RESPONSE_IN_PROGRESS',
        'INTERACTION_RESPONSE_CONFLICT',
      ])
      if (duplicateResponse.type !== 'error' || !staleCodes.has(duplicateResponse.code)) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_INTERACTION_DUPLICATE_ACCEPTED',
          'The named interactive operation did not reject a stale duplicate response',
          exitCodes.failed,
          { response: duplicateResponse },
        )
      }
      const terminal = await terminalOperationState(
        session,
        result,
        operationPrefix,
        started.runId,
        timeoutMs,
      )
      const interactionState = terminal.run.interactions?.find(
        (item) => item.request.id === interaction.interactionId,
      )
      if (
        terminal.run.status === 'unknown' ||
        interactionState?.status === 'pending' ||
        interactionState?.status === 'responding'
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_INTERACTION_NOT_RESUMED',
          'The named interactive operation did not reach a known post-response state',
          exitCodes.failed,
          { run: terminal.run, interaction: interactionState },
        )
      }
      const targetProof = assertTargetRunIdentity(terminal.run, target)
      const usage = assertObservedUsage(terminal.run)
      const retainedInteraction = assertRetainedInteraction(
        terminal.run,
        interaction.interactionId,
        responseAck,
      )
      return {
        runId: started.runId,
        runIds: [started.runId],
        targetProof,
        evidence: {
          runId: started.runId,
          interactionId: interaction.interactionId,
          interaction: evidenceValue(interaction),
          response: evidenceValue(responseAck),
          staleDuplicate: evidenceValue(duplicateResponse),
          terminalRun: evidenceValue(terminal.run),
          interactionStatus: retainedInteraction.status,
          responseOutcome: retainedInteraction.responseOperation.outcome,
          usage,
        },
      }
    },
  })
}

export async function executeRestartReconciliation(
  binary,
  installRoot,
  root,
  endpoint,
  providerCapabilities,
  target,
  token,
  timeoutMs,
) {
  if (target === undefined) {
    throw new LiveBridgeError(
      'LIVE_RELEASE_RESTART_TARGET_UNAVAILABLE',
      'Restart reconciliation requires an advertised runner target',
      exitCodes.unavailable,
    )
  }
  const operation = 'cli-bridge.restart-reconciliation'
  const operationPrefix = 'restart-reconciliation'
  return await executeNamedOperation({
    binary,
    installRoot,
    root,
    endpoint,
    providerCapabilities,
    target,
    token,
    timeoutMs,
    operation,
    operationPrefix,
    execute: async ({ result, config, env, setSession, getSession }) => {
      const started = await admitOperationTurn(
        getSession(),
        result,
        target,
        operationPrefix,
        livePrompts.restart(target.key),
        timeoutMs,
      )
      const activeState = await operationState(
        getSession(),
        result,
        operationPrefix,
        'before-restart',
        timeoutMs,
      )
      const activeRun = runFromState(activeState.state, started.runId)
      const admissionResponseIndex = getSession().responses.indexOf(started.response)
      if (
        activeState.state?.activeRunId !== started.runId ||
        !['running', 'waiting', 'streaming'].includes(activeRun?.status)
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_NOT_ACTIVE',
          'The named restart operation did not create an active run before the forced restart',
          exitCodes.failed,
          { run: activeRun, state: activeState },
        )
      }
      const activeStream = await getSession().waitFor(
        'restart operation streamed active run event',
        (response) =>
          response.type === 'event' &&
          response.event?.runId === started.runId &&
          getSession().responses.indexOf(response) > admissionResponseIndex &&
          [
            'run.text.delta',
            'run.part.updated',
            'run.reasoning.delta',
            'run.tool.call',
            'run.tool.result',
            'run.artifact',
            'run.proposal',
            'run.interaction',
          ].includes(response.event.kind) &&
          Number.isSafeInteger(response.event?.provider?.providerSequence) &&
          response.event.provider.providerSequence > 0,
        timeoutMs,
      )
      const streamedState = await operationState(
        getSession(),
        result,
        operationPrefix,
        'streamed',
        timeoutMs,
      )
      const streamedRun = runFromState(streamedState.state, started.runId)
      const activeStateResponseIndex = getSession().responses.indexOf(activeState)
      const activeStreamResponseIndex = getSession().responses.indexOf(activeStream)
      const activeModel = {
        admission: {
          runId: started.runId,
          requestId: started.send.requestId,
          operationId: started.send.operationId,
          responseIndex: admissionResponseIndex,
          revision: started.response.revision,
        },
        state: {
          runId: started.runId,
          activeRunId: activeState.state?.activeRunId ?? null,
          status: activeRun?.status ?? null,
          responseIndex: activeStateResponseIndex,
          revision: activeState.revision,
        },
        progress: {
          runId: started.runId,
          kind: activeStream.event.kind,
          responseIndex: activeStreamResponseIndex,
          sequence: activeStream.sequence,
          revision: activeStream.revision,
          providerSequence: activeStream.event.provider.providerSequence,
          cursor: activeStream.event.provider.cursor ?? null,
        },
      }
      const savedCursor = streamedRun?.lastCursor
      const savedProviderSequence = streamedRun?.lastProviderSequence
      const detachRequest = operationRequest(result, operationPrefix, 'detach', 'detach', {
        runId: started.runId,
      })
      const detachResponse = await sendOperationRequest(
        getSession(),
        result,
        detachRequest,
        'restart operation detach acknowledgement',
        timeoutMs,
      )
      if (
        detachResponse.type !== 'ack' ||
        !['accepted', 'already-applied'].includes(detachResponse.outcome)
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_DETACH_FAILED',
          'The restart operation did not acknowledge detaching the active run',
          exitCodes.failed,
          { response: detachResponse },
        )
      }
      const detachedEvent = await getSession().waitFor(
        'restart operation detached event',
        (response) =>
          response.type === 'event' &&
          response.event?.kind === 'run.detached' &&
          response.event?.runId === started.runId,
        timeoutMs,
      )
      const detachedState = await operationState(
        getSession(),
        result,
        operationPrefix,
        'detached',
        timeoutMs,
      )
      const detachedRun = runFromState(detachedState.state, started.runId)
      const conversationId = result.conversationId
      const branchId = result.branchId
      const oldSession = getSession()
      const oldProcess = oldSession.processIdentity
      const forcedProcess = await oldSession.forceStop()
      const requestCountBeforeRestart = result.requests.length
      setSession(undefined)
      const restarted = await RpcSession.create(binary, config.workspace, env, timeoutMs)
      setSession(restarted)
      const newProcess = restarted.processIdentity
      await initializeTarget(restarted, result, classifyPackedStartup, {
        operationPrefix: `${operationPrefix}-reopened`,
      })
      const reopenedState = await operationState(
        restarted,
        result,
        operationPrefix,
        'reopened',
        timeoutMs,
      )
      if (runFromState(reopenedState.state, started.runId) === undefined) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_RUN_MISSING',
          'The forced restart did not retain the original run identity',
          exitCodes.failed,
          { runId: started.runId, state: reopenedState },
        )
      }
      if (result.conversationId !== conversationId || result.branchId !== branchId) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_STATE_CHANGED',
          'The forced restart reopened a different Braid conversation or branch',
          exitCodes.failed,
          {
            before: { conversationId, branchId },
            after: { conversationId: result.conversationId, branchId: result.branchId },
          },
        )
      }
      const reopenedRun = runFromState(reopenedState.state, started.runId)
      const responseCountBeforeReconnect = restarted.responses.length
      const reconnectRequest = operationRequest(result, operationPrefix, 'reconnect', 'reconnect', {
        runId: started.runId,
      })
      const reconnectResponse = await sendOperationRequest(
        restarted,
        result,
        reconnectRequest,
        'restart reconnection acknowledgement',
        timeoutMs,
      )
      const reconnectBoundaryResponse = await restarted.waitFor(
        'restart reconnecting boundary',
        (response) =>
          restarted.responses.indexOf(response) >= responseCountBeforeReconnect &&
          response.type === 'event' &&
          response.event?.kind === 'run.reconnecting' &&
          response.event?.runId === started.runId &&
          Number.isSafeInteger(response.sequence) &&
          response.sequence > 0 &&
          Number.isSafeInteger(response.revision) &&
          response.revision > 0,
        timeoutMs,
      )
      const reconnectBoundaryResponseIndex = restarted.responses.indexOf(reconnectBoundaryResponse)
      const replayEvent = await restarted.waitFor(
        'restart replayed post-cursor event',
        (response) =>
          restarted.responses.indexOf(response) > reconnectBoundaryResponseIndex &&
          response.type === 'event' &&
          response.event?.runId === started.runId &&
          response.event?.kind !== 'run.reconnecting' &&
          Number.isSafeInteger(response.sequence) &&
          response.sequence > reconnectBoundaryResponse.sequence &&
          Number.isSafeInteger(response.revision) &&
          response.revision > reconnectBoundaryResponse.revision &&
          Number.isSafeInteger(response.event?.provider?.providerSequence) &&
          Number.isSafeInteger(savedProviderSequence) &&
          savedProviderSequence > 0 &&
          response.event.provider.providerSequence === savedProviderSequence + 1 &&
          response.sequence <= reconnectResponse.revision &&
          response.revision <= reconnectResponse.revision,
        timeoutMs,
      )
      const terminal = await terminalOperationState(
        restarted,
        result,
        operationPrefix,
        started.runId,
        timeoutMs,
      )
      const postRestartRequests = result.requests.slice(requestCountBeforeRestart)
      if (postRestartRequests.some((request) => ['send', 'queue'].includes(request.command))) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_RESUBMITTED',
          'The restart operation sent new work instead of reconciling the original run',
          exitCodes.failed,
          { requests: postRestartRequests },
        )
      }
      const terminalReceipts = [
        ...collectTerminalReceipts(oldSession.responses, oldProcess.instanceId, started.runId),
        ...collectTerminalReceipts(restarted.responses, newProcess.instanceId, started.runId),
      ]
      const restartProof = assertRetainedRestartProof({
        runId: started.runId,
        savedCursor,
        savedProviderSequence,
        beforeDetach: streamedRun,
        detached: detachedRun,
        reopened: reopenedRun,
        final: terminal.run,
        oldProcess,
        newProcess,
        forcedProcess,
        activeModel,
        reopenedRevision: reopenedState.revision,
        reconnectRequest,
        reconnectResponse,
        reconnectBoundary: {
          runId: reconnectBoundaryResponse.event.runId,
          kind: reconnectBoundaryResponse.event.kind,
          responseIndex: reconnectBoundaryResponseIndex,
          sequence: reconnectBoundaryResponse.sequence,
          revision: reconnectBoundaryResponse.revision,
          savedCursor: reconnectBoundaryResponse.event.after ?? null,
        },
        replayEvent: {
          event: replayEvent.event,
          kind: replayEvent.event.kind,
          responseIndex: restarted.responses.indexOf(replayEvent),
          sequence: replayEvent.sequence,
          revision: replayEvent.revision,
        },
        terminalReceipts,
        finalState: terminal.response,
        terminalSession: newProcess.instanceId,
      })
      const targetProof = assertTargetRunIdentity(terminal.run, target)
      const usage = assertObservedUsage(terminal.run)
      return {
        runId: started.runId,
        runIds: [started.runId],
        targetProof,
        evidence: {
          runId: started.runId,
          forcedProcess: evidenceValue(forcedProcess),
          oldProcess: evidenceValue(oldProcess),
          newProcess: evidenceValue(newProcess),
          activeModel: evidenceValue(activeModel),
          activeStream: evidenceValue(activeStream),
          streamedState: evidenceValue(streamedState),
          detachedEvent: evidenceValue(detachedEvent),
          detachedState: evidenceValue(detachedState),
          savedCursor,
          savedProviderSequence,
          reopenedState: evidenceValue(reopenedState),
          detach: evidenceValue(detachResponse),
          reconnect: evidenceValue(reconnectResponse),
          reconnectBoundary: evidenceValue(reconnectBoundaryResponse),
          replayEvent: evidenceValue(replayEvent),
          terminalReceipts: evidenceValue(terminalReceipts),
          finalState: evidenceValue(terminal.response),
          restartProof: evidenceValue(restartProof),
          usage,
          statePath: env.BRAID_STATE_PATH,
          endpoint: result.connection.endpoint,
          resubmitted: false,
        },
      }
    },
  })
}

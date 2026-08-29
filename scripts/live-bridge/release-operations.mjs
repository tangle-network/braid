import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { profileForBridgeTarget } from './config.mjs'
import { exitCodes, liveMarkers, livePrompts } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { RpcSession } from './process.mjs'
import {
  classifyPackedStartup,
  eventPayload,
  exactMarker,
  interactionFromResponse,
  requestBase,
  runEventPayload,
  runFromState,
  runWithAdmissionReceipt,
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
        marker: liveMarkers.handoffSource(sourceTarget.key),
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
      const destinationPrompt = livePrompts.handoffDestination(destinationTarget.key)
      const destinationMarker = liveMarkers.handoffDestination(destinationTarget.key)
      const forkParams = {
        conversationId: result.conversationId,
        branchId: result.branchId,
        messageId: sourceMessage.id,
        text: destinationPrompt,
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
      const portablePlan = plan?.portableContextPlan
      if (
        planResponse.type === 'error' ||
        plan?.allowed !== true ||
        plan.providerSession !== 'new' ||
        typeof plan.digest !== 'string' ||
        typeof portablePlan?.digest !== 'string' ||
        typeof portablePlan.requiresAcceptance !== 'boolean' ||
        typeof plan.destinationBranchId !== 'string' ||
        !Array.isArray(plan.context?.messages) ||
        plan.throughMessageId !== sourceMessage.id ||
        plan.context?.sourceRunId !== sourceTurn.runId ||
        plan.context?.sourceBoundary !== sourceMessage.id ||
        typeof plan.context?.digest !== 'string' ||
        portablePlan.source?.source?.runId !== sourceTurn.runId ||
        portablePlan.source?.source?.messageId !== sourceMessage.id
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
        params: {
          ...forkParams,
          planDigest: plan.digest,
          ...(portablePlan.requiresAcceptance === true
            ? { acceptedDigest: portablePlan.digest }
            : {}),
        },
      }
      const executeResponseStartIndex = session.responses.length
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
      const destinationAdmissionResponse = await session.waitFor(
        'cross-runner destination admission',
        (response) => {
          const payload = eventPayload(response)
          return (
            session.responses.indexOf(response) >= executeResponseStartIndex &&
            response?.event?.kind === 'run.requested' &&
            payload?.status === 'admitted' &&
            typeof payload.runId === 'string' &&
            payload.admission?.runId === payload.runId &&
            payload.admission?.branchId === plan.destinationBranchId
          )
        },
        timeoutMs,
      )
      const destinationAdmission = eventPayload(destinationAdmissionResponse)
      const destinationRunId = destinationAdmission.runId
      const destinationTerminal = await terminalOperationState(
        session,
        result,
        `${operationPrefix}-destination`,
        destinationRunId,
        timeoutMs,
      )
      const destinationRun = runWithAdmissionReceipt(
        destinationTerminal.run,
        destinationAdmission.admission,
      )
      const destinationMessage = terminalMessage(
        destinationTerminal.response.state,
        destinationRunId,
      )
      const destinationMarkerObserved = exactMarker(destinationMessage?.text, destinationMarker)
      if (
        destinationRun?.status !== 'completed' ||
        typeof destinationMessage?.text !== 'string' ||
        destinationMessage.text.trim() === '' ||
        !destinationMarkerObserved
      ) {
        throw new LiveBridgeError(
          destinationMarkerObserved ? 'LIVE_FINAL_OUTPUT_MISSING' : 'LIVE_FINAL_OUTPUT_MISMATCH',
          destinationMarkerObserved
            ? 'The cross-runner destination did not retain a completed assistant message'
            : 'The cross-runner destination completed without the expected response marker',
          exitCodes.failed,
          { run: destinationRun, assistant: destinationMessage },
        )
      }
      const destinationSessionId = providerSessionId(destinationRun)
      if (
        typeof destinationSessionId !== 'string' ||
        destinationSessionId.length === 0 ||
        destinationSessionId === sourceSessionId
      ) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_DESTINATION_RECEIPT_INVALID',
          'The Codex destination run did not prove a distinct runner and provider session',
          exitCodes.failed,
          { run: destinationRun, sourceSessionId },
        )
      }
      const destinationProof = assertTargetRunIdentity(destinationRun, destinationTarget)
      const destinationUsage = assertObservedUsage(destinationRun)
      const transfer = assertContextTransfer({
        sourceRunId: sourceTurn.runId,
        sourceMessageId: sourceMessage.id,
        plan,
        destinationRun,
      })
      return {
        runId: destinationRunId,
        runIds: [sourceTurn.runId, destinationRunId],
        targetProof: destinationProof,
        evidence: {
          sourceRunner: sourceProof.harness,
          destinationRunner: destinationProof.harness,
          sourceProvider: sourceProof.provider,
          destinationProvider: destinationProof.provider,
          sourceRun: evidenceValue(sourceRun),
          destinationRun: evidenceValue(destinationRun),
          sourceUsage,
          destinationUsage,
          sourceRunId: sourceTurn.runId,
          destinationRunId,
          sourceProviderSessionId: sourceSessionId,
          destinationProviderSessionId: destinationSessionId,
          sourceMessageId: sourceMessage.id,
          sourceBoundary: plan.context.sourceBoundary,
          destinationBranchId: plan.destinationBranchId,
          planDigest: plan.digest,
          contextPlanDigest: plan.context.digest,
          providerSession: plan.providerSession,
          acceptance:
            portablePlan.requiresAcceptance === true
              ? { required: true, acceptedDigest: portablePlan.digest }
              : { required: false },
          transfer: evidenceValue(transfer),
          plan: evidenceValue(plan),
          execution: evidenceValue(branch),
          destinationAdmission: evidenceValue(destinationAdmissionResponse),
          destinationPrompt,
          destinationMarker,
          destinationMarkerObserved,
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
    execute: async ({ result, config, getSession }) => {
      const session = getSession()
      await writeFile(
        join(config.workspace, `interaction-proof-${target.key}.txt`),
        `${liveMarkers.interactive(target.key)}\n`,
        { mode: 0o600 },
      )
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
      const interactionPayload = runEventPayload(interactionResponse, started.runId)
      if (
        typeof interaction?.interactionId !== 'string' ||
        interaction.interactionId.length === 0 ||
        !Number.isSafeInteger(interactionPayload?.source?.providerSequence)
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
        'INTERACTION_STALE',
      ])
      if (duplicateResponse.type !== 'error' || !staleCodes.has(duplicateResponse.code)) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_INTERACTION_DUPLICATE_ACCEPTED',
          'The named interactive operation did not reject a stale duplicate response',
          exitCodes.failed,
          { response: duplicateResponse },
        )
      }
      const responseIndex = session.responses.indexOf(responseAck)
      const providerProgress = await session.waitFor(
        'post-response provider progress',
        (response) => {
          const payload = runEventPayload(response, started.runId)
          return (
            session.responses.indexOf(response) > responseIndex &&
            Number.isSafeInteger(payload?.source?.providerSequence) &&
            payload.source.providerSequence > interactionPayload.source.providerSequence
          )
        },
        timeoutMs,
      )
      const providerProgressPayload = runEventPayload(providerProgress, started.runId)
      const postResponseState = await operationState(
        session,
        result,
        operationPrefix,
        'post-response',
        timeoutMs,
      )
      const postResponseRun = runFromState(postResponseState.state, started.runId)
      let cleanupCancel
      if (['running', 'waiting', 'streaming', 'reconnecting'].includes(postResponseRun?.status)) {
        const cancelRequest = operationRequest(
          result,
          operationPrefix,
          'cleanup-cancel',
          'cancel_run',
          {
            runId: started.runId,
            reason: 'live interactive proof completed',
          },
        )
        cleanupCancel = await sendOperationRequest(
          session,
          result,
          cancelRequest,
          'interactive proof cleanup cancellation',
          timeoutMs,
        )
        if (cleanupCancel.type !== 'ack') {
          throw new LiveBridgeError(
            'LIVE_RELEASE_INTERACTION_CLEANUP_FAILED',
            'The named interactive operation did not acknowledge cleanup cancellation',
            exitCodes.failed,
            { response: cleanupCancel },
          )
        }
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
      const verifiedRun = runWithAdmissionReceipt(terminal.run, started.response.admission)
      const targetProof = assertTargetRunIdentity(verifiedRun, target)
      const retainedInteraction = assertRetainedInteraction(
        session.responses,
        started.runId,
        interaction.interactionId,
        responseRequest.operationId,
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
          providerProgress: evidenceValue({
            kind: providerProgress.event.kind,
            sequence: providerProgress.sequence,
            revision: providerProgress.revision,
            providerSequence: providerProgressPayload.source.providerSequence,
            cursor: providerProgressPayload.source.cursor ?? null,
          }),
          postResponseStatus: postResponseRun?.status ?? null,
          ...(cleanupCancel === undefined ? {} : { cleanupCancel: evidenceValue(cleanupCancel) }),
          terminalRun: evidenceValue(verifiedRun),
          interactionStatus: retainedInteraction.status,
          responseOutcome: retainedInteraction.responseOperation.outcome,
          usage: evidenceValue({
            terminalStatus: verifiedRun.status,
            input: verifiedRun.inputTokens,
            output: verifiedRun.outputTokens,
            tokenStatus: verifiedRun.tokenStatus,
            costStatus: verifiedRun.costStatus,
            settled: false,
            reason: 'The interactive proof cancels after provider progress',
          }),
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
        (response) => {
          const payload = runEventPayload(response, started.runId)
          return (
            payload !== undefined &&
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
            Number.isSafeInteger(payload.source?.providerSequence) &&
            payload.source.providerSequence > 0
          )
        },
        timeoutMs,
      )
      const activeStreamPayload = runEventPayload(activeStream, started.runId)
      const streamedState = await operationState(
        getSession(),
        result,
        operationPrefix,
        'streamed',
        timeoutMs,
      )
      const streamedRun = runFromState(streamedState.state, started.runId)
      if (!['running', 'waiting', 'streaming'].includes(streamedRun?.status)) {
        throw new LiveBridgeError(
          'LIVE_RELEASE_RESTART_STREAM_ENDED',
          'The selected run reached a terminal state before Braid could disconnect',
          exitCodes.failed,
          {
            run: streamedRun,
            progress: {
              kind: activeStream.event.kind,
              sequence: activeStream.sequence,
              revision: activeStream.revision,
              providerSequence: activeStreamPayload.source.providerSequence,
              cursor: activeStreamPayload.source.cursor ?? null,
            },
          },
        )
      }
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
          providerSequence: activeStreamPayload.source.providerSequence,
          cursor: activeStreamPayload.source.cursor ?? null,
        },
      }
      const savedCursor = streamedRun?.cursor
      const savedCursorCommittedSequence = streamedRun?.cursorCommittedSequence
      const savedCursorResponse = getSession().responses.findLast((response) => {
        const payload = runEventPayload(response, started.runId)
        return (
          response.type === 'event' &&
          response.sequence === savedCursorCommittedSequence &&
          payload?.source?.cursor === savedCursor &&
          Number.isSafeInteger(payload.source.providerSequence)
        )
      })
      const savedCursorPayload = runEventPayload(savedCursorResponse, started.runId)
      const savedProviderSequence = savedCursorPayload?.source?.providerSequence
      const savedCursorBoundary = {
        runId: started.runId,
        kind: savedCursorResponse?.event?.kind,
        responseIndex: getSession().responses.indexOf(savedCursorResponse),
        sequence: savedCursorResponse?.sequence,
        revision: savedCursorResponse?.revision,
        cursor: savedCursorPayload?.source?.cursor,
        providerSequence: savedProviderSequence,
      }
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
          runEventPayload(response, started.runId) !== undefined,
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
          runEventPayload(response, started.runId) !== undefined &&
          Number.isSafeInteger(response.sequence) &&
          response.sequence > 0 &&
          Number.isSafeInteger(response.revision) &&
          response.revision > 0,
        timeoutMs,
      )
      const reconnectBoundaryResponseIndex = restarted.responses.indexOf(reconnectBoundaryResponse)
      const reconnectBoundaryPayload = runEventPayload(reconnectBoundaryResponse, started.runId)
      let replayEvent
      try {
        replayEvent = await restarted.waitFor(
          'restart replayed post-cursor event',
          (response) => {
            const payload = runEventPayload(response, started.runId)
            return (
              restarted.responses.indexOf(response) > reconnectBoundaryResponseIndex &&
              payload !== undefined &&
              response.event?.kind !== 'run.reconnecting' &&
              Number.isSafeInteger(response.sequence) &&
              response.sequence > reconnectBoundaryResponse.sequence &&
              Number.isSafeInteger(response.revision) &&
              response.revision > reconnectBoundaryResponse.revision &&
              Number.isSafeInteger(payload.source?.providerSequence) &&
              Number.isSafeInteger(savedProviderSequence) &&
              savedProviderSequence > 0 &&
              payload.source.providerSequence > savedProviderSequence &&
              response.sequence <= reconnectResponse.revision &&
              response.revision <= reconnectResponse.revision
            )
          },
          timeoutMs,
        )
      } catch (error) {
        const postReconnectResponses = restarted.responses
          .slice(responseCountBeforeReconnect)
          .map((response, responseOffset) => {
            const payload = runEventPayload(response, started.runId)
            return {
              responseIndex: responseCountBeforeReconnect + responseOffset,
              type: response.type,
              ...(response.requestId === undefined ? {} : { requestId: response.requestId }),
              ...(response.sequence === undefined ? {} : { sequence: response.sequence }),
              ...(response.revision === undefined ? {} : { revision: response.revision }),
              ...(response.event?.kind === undefined ? {} : { kind: response.event.kind }),
              ...(payload === undefined
                ? {}
                : {
                    run: {
                      runId: payload.runId,
                      ...(payload.status === undefined ? {} : { status: payload.status }),
                      ...(payload.cursor === undefined ? {} : { cursor: payload.cursor }),
                      ...(payload.source?.providerSequence === undefined
                        ? {}
                        : { providerSequence: payload.source.providerSequence }),
                      ...(payload.source?.cursor === undefined
                        ? {}
                        : { providerCursor: payload.source.cursor }),
                    },
                  }),
              ...(response.type !== 'error'
                ? {}
                : { error: { code: response.code, message: response.message } }),
            }
          })
        const postReconnect = {
          count: postReconnectResponses.length,
          first: postReconnectResponses.slice(0, 8),
          last: postReconnectResponses.slice(-8),
        }
        throw new LiveBridgeError(
          'LIVE_RELEASE_REPLAY_TIMEOUT',
          'The restart operation did not retain a provider event after its saved cursor',
          exitCodes.failed,
          {
            cause:
              error instanceof LiveBridgeError
                ? { code: error.code, message: error.message, details: error.details }
                : { message: error instanceof Error ? error.message : String(error) },
            savedCursor,
            savedProviderSequence,
            reopenedRun,
            reconnectResponse,
            reconnectBoundary: reconnectBoundaryResponse,
            postReconnect,
          },
        )
      }
      const replayPayload = runEventPayload(replayEvent, started.runId)
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
        savedCursorBoundary,
        reopenedRevision: reopenedState.revision,
        reconnectRequest,
        reconnectResponse,
        reconnectBoundary: {
          runId: reconnectBoundaryPayload.runId,
          kind: reconnectBoundaryResponse.event.kind,
          responseIndex: reconnectBoundaryResponseIndex,
          sequence: reconnectBoundaryResponse.sequence,
          revision: reconnectBoundaryResponse.revision,
          savedCursor: reconnectBoundaryPayload.cursor ?? null,
        },
        replayEvent: {
          event: replayPayload,
          kind: replayEvent.event.kind,
          responseIndex: restarted.responses.indexOf(replayEvent),
          sequence: replayEvent.sequence,
          revision: replayEvent.revision,
        },
        terminalReceipts,
        finalState: terminal.response,
        terminalSession: newProcess.instanceId,
      })
      const verifiedRun = runWithAdmissionReceipt(terminal.run, started.response.admission)
      const targetProof = assertTargetRunIdentity(verifiedRun, target)
      const usage = assertObservedUsage(verifiedRun)
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
          savedCursorBoundary: evidenceValue(savedCursorBoundary),
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

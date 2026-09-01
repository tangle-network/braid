import { redactSensitiveText } from '../domain/redaction.js'
import type { BraidState } from '../domain/state.js'
import { operationId } from './application-guards.js'
import type { CancelInput, CancelReceipt } from './application-options.js'
import type { ControlReceipt } from './application-types.js'
import { AppError } from './errors.js'
import { cancelRequestDigest, DEFAULT_CANCEL_REASON } from './operation-ledger.js'
import type { RunLedger } from './run-ledger.js'
import { isTerminal } from './run-status.js'

export interface LegacyCancelHost {
  readonly state: () => BraidState
  readonly snapshot: () => BraidState
  readonly ledger: Pick<RunLedger, 'getControl'>
  readonly cancelRun: (input: {
    readonly operationId: string
    readonly runId: string
    readonly reason: string
    readonly terminalStatus: 'aborted'
    readonly legacy: true
  }) => Promise<ControlReceipt>
}

/** Compatibility surface for callers that expect a synchronous cancel receipt. */
export function legacyCancel(host: LegacyCancelHost, input: CancelInput): CancelReceipt {
  const opId = operationId(input.operationId, 'cancel')
  const state = host.state()
  const previous = host.ledger.getControl(opId)
  const runId = input.runId ?? state.activeRunId ?? previous?.runId
  if (!runId) throw new AppError('UNKNOWN_RUN', 'There is no run to cancel')
  const run = state.runs.find((candidate) => candidate.id === runId)
  const reason = redactSensitiveText(input.reason ?? DEFAULT_CANCEL_REASON)
  const digest = cancelRequestDigest(runId, reason, run?.providerSessionId)

  if (previous) {
    if (previous.digest !== digest) {
      throw new AppError(
        'OPERATION_CONFLICT',
        `Operation ${opId} was already used with different input`,
      )
    }
    return {
      operationId: opId,
      runId,
      revision: state.revision,
      replayed: true,
      completion: previous.completion.then(host.snapshot),
    }
  }

  if (!run || isTerminal(run.status)) {
    throw new AppError('UNKNOWN_RUN', `Run ${runId} is not active`)
  }
  const completion = host
    .cancelRun({
      operationId: opId,
      runId,
      reason,
      terminalStatus: 'aborted',
      legacy: true,
    })
    .then((receipt) => receipt.completion)
    .then(host.snapshot)
  return {
    operationId: opId,
    runId,
    revision: state.revision,
    replayed: false,
    completion,
  }
}

import type { BraidApplication } from '../../app/application.js'
import { AppError } from '../../app/errors.js'
import {
  type RunTarget,
  resolveConversationTarget,
  resolveRunTarget,
} from '../../app/run-targets.js'
import type { BraidIntent } from '../../views/shared/intents.js'

type TargetCommand = 'send' | 'queue' | 'steer' | 'cancel' | 'cancel_run' | 'detach'
interface TargetBinding {
  readonly command: TargetCommand
  readonly conversationId: string
  readonly branchId: string
  readonly runId?: string
}

// Only bridges dispatch/admission. Durable runs and control/queue records remain authoritative.
const admissions = new WeakMap<BraidApplication, Map<string, TargetBinding>>()
const MAX_PENDING_TARGETS = 1024

/** Pin before lazy dispatch imports, provider admission, or another focus command can run. */
export function bindRunIntent(app: BraidApplication, intent: BraidIntent): BraidIntent {
  if (
    intent.type !== 'send' &&
    intent.type !== 'queue' &&
    intent.type !== 'steer' &&
    intent.type !== 'cancel-run' &&
    intent.type !== 'headless-command'
  )
    return intent
  const command = targetCommand(intent)
  if (command === undefined) return intent
  const operationId = intent.operationId
  if (operationId === undefined || operationId.length === 0)
    throw new AppError('OPERATION_ID_REQUIRED', `${command} requires operationId`)
  const target: RunTarget = intent.type === 'headless-command' ? coordinates(intent.params) : intent
  const state = app.state()
  let pending = admissions.get(app)
  if (pending === undefined) {
    pending = new Map()
    admissions.set(app, pending)
  }
  const persisted = new Map<string, TargetBinding>()
  for (const run of state.runs)
    persisted.set(run.operationId, {
      command: 'send',
      conversationId: run.conversationId,
      branchId: run.branchId,
    })
  for (const envelope of app.events()) {
    const event = envelope.event
    if (event.kind !== 'run.queue.added' && event.kind !== 'run.control.requested') continue
    const run = state.runs.find((candidate) => candidate.id === event.runId)
    if (run === undefined) continue
    const kind = event.kind === 'run.queue.added' ? 'queue' : event.control
    if (kind !== 'queue' && kind !== 'steer' && kind !== 'cancel' && kind !== 'detach') continue
    persisted.set(event.operationId, {
      command: kind,
      runId: run.id,
      conversationId: run.conversationId,
      branchId: run.branchId,
    })
  }
  for (const id of persisted.keys()) pending.delete(id)
  const original = persisted.get(operationId) ?? pending.get(operationId)
  if (original !== undefined && controlKind(original.command) !== controlKind(command))
    throw new AppError('OPERATION_CONFLICT', 'The operation identifier belongs to another command')
  const run = command === 'send' ? undefined : resolveRunTarget(state, target, original?.runId)
  const resolved = run ?? resolveConversationTarget(state, target, original)
  const binding: TargetBinding = {
    command,
    conversationId: resolved.conversationId,
    branchId: resolved.branchId,
    ...(run === undefined ? {} : { runId: run.id }),
  }
  if (!persisted.has(operationId)) {
    if (!pending.has(operationId) && pending.size >= MAX_PENDING_TARGETS)
      throw new AppError(
        'PENDING_TARGET_LIMIT',
        'Too many unsettled operation targets; reconcile existing operations first',
      )
    pending.set(operationId, binding)
  }
  if (intent.type === 'headless-command') {
    return {
      ...intent,
      params: {
        ...intent.params,
        conversationId: binding.conversationId,
        branchId: binding.branchId,
        ...(binding.runId === undefined ? {} : { runId: binding.runId }),
      },
    }
  }
  if (intent.type === 'send')
    return { ...intent, conversationId: binding.conversationId, branchId: binding.branchId }
  if (intent.type === 'queue' || intent.type === 'steer' || intent.type === 'cancel-run')
    return { ...intent, ...(binding.runId === undefined ? {} : { runId: binding.runId }) }
  return intent
}

function controlKind(command: TargetCommand): string {
  return command === 'cancel_run' ? 'cancel' : command
}

function targetCommand(intent: BraidIntent): TargetCommand | undefined {
  if (intent.type === 'send' || intent.type === 'queue' || intent.type === 'steer')
    return intent.type
  if (intent.type === 'cancel-run') return 'cancel_run'
  if (intent.type !== 'headless-command') return undefined
  switch (intent.command) {
    case 'send':
    case 'queue':
    case 'steer':
    case 'cancel':
    case 'cancel_run':
    case 'detach':
      return intent.command
    default:
      return undefined
  }
}

function coordinates(params: Readonly<Record<string, unknown>>): RunTarget {
  const result: { runId?: string; conversationId?: string; branchId?: string } = {}
  for (const key of ['runId', 'conversationId', 'branchId'] as const) {
    if (params[key] === undefined) continue
    if (typeof params[key] !== 'string' || params[key].trim().length === 0)
      throw new AppError('INVALID_PARAMS', `${key} must be a non-empty string`)
    result[key] = params[key]
  }
  return result
}

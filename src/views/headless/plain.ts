import { AppError, type BraidApplication } from '../../app/application.js'
import { redactSensitiveText } from '../../domain/bounds.js'
import type { BraidEventEnvelope } from '../../domain/events.js'
import { linesOf, type RpcInput } from './rpc-lines.js'
import { parseRpcRequest } from './rpc-request.js'
import { OutputQueue, runRpc, type RpcOutput } from './rpc.js'

export async function runPlain(
  app: BraidApplication,
  input: RpcInput,
  output: RpcOutput,
  workspace: string,
  nextOperationId: () => string,
): Promise<number> {
  const iterator = linesOf(input)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (!first.done && isProtocolLine(first.value)) {
    return runRpc(app, prepend(first.value, iterator), output)
  }
  app.initialize(workspace)
  const writer = new OutputQueue(output)
  const unsubscribe = app.subscribe((_state, envelope) =>
    writer.enqueue(`${formatEvent(envelope)}\n`),
  )
  try {
    writer.enqueue(`braid ready · workspace ${redactSensitiveText(workspace)}\n`)
    await writer.flush()
    if (!first.done && !(await consumePlainLine(first.value, app, writer, nextOperationId)))
      return 0
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      if (!(await consumePlainLine(next.value, app, writer, nextOperationId))) break
    }
    await writer.flush()
    return 0
  } finally {
    unsubscribe()
    app.shutdown()
  }
}

async function consumePlainLine(
  line: string,
  app: BraidApplication,
  writer: OutputQueue,
  nextOperationId: () => string,
): Promise<boolean> {
  const text = line.trim()
  if (!text) return true
  if (text === '/quit' || text === '/exit') return false
  if (text.startsWith('/')) {
    writer.enqueue(`error: unsupported plain command ${redactSensitiveText(text)}\n`)
    await writer.flush()
    return true
  }
  try {
    const receipt = app.send({ operationId: nextOperationId(), text: line })
    await receipt.completion
    await writer.flush()
  } catch (error) {
    writer.enqueue(`${formatError(error)}\n`)
    await writer.flush()
  }
  return true
}

function isProtocolLine(line: string): boolean {
  try {
    parseRpcRequest(line)
    return true
  } catch {
    return false
  }
}

async function* prepend(first: string, iterator: AsyncIterator<string>): AsyncGenerator<string> {
  yield `${first}\n`
  while (true) {
    const next = await iterator.next()
    if (next.done) return
    yield `${next.value}\n`
  }
}

function formatEvent(envelope: BraidEventEnvelope): string {
  const event = envelope.event
  switch (event.kind) {
    case 'workspace.opened':
      return `workspace opened · ${redactSensitiveText(event.workspace)}`
    case 'draft.changed':
      return 'draft changed'
    case 'run.requested':
      return `run ${redactSensitiveText(event.runId)} started`
    case 'run.session.bound':
      return `run ${redactSensitiveText(event.runId)} session bound`
    case 'run.text.delta':
      return `assistant · ${redactSensitiveText(event.text)}`
    case 'run.finished':
      return `run ${redactSensitiveText(event.runId)} ${event.status}${
        event.finalText ? ` · ${redactSensitiveText(event.finalText)}` : ''
      }`
    case 'interaction.requested':
      return `interaction ${redactSensitiveText(event.interaction.interactionId)} waiting · ${redactSensitiveText(event.interaction.request.title)}`
    case 'interaction.response.requested':
      return `interaction ${redactSensitiveText(event.interactionId)} responding`
    case 'interaction.resolved':
      return `interaction ${redactSensitiveText(event.key)} ${event.status}`
    case 'automation.rule.created':
      return `automation rule ${redactSensitiveText(event.rule.id)} created`
    case 'automation.rule.updated':
      return `automation rule ${redactSensitiveText(event.rule.id)} updated`
    case 'automation.command.recorded':
      return `automation ${redactSensitiveText(event.operationId)} recorded`
    case 'automation.rule.disabled':
      return `automation rule ${redactSensitiveText(event.ruleId)} disabled`
    case 'automation.rule.deleted':
      return `automation rule ${redactSensitiveText(event.ruleId)} deleted`
    case 'automation.rule.used':
      return `automation rule ${redactSensitiveText(event.ruleId)} applied`
    case 'automation.rule.applied':
      return `automation rule ${redactSensitiveText(event.ruleId)} applied`
    case 'automation.audit.recorded':
      return `automation ${event.audit.outcome}`
    case 'feedback.decision.recorded':
      return `feedback ${event.decision.category} recorded`
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof AppError)
    return `error ${error.code} · ${redactSensitiveText(error.message)}`
  return `error INTERNAL_ERROR · ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`
}

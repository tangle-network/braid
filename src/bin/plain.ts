import { randomUUID } from 'node:crypto'
import type { BraidUiController, BraidIntent } from '../views/shared/intents.js'
import { isMutatingCommand, parseCommandInput } from '../views/shared/command-registry.js'
import { sanitizeNotification, sanitizeTerminalText } from '../views/shared/sanitize.js'

export interface PlainInput extends AsyncIterable<string | Uint8Array> {}

export interface PlainOutput {
  write(chunk: string): boolean
}

export interface PlainOptions {
  readonly initialIntents?: readonly BraidIntent[]
}

function nextOperationId(): string {
  return `op-plain-${Date.now().toString(36)}-${randomUUID()}`
}

function readablePayload(payload: Readonly<Record<string, unknown>>): string {
  const text = payload.text
  if (typeof text === 'string') return sanitizeNotification(text)
  const error = payload.error
  if (typeof error === 'string') return sanitizeNotification(error)
  return ''
}

export async function runPlain(
  controller: BraidUiController,
  workspace: string,
  input: PlainInput,
  output: PlainOutput,
  options: PlainOptions = {},
): Promise<number> {
  const initialized = await controller.initialize(workspace)
  if (initialized.kind !== 'accepted') {
    output.write(
      `error: ${sanitizeTerminalText(initialized.kind === 'unavailable' ? initialized.reason : initialized.message)}\n`,
    )
    return 2
  }
  output.write(`Braid ready — ${sanitizeTerminalText(workspace)}\n`)
  for (const intent of options.initialIntents ?? []) {
    const result = await controller.dispatch(intent)
    if (result.kind !== 'accepted') {
      output.write(
        `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
      )
    }
  }
  const unsubscribe = controller.subscribe((_view, event) => {
    if (!event) return
    const payload = readablePayload(event.payload)
    output.write(
      `[${event.sequence}] ${sanitizeTerminalText(event.kind)}${payload ? ` — ${payload}` : ''}\n`,
    )
  })
  const decoder = new TextDecoder()
  let buffered = ''
  let quitting = false
  const shutdownOperationId = 'op-plain-shutdown'
  const pendingCompletions = new Set<Promise<void>>()
  const trackCompletion = (completion: Promise<void>): void => {
    let tracked: Promise<void>
    tracked = completion.finally(() => pendingCompletions.delete(tracked))
    pendingCompletions.add(tracked)
  }
  const submit = async (line: string): Promise<void> => {
    const parsed = parseCommandInput(line)
    if (parsed.kind === 'invalid') {
      output.write(`error: ${sanitizeNotification(parsed.message)}\n`)
      return
    }
    if (parsed.kind === 'unknown') {
      output.write(
        `unknown command /${sanitizeNotification(parsed.name)}; choices: ${parsed.suggestions.map((name) => `/${name}`).join(', ') || 'none'}\n`,
      )
      return
    }
    if (parsed.kind === 'command') {
      if (parsed.name === 'quit') {
        const result = await controller.dispatch({
          type: 'shutdown',
          operationId: shutdownOperationId,
        })
        if (result.kind === 'accepted' && result.completion) await result.completion
        if (result.kind !== 'accepted')
          output.write(
            `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
          )
        if (result.kind === 'accepted' && result.completion) trackCompletion(result.completion)
        quitting = true
        return
      }
      const intent: BraidIntent = {
        type: 'run-command',
        command: parsed.name,
        args: parsed.args,
        ...(isMutatingCommand(parsed.name) ? { operationId: nextOperationId() } : {}),
      }
      const result = await controller.dispatch(intent)
      if (result.kind !== 'accepted')
        output.write(
          `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
        )
      if (result.kind === 'accepted' && result.completion) {
        if (parsed.name === 'cancel') await result.completion
        else trackCompletion(result.completion)
      }
      return
    }
    const view = controller.view()
    const intent: BraidIntent = view.activeRunId
      ? { type: 'queue', operationId: nextOperationId(), text: parsed.text }
      : { type: 'send', operationId: nextOperationId(), text: parsed.text }
    const result = await controller.dispatch(intent)
    if (result.kind !== 'accepted')
      output.write(
        `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
      )
    if (result.kind === 'accepted' && result.completion) trackCompletion(result.completion)
  }
  const consume = async (chunk: string): Promise<void> => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/u, '')
      buffered = buffered.slice(newline + 1)
      await submit(line)
      if (quitting) return
      newline = buffered.indexOf('\n')
    }
  }
  if (!input[Symbol.asyncIterator]) {
    unsubscribe()
    return 0
  }
  for await (const chunk of input) {
    await consume(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }))
    if (quitting) break
  }
  buffered += decoder.decode()
  if (buffered) await submit(buffered.replace(/\r$/u, ''))
  if (!quitting) {
    const result = await controller.dispatch({
      type: 'shutdown',
      operationId: shutdownOperationId,
    })
    if (result.kind === 'accepted' && result.completion) await result.completion
  }
  await Promise.all(pendingCompletions)
  unsubscribe()
  return 0
}

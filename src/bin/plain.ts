import { randomUUID } from 'node:crypto'
import { BoundedOutputQueue } from '../views/headless/bounded-output.js'
import { assertValidUnicodeString, MAX_RPC_LINE_BYTES } from '../views/headless/protocol-limits.js'
import { isMutatingCommand, parseCommandInput } from '../views/shared/command-registry.js'
import type { BraidIntent, BraidUiController } from '../views/shared/intents.js'
import { plainAccessibilityText, plainEventText } from '../views/shared/plain-accessibility.js'
import { sanitizeNotification, sanitizeTerminalText } from '../views/shared/sanitize.js'

export interface PlainInput extends AsyncIterable<string | Uint8Array> {}

export interface PlainOutput {
  write(chunk: string): boolean
  once?(event: 'drain', listener: () => void): unknown
}

export interface PlainOptions {
  readonly initialIntents?: readonly BraidIntent[]
}

function nextOperationId(): string {
  return `op-plain-${Date.now().toString(36)}-${randomUUID()}`
}

export async function runPlain(
  controller: BraidUiController,
  workspace: string,
  input: PlainInput,
  output: PlainOutput,
  options: PlainOptions = {},
): Promise<number> {
  const outputQueue = new BoundedOutputQueue(output)
  let outputFailure: unknown
  const write = async (chunk: string): Promise<void> => {
    if (outputFailure !== undefined) throw outputFailure
    try {
      await outputQueue.write(chunk)
    } catch (error) {
      outputFailure ??= error
      throw error
    }
  }
  const emit = write
  const initialized = await controller.initialize(workspace)
  if (initialized.kind !== 'accepted') {
    await write(
      `error: ${sanitizeTerminalText(initialized.kind === 'unavailable' ? initialized.reason : initialized.message)}\n`,
    )
    return 2
  }
  await write(`Braid ready — ${sanitizeTerminalText(workspace)}\n`)
  await write(`${plainAccessibilityText(controller.view())}\n`)
  for (const intent of options.initialIntents ?? []) {
    const result = await controller.dispatch(intent)
    if (result.kind !== 'accepted') {
      await write(
        `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
      )
    }
  }
  const unsubscribe = controller.subscribe((view, event) => {
    if (!event) return
    void emit(`${plainEventText(view, event)}\n`).catch(() => undefined)
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
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
      await write(`error: ${sanitizeNotification(parsed.message)}\n`)
      return
    }
    if (parsed.kind === 'unknown') {
      await write(
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
          await write(
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
        await write(
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
      await write(
        `error: ${sanitizeNotification(result.kind === 'unavailable' ? result.reason : result.message)}\n`,
      )
    if (result.kind === 'accepted' && result.completion) trackCompletion(result.completion)
  }
  const consume = async (chunk: string): Promise<void> => {
    assertValidUnicodeString(chunk, 'plain input')
    buffered += chunk
    if (Buffer.byteLength(buffered, 'utf8') > MAX_RPC_LINE_BYTES && buffered.indexOf('\n') < 0)
      throw new Error('LINE_TOO_LARGE: input line exceeds the 1 MiB limit')
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
    if (outputFailure !== undefined) throw outputFailure
    let decoded: string
    try {
      decoded = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    } catch {
      throw new Error('INVALID_UTF8: plain input contains malformed UTF-8')
    }
    await consume(decoded)
    if (quitting) break
  }
  try {
    buffered += decoder.decode()
  } catch {
    throw new Error('INVALID_UTF8: plain input contains malformed UTF-8')
  }
  if (buffered) await submit(buffered.replace(/\r$/u, ''))
  if (!quitting) {
    const result = await controller.dispatch({
      type: 'shutdown',
      operationId: shutdownOperationId,
    })
    if (result.kind === 'accepted' && result.completion) await result.completion
  }
  await Promise.all(pendingCompletions)
  await outputQueue.flush()
  if (outputFailure !== undefined) throw outputFailure
  unsubscribe()
  return 0
}

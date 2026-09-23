import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { TuiMainScreen } from '@earendil-works/pi-tui'
import { type InteractionResponse, permissionAnswerSpec } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import {
  createInteractionRequest,
  rebindInteractionRequest,
} from '../src/app/interaction-request.js'
import type { BraidRuntimeEvent } from '../src/domain/runtime-events.js'
import type { ExecutionPort } from '../src/ports/execution.js'
import { BraidTerminalApp } from '../src/views/tui/terminal-app.js'
import { createBraidTheme } from '../src/views/tui/theme.js'
import { interactionResponseRunCapabilities } from './support/run-capabilities.js'
import { VirtualTerminal } from './support/virtual-terminal.js'

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for permission response')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Enter on Allow once sends a valid Pi permission response through the terminal', async () => {
  const request = createInteractionRequest({
    id: 'interaction-pi-bash',
    kind: 'permission',
    title: 'Permission: bash',
    answerSpec: permissionAnswerSpec({ allowFeedback: false, responseScopes: ['interaction'] }),
    responseScopes: ['interaction'],
    binding: {
      runId: 'run-pi-bash',
      provider: 'cli-bridge',
      environmentId: 'environment-pi-bash',
      sessionId: 'session-pi-bash',
      executionId: 'run-pi-bash',
      interactionId: 'interaction-pi-bash',
    },
  })
  let release: (() => void) | undefined
  let providerResponse: InteractionResponse | undefined
  const execution: ExecutionPort = {
    capabilities: () => interactionResponseRunCapabilities(),
    async *streamTurn(input): AsyncIterable<BraidRuntimeEvent> {
      yield {
        type: 'interaction',
        request: rebindInteractionRequest(request, {
          ...request.binding,
          runId: input.runId,
          executionId: input.runId,
        }),
      }
      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
    respondInteraction: async (input) => {
      providerResponse = input.command.response
      release?.()
      return { operationId: input.command.operationId, outcome: 'accepted' as const }
    },
  }
  const app = createBraidApplication({ fixture: 'deterministic', execution })
  app.initialize('/workspace')
  const terminal = new VirtualTerminal(80, 24)
  const captureRoot = process.env.BRAID_PERMISSION_CAPTURE_ROOT
  const startedAt = performance.now()
  const elapsed = () => Number(((performance.now() - startedAt) / 1_000).toFixed(6))
  let operation = 0
  const view = new BraidTerminalApp({
    controller: createApplicationUiController(app),
    tui: new TuiMainScreen(terminal),
    theme: createBraidTheme(false),
    workspace: '/workspace',
    nextOperationId: () => `operation-pi-bash-permission-${++operation}`,
  })
  const done = view.start()
  try {
    terminal.sendInput('run bash')
    terminal.sendInput('\r')
    await waitUntil(() => terminal.getViewport().join('\n').includes('Permission: bash'))
    const permissionFrame = terminal.getViewport().join('\n')
    const promptAt = elapsed()
    assert.match(permissionFrame, /Allow once/u)
    if (captureRoot) await new Promise((resolve) => setTimeout(resolve, 1_000))
    const enterAt = elapsed()
    terminal.sendInput('\r')
    await waitUntil(() => providerResponse !== undefined)

    assert.deepEqual(providerResponse, {
      id: 'interaction-pi-bash',
      outcome: 'accepted',
      data: { grant: ['allow_once'] },
    })
    assert.equal(
      app.events().filter((event) => event.event.kind === 'run.interaction.response.requested')
        .length,
      1,
    )
    assert.equal(app.state().runs[0]?.interactions[0]?.status, 'resolved')
    if (captureRoot) {
      await terminal.waitForRender()
      const resolvedFrame = terminal.getViewport().join('\n')
      const resolvedAt = elapsed()
      const display = (frame: string) => `\u001b[2J\u001b[H${frame.replaceAll('\n', '\r\n')}`
      const events: Array<[number, 'i' | 'o', string]> = [
        [promptAt, 'o', display(permissionFrame)],
        [enterAt, 'i', '\r'],
        [resolvedAt, 'o', display(resolvedFrame)],
      ]
      await mkdir(captureRoot, { recursive: true })
      const cast = [
        JSON.stringify({
          version: 2,
          width: 80,
          height: 24,
          timestamp: Math.floor(Date.now() / 1_000),
          duration: resolvedAt,
          idle_time_limit: 2,
          command: 'Braid TUI permission regression with controlled provider',
          title: 'Braid Pi permission keyboard response (controlled provider)',
          env: { TERM: 'xterm-256color' },
          stdin: true,
        }),
        ...events.map((event) => JSON.stringify(event)),
        '',
      ].join('\n')
      await writeFile(join(captureRoot, '80x24-permission-response.cast'), cast)
      const plainFrame = (frame: string) => `${frame.replace(/[ \t]+$/gmu, '')}\n`
      await writeFile(join(captureRoot, '80x24-permission-prompt.txt'), plainFrame(permissionFrame))
      await writeFile(join(captureRoot, '80x24-permission-resolved.txt'), plainFrame(resolvedFrame))
    }
  } finally {
    release?.()
    view.stop()
    await done
  }
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const COLUMNS = 120
const ROWS = 18
const CONNECTION_ID = 'connection-local-cli-bridge'

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function rebaseEvents(events) {
  const offset = events[0]?.[0] ?? 0
  return events.map(([timestamp, direction, data]) => [
    Number((timestamp - offset + 0.01).toFixed(6)),
    direction,
    data,
  ])
}

async function typeText(terminal, value, delayMs = 20) {
  for (const character of value) {
    terminal.input(character)
    await pause(delayMs)
  }
}

export async function captureProductDemo({ spawnTerminal, normalized, castFor }) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'braid-product-demo-'))
  const workspace = join(temporaryRoot, 'agent-sdk')
  await mkdir(workspace)
  const terminal = await spawnTerminal(
    'product-demo',
    COLUMNS,
    ROWS,
    { BRAID_FIXTURE_CHUNK_DELAY_MS: '70' },
    'product-demo',
    ['--connection', CONNECTION_ID, '--workspace', workspace],
  )
  try {
    await terminal.waitForInterface()
    await terminal.waitFor(() => {
      const screen = normalized(terminal.screen())
      return (
        screen.includes('Release engineer') &&
        screen.includes('runner pi') &&
        screen.includes('Local CLI Bridge') &&
        screen.includes('openai-codex/gpt-5.6-luna')
      )
    }, 'complete product configuration')
    await pause(700)

    await typeText(terminal, '/profile', 30)
    terminal.input('\r')
    await terminal.waitFor(() => {
      const screen = normalized(terminal.screen())
      return (
        screen.includes('Active profile · Release engineer') &&
        screen.includes('runner pi · model openai-codex/gpt-5.6-luna')
      )
    }, 'AgentProfile panel')
    await pause(1_000)
    terminal.input('\u001b')
    await terminal.waitFor(
      () => !normalized(terminal.screen()).includes('Active profile · Release engineer'),
      'AgentProfile panel close',
    )
    await pause(350)

    const prompt = 'Trace this request from AgentProfile to the selected runner.'
    await typeText(terminal, prompt)
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('Route confirmed.'),
      'routed response',
      15_000,
    )
    await terminal.waitFor(
      () => {
        const screen = normalized(terminal.screen())
        return (
          screen.includes('completed') &&
          screen.includes('model openai-codex/gpt-5.6-luna') &&
          !screen.includes('Ctrl+C cancel')
        )
      },
      'completed run',
      15_000,
    )
    await terminal.waitForStable('product screenshot')
    const screenshot = terminal.snapshot()
    await pause(900)

    terminal.input('\u001bOQ')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('activity'),
      'activity pane',
    )
    await pause(700)
    terminal.input('\u001bOQ')
    await terminal.waitFor(
      () => !normalized(terminal.screen()).includes('activity'),
      'activity pane close',
    )

    await typeText(terminal, '/ask What should this agent improve next?', 18)
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('/ask · frozen question'),
      'trace analysis',
    )
    await terminal.waitForStable('product demo final frame')
    await pause(1_000)
    const demo = terminal.snapshot()
    await terminal.closeNormally()

    return {
      columns: COLUMNS,
      rows: ROWS,
      finalScreen: screenshot.screen,
      frameCast: castFor(
        terminal,
        terminal.events.slice(0, screenshot.eventCount),
        'Braid product screenshot',
      ),
      demoCast: castFor(
        terminal,
        rebaseEvents(terminal.events.slice(0, demo.eventCount)),
        'Braid product demo',
      ),
      steps: [
        'Inspect AgentProfile',
        'Run through Local CLI Bridge',
        'Inspect tool activity',
        'Analyze the frozen trace with /ask',
        'Review the analysis list and details together',
      ],
    }
  } finally {
    await terminal.dispose()
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

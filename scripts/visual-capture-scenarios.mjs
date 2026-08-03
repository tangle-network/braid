import { castFor, normalized, sleep } from './visual-capture-terminal.mjs'

export async function baselineCapture({ createTerminal, columns, rows }) {
  const terminal = await createTerminal(`baseline-${columns}x${rows}`, columns, rows)
  try {
    await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
    terminal.input('W6 visual proof')
    terminal.input('\r')
    await terminal.waitFor(
      () => normalized(terminal.screen()).includes('Fixture response through pi: W6 visual proof'),
      'response',
    )
    await terminal.waitFor(
      () =>
        normalized(terminal.screen()).includes('completed') ||
        normalized(terminal.screen()).includes('ready for a message'),
      'final state',
    )
    const point = terminal.snapshot()
    await terminal.closeNormally()
    return {
      columns,
      rows,
      finalScreen: point.screen,
      cast: castFor(terminal, terminal.events, `Braid W6 ${columns}x${rows}`),
      frameCast: castFor(
        terminal,
        terminal.events.slice(0, point.eventCount),
        `Braid W6 ${columns}x${rows}`,
      ),
    }
  } finally {
    await terminal.dispose()
  }
}

export const STATE_DEFINITIONS = [
  {
    name: 'empty',
    columns: 80,
    rows: 24,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'active-streaming',
    columns: 80,
    rows: 24,
    environment: { BRAID_FIXTURE_CHUNK_DELAY_MS: '1000' },
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('W6 active streaming')
      terminal.input('\r')
      await terminal.waitFor(() => normalized(terminal.screen()).includes('streaming'), 'streaming')
      const { point, record } = await terminal.captureState()
      terminal.input('/cancel')
      terminal.input('\r')
      await terminal.waitFor(
        () =>
          normalized(terminal.screen()).includes('cancelled') ||
          normalized(terminal.screen()).includes('completed'),
        'cancellation',
      )
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'interaction',
    columns: 80,
    rows: 24,
    uiFixture: 'interaction',
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('Allow the fixture tool'),
        'interaction fixture',
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'fork-preview',
    columns: 80,
    rows: 24,
    uiFixture: 'fork',
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('/fork')
      await sleep(50)
      terminal.input('\r')
      await sleep(50)
      terminal.input('\r')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('workspace-fork'),
        `fork fixture screen=${normalized(terminal.screen())}`,
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'graph-or-analysis',
    columns: 80,
    rows: 24,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('\u0007')
      await terminal.waitFor(
        () => normalized(terminal.screen()).includes('conversation graph'),
        'graph',
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'narrow',
    columns: 40,
    rows: 12,
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
  {
    name: 'failure-or-reconnect',
    columns: 80,
    rows: 24,
    environment: { BRAID_FIXTURE_FAILURE: '1' },
    run: async (terminal) => {
      await terminal.waitFor(() => terminal.screen().includes('braid'), 'header')
      terminal.input('W6 failure state')
      terminal.input('\r')
      await terminal.waitFor(() => normalized(terminal.screen()).includes('failed'), 'failure')
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  },
]

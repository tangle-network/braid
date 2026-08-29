export function isRunningWorkStripRow(line) {
  return /^(?:focus|work) .+ · running(?: ·|\s|$)/u.test(line.trimStart())
}

export function createStateDefinitions(normalized) {
  return [
    ...[40, 80, 120].map((columns) => commandPaletteDefinition(columns, normalized)),
    {
      name: 'empty',
      columns: 80,
      rows: 24,
      run: async (terminal) => {
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
        terminal.input('W6 active streaming')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('working'),
          'active work',
        )
        const { point, record } = await terminal.captureState()
        terminal.input('/cancel')
        terminal.input('\r')
        await terminal.waitFor(
          () =>
            normalized(terminal.screen()).includes('cancelled') ||
            normalized(terminal.screen()).includes('completed') ||
            normalized(terminal.screen()).includes('failed'),
          'cancellation',
        )
        await terminal.closeNormally()
        return { point, record }
      },
    },
    {
      name: 'multi-run',
      columns: 80,
      rows: 24,
      environment: { BRAID_FIXTURE_CHUNK_DELAY_MS: '10000' },
      run: async (terminal) => {
        terminal.input('/new Parallel run A')
        terminal.input('\r')
        await new Promise((resolve) => setTimeout(resolve, 100))
        terminal.input('parallel run A')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('working'),
          'first active run',
        )
        terminal.input('/new Parallel run B')
        terminal.input('\r')
        await new Promise((resolve) => setTimeout(resolve, 100))
        terminal.input('parallel run B')
        terminal.input('\r')
        await terminal.waitFor(
          () => terminal.screen().split('\n').filter(isRunningWorkStripRow).length >= 2,
          'two Work Strip rows',
        )
        const before = await terminal.captureState()
        const switchedFrom = before.record.view?.focusedRunId
        const activityRuns = (before.record.view?.activity ?? [])
          .filter((item) => item.kind === 'run')
          .slice()
          .reverse()
        const targetIndex = activityRuns.findIndex((item) => item.runId !== switchedFrom)
        const targetRunId = activityRuns[targetIndex]?.runId
        const targetTitle = activityRuns[targetIndex]?.title
        if (typeof targetRunId !== 'string' || typeof targetTitle !== 'string') {
          throw new Error('multi-run capture could not resolve the background Activity row')
        }
        if (targetIndex !== 1) {
          throw new Error(`multi-run capture expected one background row, received ${targetIndex}`)
        }
        terminal.input('\u001bOQ')
        await terminal.waitFor(() => /^\s*activity\b/iu.test(terminal.screen()), 'activity browser')
        terminal.input('\t')
        await new Promise((resolve) => setTimeout(resolve, 250))
        terminal.input('\u001b[B')
        await new Promise((resolve) => setTimeout(resolve, 250))
        await terminal.waitForStable('background Activity row')
        const selectedLine = terminal
          .screen()
          .split('\n')
          .find((line) => /^\s*›\s/u.test(line))
        if (!selectedLine?.includes(targetTitle)) {
          throw new Error(
            `multi-run capture could not select ${JSON.stringify(targetTitle)} in Activity; selected=${JSON.stringify(selectedLine ?? '')}`,
          )
        }
        terminal.input('\r')
        await terminal.waitForStable('background focus selection')
        terminal.input('\u001b[D')
        await terminal.waitForStable('activity list return')
        terminal.input('\u001b')
        await new Promise((resolve) => setTimeout(resolve, 250))
        await terminal.waitFor(
          () => !/^\s*runs\b/iu.test(terminal.screen()),
          'activity browser dismissal',
        )
        const { point, record } = await terminal.captureState()
        await terminal.closeWithSignal()
        return { point, record, switchedFrom, targetRunId }
      },
    },
    {
      name: 'supervision',
      columns: 80,
      rows: 24,
      uiFixture: 'supervision',
      run: async (terminal) => {
        terminal.input('/activity')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('stream and replay'),
          'supervisor activity',
        )
        // Activity starts on the all scope. Cycle until the worker scope is visible.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (/^\s*workers\b/iu.test(terminal.screen())) break
          const previousHeading = terminal.screen().split('\n', 1)[0]
          terminal.input('\t')
          await terminal.waitFor(
            () => terminal.screen().split('\n', 1)[0] !== previousHeading,
            `worker activity scope ${attempt + 1}`,
          )
        }
        await terminal.waitFor(
          () => /^\s*workers\b/iu.test(terminal.screen()),
          'worker activity filter',
        )
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('a/r'),
          'worker attach control',
        )
        const { point, record } = await terminal.captureState()
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
      name: 'automation',
      columns: 80,
      rows: 24,
      run: async (terminal) => {
        terminal.input('/automate')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('automation rules'),
          'automation rule manager',
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
        terminal.input('/fork')
        await new Promise((resolve) => setTimeout(resolve, 50))
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('enter/y create fork'),
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
      name: 'analysis',
      columns: 80,
      rows: 24,
      uiFixture: 'analysis',
      run: async (terminal) => {
        terminal.input('/ask Where did this run waste time?')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('/ask · frozen question'),
          'analysis result',
        )
        const { point, record } = await terminal.captureState()
        await terminal.closeNormally()
        return { point, record }
      },
    },
    {
      name: 'comparison',
      columns: 80,
      rows: 24,
      uiFixture: 'comparison',
      run: async (terminal) => {
        terminal.input('/compare run-route-serial run-route-parallel')
        terminal.input('\r')
        await terminal.waitFor(
          () => normalized(terminal.screen()).includes('/compare · frozen runs'),
          'comparison result',
        )
        const { point, record } = await terminal.captureState()
        await terminal.closeNormally()
        return { point, record }
      },
    },
    {
      name: 'profile',
      columns: 80,
      rows: 24,
      run: async (terminal) => {
        terminal.input('/profile')
        terminal.input('\r')
        await terminal.waitFor(
          () =>
            normalized(terminal.screen()).includes('Braid starter') &&
            normalized(terminal.screen()).includes('trusted · read-only'),
          'profile editor',
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
        terminal.input('W6 failure state')
        terminal.input('\r')
        await terminal.waitFor(() => normalized(terminal.screen()).includes('failed'), 'failure')
        const { point, record } = await terminal.captureState()
        await terminal.closeNormally()
        return { point, record }
      },
    },
  ]
}

function commandPaletteDefinition(columns, normalized) {
  return {
    name: `command-palette-${columns}`,
    columns,
    rows: columns === 40 ? 12 : 24,
    run: async (terminal) => {
      await terminal.waitForStable('before command palette')
      terminal.input('\u0010')
      await terminal.waitFor(
        () =>
          normalized(terminal.screen()).includes('Commands') &&
          normalized(terminal.screen()).includes('←/esc close'),
        `full-screen command palette screen=${normalized(terminal.screen())}`,
      )
      const { point, record } = await terminal.captureState()
      await terminal.closeNormally()
      return { point, record }
    },
  }
}

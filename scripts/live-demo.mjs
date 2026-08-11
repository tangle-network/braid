import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

import { writeCastGif, writeRaster } from './capture-visual-support.mjs'
import { configureWithPublicTui } from './live-core/setup-tui.mjs'
import { jsonRequest } from './live-demo/http.mjs'
import { assertExactPackageProof, safeManifestAnalysis } from './live-demo/manifest.mjs'
import { assertPublicCapture } from './live-demo/public-safety.mjs'
import {
  castFor,
  createCapturedTerminal,
  pause,
  terminalPageProgress,
  typeText,
  visibleModelCallNumbers,
} from './live-demo/terminal.mjs'
import {
  createLiveDemoWorkspace,
  LIVE_DEMO_PROFILE,
  LIVE_DEMO_PROMPT,
  LIVE_DEMO_QUESTION,
} from './live-demo/workspace.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname.replace(/\/$/u, '')
const endpoint = process.env.BRAID_LIVE_DEMO_ENDPOINT ?? 'http://127.0.0.1:3344'
const outputRoot = process.env.BRAID_LIVE_DEMO_OUTPUT
  ? process.env.BRAID_LIVE_DEMO_OUTPUT
  : join(repository, 'artifacts', 'demo')
const packageProofPath = process.env.BRAID_LIVE_DEMO_PACKAGE_PROOF
  ? process.env.BRAID_LIVE_DEMO_PACKAGE_PROOF
  : join(repository, 'artifacts', 'verification', 'w6', 'package-proof.json')
const route = 'pi/tangle-router/glm-5.2'
const columns = 120
const rows = 30

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertLocalEndpoint(value) {
  const parsed = new URL(value)
  assert.equal(parsed.protocol, 'http:', 'The live demo requires a local HTTP CLI Bridge')
  assert.ok(
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname),
    'The live demo refuses a non-loopback CLI Bridge',
  )
  assert.equal(parsed.username, '', 'The live demo endpoint must not contain credentials')
  assert.equal(parsed.password, '', 'The live demo endpoint must not contain credentials')
  assert.equal(parsed.search, '', 'The live demo endpoint must not contain query data')
  assert.equal(parsed.hash, '', 'The live demo endpoint must not contain a fragment')
  return parsed.origin
}

async function bridgeProof(baseUrl) {
  const [health, models] = await Promise.all([
    jsonRequest(`${baseUrl}/health`),
    jsonRequest(`${baseUrl}/v1/models`),
  ])
  const backend = health.backends?.find((candidate) => candidate.name === 'pi')
  assert.equal(health.status, 'ok', 'CLI Bridge is not healthy')
  assert.equal(backend?.state, 'ready', 'Pi is not ready in CLI Bridge')
  assert.ok(
    models.data?.some((candidate) => candidate.id === route),
    `${route} is not advertised by CLI Bridge`,
  )
  return { health, backend }
}

async function analysisDependencyProof(expectedVersion) {
  const command = process.env.BRAID_LIVE_DEMO_PYTHON ?? 'python'
  const probe = [
    'import importlib.metadata',
    'import agent_eval_rpc.dspy_rlm_bridge',
    "print(importlib.metadata.version('agent-eval-rpc'))",
  ].join(';')
  const { stdout } = await run(command, ['-c', probe], { timeout: 30_000 })
  const version = stdout.trim()
  assert.equal(
    version,
    expectedVersion,
    `Python agent-eval-rpc ${version || '(missing)'} does not match Node agent-eval ${expectedVersion}`,
  )
  return { version }
}

function latestCompletedRun(record) {
  const run = record.state?.runs?.at(-1)
  return run?.status === 'completed' && record.view?.status === 'completed' ? run : undefined
}

async function waitForCompletedRun(terminal, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  let lastRecord
  while (Date.now() < deadline) {
    lastRecord = await terminal.captureState()
    const run = latestCompletedRun(lastRecord)
    if (run !== undefined) return { record: lastRecord, run }
    const terminalRun = lastRecord.state?.runs?.at(-1)
    if (terminalRun?.status === 'failed' || terminalRun?.status === 'unknown') {
      throw new Error(
        `The coding turn ended ${terminalRun.status}: ${terminalRun.error ?? 'no error'}`,
      )
    }
    await pause(500)
  }
  throw new Error(
    `Timed out waiting for the coding turn; last status=${lastRecord?.view?.status ?? 'unknown'}`,
  )
}

async function waitForCompletedAnalysis(terminal, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs
  let lastRecord
  while (Date.now() < deadline) {
    lastRecord = await terminal.captureState()
    const analysis = lastRecord.view?.activity?.filter((item) => item.kind === 'analysis').at(-1)
    if (analysis?.status === 'complete') return lastRecord
    if (analysis?.status === 'failed' || analysis?.status === 'cancelled') {
      const detail = lastRecord.view?.entityDetails?.find(
        (item) => item.entityType === 'analysis' && item.entityId === analysis.entityId,
      )
      throw new Error(
        `The real /ask analysis ended ${analysis.status}: ${detail?.lines?.join(' | ') ?? 'no public detail'}`,
      )
    }
    await pause(500)
  }
  throw new Error(
    `Timed out waiting for /ask; last status=${lastRecord?.view?.status ?? 'unknown'}`,
  )
}

function transcriptEvidence(record) {
  const messages = record.state?.messages ?? []
  const parts = messages.flatMap((message) => message.parts ?? [])
  return {
    messages,
    assistantMessages: messages.filter(
      (message) => message.role === 'assistant' && message.text?.trim().length > 0,
    ),
    artifactParts: parts.filter((part) => part.kind === 'artifact'),
    toolParts: parts.filter((part) => part.kind === 'tool'),
    resultParts: parts.filter((part) => part.kind === 'result'),
  }
}

async function verifyWorkspace(workspace) {
  const test = await run('npm', ['test', '--', '--test-reporter=spec'], {
    cwd: workspace,
    timeout: 30_000,
  })
  const sample = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "import { slugify } from './src/slugify.js'",
        "const actual = [slugify('Café déjà vu!'), slugify('  Ship___it  ')]",
        "if (actual[0] !== 'cafe-deja-vu' || actual[1] !== 'ship-it') throw new Error(JSON.stringify(actual))",
        "process.stdout.write(actual.join('\\n'))",
      ].join(';'),
    ],
    { cwd: workspace, timeout: 10_000 },
  )
  return {
    testOutput: `${test.stdout}${test.stderr}`.trim(),
    samples: sample.stdout.trim().split('\n'),
    sourceSha256: sha256(await readFile(join(workspace, 'src', 'slugify.js'))),
    testSha256: sha256(await readFile(join(workspace, 'test', 'slugify.test.js'))),
  }
}

async function main() {
  const baseUrl = assertLocalEndpoint(endpoint)
  const [agentEvalPackage, sourcePackage, packageProofBytes, commitResult] = await Promise.all([
    readFile(
      join(repository, 'node_modules', '@tangle-network', 'agent-eval', 'package.json'),
    ).then(JSON.parse),
    readFile(join(repository, 'package.json'), 'utf8').then(JSON.parse),
    readFile(packageProofPath),
    run('git', ['rev-parse', 'HEAD'], { cwd: repository }),
  ])
  const sourceCommit = commitResult.stdout.trim()
  const packageProof = JSON.parse(packageProofBytes.toString('utf8'))
  const [bridge, analysisRuntime] = await Promise.all([
    bridgeProof(baseUrl),
    analysisDependencyProof(agentEvalPackage.version),
  ])
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'braid-live-demo-'))
  const packed = await installPackedBraid(repository, {
    tarballPath: process.env.BRAID_RELEASE_TARBALL,
  })
  let terminal
  try {
    assertExactPackageProof(packageProof, {
      commit: sourceCommit,
      version: sourcePackage.version,
      tarball: packed.tarballName,
      tarballSha256: packed.tarballSha256,
    })
    const { workspace, profilePath } = await createLiveDemoWorkspace(temporaryRoot)
    const keyFile = join(temporaryRoot, 'database.key')
    const recordPath = join(temporaryRoot, 'live-demo-state.json')
    await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    const setup = await configureWithPublicTui(
      packed.binary,
      workspace,
      keyFile,
      baseUrl,
      'pi',
      route,
      profilePath,
    )
    assert.equal(setup.config.profile.name, LIVE_DEMO_PROFILE.name)
    assert.equal(setup.config.profile.harness, LIVE_DEMO_PROFILE.harness)
    assert.equal(setup.config.profile.model.default, LIVE_DEMO_PROFILE.model.default)
    assert.equal(
      setup.config.profile.model.metadata.maxTokens,
      LIVE_DEMO_PROFILE.model.metadata.maxTokens,
    )

    terminal = await createCapturedTerminal({
      binary: packed.binary,
      args: [
        '--workspace',
        workspace,
        '--database-key-file',
        keyFile,
        '--record-state',
        recordPath,
      ],
      cwd: workspace,
      columns,
      rows,
      recordPath,
      environment: {
        BRAID_CLI_BRIDGE_ENDPOINT: baseUrl,
        BRAID_MODEL_VALIDATION_TIMEOUT_MS: '120000',
        BRAID_STATE_PATH: `${keyFile}.state.sqlite`,
        XDG_DATA_HOME: `${keyFile}.data`,
        XDG_CONFIG_HOME: `${keyFile}.config`,
        NODE_NO_WARNINGS: '1',
      },
    })
    await terminal.waitForScreen(
      (screen) =>
        screen.includes('Product engineer') &&
        screen.includes('runner pi') &&
        screen.includes('tangle-router/glm-5.2') &&
        screen.includes('Local CLI Bridge'),
      'real AgentProfile route',
      60_000,
    )
    await pause(700)

    await typeText(terminal, '/profile', 24)
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) =>
        screen.includes('Active profile · Product engineer') &&
        screen.includes(
          `thinking high · max output ${LIVE_DEMO_PROFILE.model.metadata.maxTokens.toLocaleString('en-US')} tokens`,
        ),
      'AgentProfile details',
    )
    await pause(900)
    terminal.input('\u001b')
    await terminal.waitForScreen(
      (screen) => !screen.includes('Active profile · Product engineer'),
      'AgentProfile close',
    )
    await pause(300)

    await typeText(terminal, LIVE_DEMO_PROMPT, 9)
    terminal.input('\r')
    const coding = await waitForCompletedRun(terminal)
    const transcript = transcriptEvidence(coding.record)
    assert.ok(
      transcript.assistantMessages.length > 0,
      'The coding turn returned no visible assistant result',
    )
    assert.ok(
      transcript.artifactParts.length > 0,
      'The coding turn retained no agent-runtime result artifact',
    )
    assert.equal(coding.run.runner, 'pi')
    assert.equal(coding.run.model, route)
    const workspaceProof = await verifyWorkspace(workspace)
    await terminal.waitForStable('completed coding turn')
    await pause(800)

    terminal.input('\u001bOQ')
    await terminal.waitForScreen((screen) => screen.includes('activity'), 'activity browser')
    await pause(900)
    terminal.input('\u001bOQ')
    await terminal.waitForScreen(
      (screen) => !screen.includes('activity ·'),
      'activity browser close',
    )
    await pause(300)

    await typeText(terminal, `/ask ${LIVE_DEMO_QUESTION}`, 9)
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) =>
        screen.includes('analyses') &&
        (screen.includes('Starting /ask') || screen.includes('/ask')),
      'immediate trace analysis progress',
    )
    await terminal.waitForScreen(
      (screen) => screen.includes('/ask · frozen question'),
      'trace analysis panel',
    )
    const analysisRecord = await waitForCompletedAnalysis(terminal)
    await terminal.waitForStable('completed trace analysis')
    const analysis = safeManifestAnalysis(analysisRecord)
    await terminal.waitForStable('final live demo frame')
    await pause(900)
    const hero = terminal.snapshot()
    const visibleCalls = new Set(visibleModelCallNumbers(terminal.screen()))
    let page = terminalPageProgress(terminal.screen())
    assert.ok(page, 'The public demo did not render analysis page progress')
    while (page.current < page.total) {
      const previousPage = page.current
      terminal.input('\u001b[6~')
      await terminal.waitForScreen(
        (screen) => (terminalPageProgress(screen)?.current ?? 0) > previousPage,
        `analysis page ${previousPage + 1}`,
      )
      await terminal.waitForStable(`analysis page ${previousPage + 1}`)
      await pause(700)
      for (const sequence of visibleModelCallNumbers(terminal.screen())) visibleCalls.add(sequence)
      page = terminalPageProgress(terminal.screen())
      assert.ok(page, 'The public demo lost analysis page progress')
    }
    assert.equal(page.current, page.total, 'The public demo did not reach the final analysis page')
    if (analysis.modelCalls !== null) {
      for (let sequence = 1; sequence <= analysis.modelCalls; sequence += 1) {
        assert.ok(
          visibleCalls.has(sequence),
          `The public demo did not render model call #${sequence}`,
        )
      }
    }
    const finalRecord = await terminal.captureState()
    const heroScreen = hero.screen
    const cast = castFor(
      terminal,
      'Braid · AgentProfile to Pi, then trace analysis',
      'braid --profile Product-engineer --connection Local-CLI-Bridge',
      hero.eventCount,
    )
    assertPublicCapture(`${cast}\n${heroScreen}`)
    await terminal.closeNormally()

    await mkdir(outputRoot, { recursive: true })
    const castPath = join(outputRoot, 'braid-live-pi.cast')
    const frameCastPath = join(temporaryRoot, 'braid-live-pi-frame.cast')
    const gifPath = join(outputRoot, 'braid-live-pi.gif')
    const pngPath = join(outputRoot, 'braid-live-pi.png')
    const textPath = join(outputRoot, 'braid-live-pi.txt')
    const manifestPath = join(outputRoot, 'braid-live-pi.json')
    const frameCast = castFor(
      { ...terminal, events: terminal.events.slice(0, hero.eventCount) },
      'Braid · completed trace analysis',
      'braid --profile Product-engineer --connection Local-CLI-Bridge',
    )
    await Promise.all([
      writeFile(castPath, cast),
      writeFile(frameCastPath, frameCast),
      writeFile(textPath, heroScreen),
    ])
    await writeCastGif(castPath, gifPath, { loop: true })
    await writeRaster(frameCastPath, pngPath, join(temporaryRoot, 'frame.gif'))
    const manifest = {
      schemaVersion: 2,
      status: 'passed',
      capturedAt: new Date().toISOString(),
      source: {
        commit: sourceCommit,
        packageVersion: sourcePackage.version,
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        packageProofSha256: sha256(packageProofBytes),
      },
      route: {
        connection: 'Local CLI Bridge',
        endpoint: baseUrl,
        runner: 'pi',
        runnerVersion: bridge.backend.version,
        provider: 'tangle-router',
        model: 'glm-5.2',
      },
      profile: {
        name: LIVE_DEMO_PROFILE.name,
        reasoningEffort: LIVE_DEMO_PROFILE.model.reasoningEffort,
        maxOutputTokens: LIVE_DEMO_PROFILE.model.metadata.maxTokens,
      },
      task: {
        prompt: LIVE_DEMO_PROMPT,
        runId: coding.run.id,
        providerSessionId: coding.run.providerSessionId ?? null,
        inputTokens: coding.run.inputTokens,
        outputTokens: coding.run.outputTokens,
        llmCalls: coding.run.llmCalls ?? null,
        llmLatencyMs: coding.run.llmLatencyMs ?? null,
        normalizedToolCalls: transcript.toolParts.length,
        normalizedToolResults: transcript.resultParts.length,
        toolProjection:
          transcript.toolParts.length > 0 && transcript.resultParts.length > 0
            ? { status: 'available' }
            : {
                status: 'blocked-upstream',
                issue: 'https://github.com/tangle-network/agent-runtime/issues/762',
              },
        workspaceProof,
      },
      analysis: {
        question: LIVE_DEMO_QUESTION,
        agentEvalRpcVersion: analysisRuntime.version,
        ...analysis,
      },
      terminal: { columns, rows, finalRevision: finalRecord.view.revision },
      artifacts: Object.fromEntries(
        await Promise.all(
          [castPath, gifPath, pngPath, textPath].map(async (path) => [
            relative(outputRoot, path),
            sha256(await readFile(path)),
          ]),
        ),
      ),
    }
    assertPublicCapture(JSON.stringify(manifest))
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`)
  } finally {
    await terminal?.dispose()
    await packed.cleanup()
    await rm(temporaryRoot, { force: true, recursive: true })
  }
}

await main()

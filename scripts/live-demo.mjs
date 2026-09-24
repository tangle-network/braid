import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { writeCastGif, writeRaster } from './capture-visual-support.mjs'
import { configureWithPublicTui } from './live-core/setup-tui.mjs'
import { jsonRequest } from './live-demo/http.mjs'
import {
  assertExactPackageProof,
  packageTarballPath,
  safeManifestAnalysis,
} from './live-demo/manifest.mjs'
import { assertPublicCapture } from './live-demo/public-safety.mjs'
import { releaseTargetDefinitions } from './live-bridge/bridge.mjs'
import {
  castFor,
  createCapturedTerminal,
  expectedDemoPermission,
  normalizeTerminal,
  pause,
  terminalFailureDetail,
  terminalPageProgress,
  typeText,
  visibleModelCallNumbers,
} from './live-demo/terminal.mjs'
import {
  createLiveDemoWorkspace,
  liveDemoProfileForRoute,
  LIVE_DEMO_ANALYST_PROFILE,
  LIVE_DEMO_MODEL_ROUTE,
  LIVE_DEMO_PROFILE,
  LIVE_DEMO_PROMPT,
  LIVE_DEMO_QUESTION,
} from './live-demo/workspace.mjs'
import { installPackedBraid } from './packed-binary.mjs'

const run = promisify(execFile)
const repository = new URL('../', import.meta.url).pathname.replace(/\/$/u, '')
const endpoint = process.env.BRAID_LIVE_DEMO_ENDPOINT ?? 'http://127.0.0.1:3345'
const outputRoot = process.env.BRAID_LIVE_DEMO_OUTPUT
  ? process.env.BRAID_LIVE_DEMO_OUTPUT
  : join(repository, 'artifacts', 'demo')
const packageProofPath = process.env.BRAID_LIVE_DEMO_PACKAGE_PROOF
  ? process.env.BRAID_LIVE_DEMO_PACKAGE_PROOF
  : join(repository, 'artifacts', 'verification', 'w6', 'package-proof.json')
const packageSource = resolve(process.env.BRAID_LIVE_DEMO_PACKAGE_SOURCE ?? repository)
const columns = 160
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
  const backend = health.backends?.find((candidate) => candidate.name === LIVE_DEMO_PROFILE.harness)
  assert.equal(health.status, 'ok', 'CLI Bridge is not healthy')
  assert.equal(backend?.state, 'ready', `${LIVE_DEMO_PROFILE.harness} is not ready in CLI Bridge`)
  const requestedModel = process.env.BRAID_LIVE_DEMO_MODEL ?? LIVE_DEMO_MODEL_ROUTE
  const [target] = releaseTargetDefinitions(
    [{ backend: LIVE_DEMO_PROFILE.harness, modelId: requestedModel }],
    { ok: true, body: models },
    { body: health },
  ).filter((candidate) => candidate.backend === LIVE_DEMO_PROFILE.harness)
  assert.equal(target?.modelId, requestedModel, `CLI Bridge does not advertise ${requestedModel}`)
  return { health, backend, target }
}

function latestCompletedRun(record) {
  const run = record.state?.runs?.at(-1)
  return run?.status === 'completed' && record.view?.status === 'completed' ? run : undefined
}

function permissionVisible(screen) {
  return /\bPermission: (bash|read|write|edit)\b/u.test(screen) && screen.includes('→ Allow once')
}

async function approveExpectedPermission(terminal, record, approvals) {
  const permission = expectedDemoPermission(record)
  if (permission === undefined) return false
  assert.ok(approvals.length < 24, 'The live demo exceeded its permission approval limit')
  await terminal.waitForScreen(
    (screen) =>
      screen.includes(`Permission: ${permission.tool}`) && screen.includes('→ Allow once'),
    `one-time ${permission.tool} permission`,
  )
  const priorScreen = normalizeTerminal(terminal.screen())
  terminal.input('\r')
  await terminal.waitForScreen(
    (screen) => screen !== priorScreen && !screen.includes('→ Allow once'),
    `one-time ${permission.tool} permission response`,
    60_000,
  )
  approvals.push({ tool: permission.tool, scope: 'once' })
  return true
}

async function waitForCodingRunAdmission(baseUrl, startedAt, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sessions = await jsonRequest(`${baseUrl}/v1/sessions?limit=100`)
    const candidates = sessions.data.filter(
      (session) =>
        session.id.startsWith('session-braid-run-') &&
        Date.parse(session.created_at) >= startedAt,
    )
    assert.ok(candidates.length <= 1, 'The live demo found multiple new coding sessions')
    if (candidates[0]?.run_id) return candidates[0].run_id
    await pause(200)
  }
  throw new Error('The live demo did not observe the coding run admission in CLI Bridge')
}

async function waitForCompletedRun(terminal, approvals, baseUrl, runId, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  let lastRecord
  while (Date.now() < deadline) {
    if (permissionVisible(normalizeTerminal(terminal.screen()))) {
      lastRecord = await terminal.captureState(60_000)
      assert.equal(lastRecord.state?.runs?.at(-1)?.id, runId)
      if (await approveExpectedPermission(terminal, lastRecord, approvals)) continue
    }
    const bridgeRun = await jsonRequest(`${baseUrl}/v1/runs/${runId}`)
    if (!bridgeRun.terminal) {
      await pause(500)
      continue
    }
    lastRecord = await terminal.captureState(60_000)
    const run = latestCompletedRun(lastRecord)
    if (run !== undefined) return { record: lastRecord, run }
    const terminalRun = lastRecord.state?.runs?.at(-1)
    if (terminalRun?.status === 'failed' || terminalRun?.status === 'unknown') {
      throw new Error(
        `The coding turn ended ${terminalRun.status}: ${terminalFailureDetail(lastRecord)}`,
      )
    }
    await pause(500)
  }
  throw new Error(
    `Timed out waiting for the coding turn; last status=${lastRecord?.view?.status ?? 'unknown'}`,
  )
}

async function waitForCompletedAnalysis(terminal, approvals, timeoutMs = 900_000) {
  const deadline = Date.now() + timeoutMs
  let lastRecord
  while (Date.now() < deadline) {
    await terminal.waitForScreen(
      (screen) =>
        permissionVisible(screen) || /analyst: .* · (completed|failed|cancelled)\b/u.test(screen),
      'terminal trace analysis result',
      Math.max(1, deadline - Date.now()),
    )
    lastRecord = await terminal.captureState(60_000)
    if (await approveExpectedPermission(terminal, lastRecord, approvals)) continue
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
    `Timed out waiting for /ask; last status=${lastRecord?.view?.activity?.filter((item) => item.kind === 'analysis').at(-1)?.status ?? 'unknown'}`,
  )
}

async function waitForActiveProfile(terminal, profile, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let lastRecord
  while (Date.now() < deadline) {
    lastRecord = await terminal.captureState()
    if (
      lastRecord.view?.profileName === profile.name &&
      lastRecord.view?.runner === profile.harness &&
      lastRecord.view?.model === profile.model.default
    )
      return lastRecord
    await pause(200)
  }
  throw new Error(
    `Timed out waiting for active profile ${profile.name}; ` +
      `observed profile=${lastRecord?.view?.profileName ?? 'missing'}, ` +
      `runner=${lastRecord?.view?.runner ?? 'missing'}, ` +
      `model=${lastRecord?.view?.model ?? 'missing'}`,
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
  const [
    sourcePackage,
    packageProofBytes,
    sourceIdentity,
    sourceStatus,
    driverIdentity,
    driverStatus,
    bridge,
  ] = await Promise.all([
    readFile(join(packageSource, 'package.json'), 'utf8').then(JSON.parse),
    readFile(packageProofPath),
    run('git', ['rev-parse', 'HEAD', 'HEAD^{tree}', '--show-toplevel'], {
      cwd: packageSource,
    }),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: packageSource,
    }),
    run('git', ['rev-parse', 'HEAD'], { cwd: repository }),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repository,
    }),
    bridgeProof(baseUrl),
  ])
  assert.equal(sourceStatus.stdout.trim(), '', 'The package source checkout must be clean')
  assert.equal(driverStatus.stdout.trim(), '', 'The live demo driver checkout must be clean')
  const [sourceCommit, sourceTreeSha256, sourceRoot] = sourceIdentity.stdout.trim().split('\n')
  assert.equal(sourceRoot, packageSource, 'The package source must be a checkout root')
  const driverCommit = driverIdentity.stdout.trim()
  const packageProof = JSON.parse(packageProofBytes.toString('utf8'))
  const route = bridge.target.modelId
  const profile = liveDemoProfileForRoute(route)
  const analystProfile = liveDemoProfileForRoute(route, LIVE_DEMO_ANALYST_PROFILE)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'braid-live-demo-'))
  const packed = await installPackedBraid(repository, {
    tarballPath:
      process.env.BRAID_RELEASE_TARBALL ?? packageTarballPath(packageProofPath, packageProof),
  })
  let terminal
  try {
    assertExactPackageProof(packageProof, {
      commit: sourceCommit,
      treeSha256: sourceTreeSha256,
      version: sourcePackage.version,
      tarball: packed.tarballName,
      tarballSha256: packed.tarballSha256,
    })
    const packedPackage = JSON.parse(await readFile(join(packed.packageRoot, 'package.json')))
    const analysisRuntime = {
      manager: 'bundled uv',
      pythonVersion: '3.12',
      version: packedPackage.dependencies['@tangle-network/agent-eval'],
    }
    const { workspace, profilePath } = await createLiveDemoWorkspace(temporaryRoot, {
      profile,
      analystProfile,
    })
    const keyFile = join(temporaryRoot, 'database.key')
    const recordPath = join(temporaryRoot, 'live-demo-state.json')
    await writeFile(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 })
    const setup = await configureWithPublicTui(
      packed.binary,
      workspace,
      keyFile,
      baseUrl,
      profile.harness,
      route,
      profilePath,
    )
    assert.equal(setup.config.profile.name, profile.name)
    assert.equal(setup.config.profile.harness, profile.harness)
    assert.equal(setup.config.profile.model.default, profile.model.default)
    assert.equal(
      setup.config.profile.model.maxVisibleOutputTokens,
      profile.model.maxVisibleOutputTokens,
    )
    assert.equal(setup.config.profile.model.maxReasoningTokens, profile.model.maxReasoningTokens)
    assert.equal(
      setup.config.profile.model.maxTotalOutputTokens,
      profile.model.maxTotalOutputTokens,
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
        screen.includes(profile.name) &&
        screen.includes(profile.harness) &&
        screen.includes(profile.model.default) &&
        screen.includes('CLI Bridge'),
      'real AgentProfile route',
      60_000,
    )
    await pause(700)

    await typeText(terminal, '/profile', 24)
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) => screen.includes(profile.name) && screen.includes('thinking high'),
      'AgentProfile details',
    )
    await pause(900)
    terminal.input('\u001b')
    await terminal.waitForScreen(
      (screen) => !screen.includes('thinking high'),
      'AgentProfile close',
    )
    await pause(300)

    const codingStartedAt = Date.now()
    await typeText(terminal, LIVE_DEMO_PROMPT, 9)
    terminal.input('\r')
    await terminal.waitForScreen((screen) => screen.includes('working'), 'active coding turn')
    const codingRunId = await waitForCodingRunAdmission(baseUrl, codingStartedAt)
    const approvals = []
    const coding = await waitForCompletedRun(terminal, approvals, baseUrl, codingRunId)
    const transcript = transcriptEvidence(coding.record)
    assert.ok(
      transcript.assistantMessages.length > 0,
      'The coding turn returned no visible assistant result',
    )
    assert.equal(coding.run.runner, profile.harness)
    assert.equal(coding.run.model, route)
    const workspaceProof = await verifyWorkspace(workspace)
    await terminal.waitForStable('completed coding turn')
    await pause(800)

    await typeText(terminal, '/activity', 24)
    terminal.input('\r')
    await terminal.waitForScreen((screen) => screen.includes('activity'), 'activity browser')
    await pause(900)
    terminal.input('\u001b')
    await terminal.waitForScreen(
      (screen) => !screen.includes('activity ·'),
      'activity browser close',
    )
    await pause(300)

    await typeText(terminal, '/profile', 24)
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) => screen.includes(profile.name) && screen.includes('enter select'),
      'trace analyst profile picker',
    )
    await typeText(terminal, analystProfile.name, 24)
    await terminal.waitForScreen(
      (screen) => screen.includes(analystProfile.name),
      'filtered trace analyst profile',
    )
    terminal.input('\r')
    await terminal.waitForScreen(
      (screen) => screen.includes(`Selected ${analystProfile.name} · next runs use it`),
      'trace analyst profile selection',
    )
    terminal.input('\u001b')
    await terminal.waitForScreen(
      (screen) => !screen.includes(`Selected ${analystProfile.name} · next runs use it`),
      'trace analyst picker close',
    )
    await waitForActiveProfile(terminal, analystProfile)
    await pause(500)

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
    const analysisRecord = await waitForCompletedAnalysis(terminal, approvals)
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
      'Braid · AgentProfile coding run, then trace analysis',
      'braid --profile Product-engineer --connection Local-CLI-Bridge',
      hero.eventCount,
    )
    assertPublicCapture(`${cast}\n${heroScreen}`)
    await terminal.closeNormally()

    await mkdir(outputRoot, { recursive: true })
    const castPath = join(outputRoot, 'braid-live.cast')
    const frameCastPath = join(temporaryRoot, 'braid-live-frame.cast')
    const gifPath = join(outputRoot, 'braid-live.gif')
    const pngPath = join(outputRoot, 'braid-live.png')
    const textPath = join(outputRoot, 'braid-live.txt')
    const manifestPath = join(outputRoot, 'braid-live.json')
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
        treeSha256: sourceTreeSha256,
        packageVersion: sourcePackage.version,
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        packageProofSha256: sha256(packageProofBytes),
      },
      driver: { commit: driverCommit },
      route: {
        connection: 'Local CLI Bridge',
        endpoint: baseUrl,
        runner: profile.harness,
        runnerVersion: bridge.backend.version,
        provider: profile.model.provider ?? null,
        model: profile.model.default,
      },
      profile: {
        name: profile.name,
        reasoningEffort: profile.model.reasoningEffort,
        maxVisibleOutputTokens: profile.model.maxVisibleOutputTokens,
        maxReasoningTokens: profile.model.maxReasoningTokens,
        maxTotalOutputTokens: profile.model.maxTotalOutputTokens,
      },
      analysisProfile: {
        name: analystProfile.name,
        runner: analystProfile.harness,
        model: analystProfile.model.default,
        reasoningEffort: analystProfile.model.reasoningEffort,
        maxVisibleOutputTokens: analystProfile.model.maxVisibleOutputTokens,
        maxReasoningTokens: analystProfile.model.maxReasoningTokens,
        maxTotalOutputTokens: analystProfile.model.maxTotalOutputTokens,
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
        approvedPermissions: approvals,
        workspaceProof,
      },
      analysis: {
        question: LIVE_DEMO_QUESTION,
        runtimeManager: analysisRuntime.manager,
        pythonVersion: analysisRuntime.pythonVersion,
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

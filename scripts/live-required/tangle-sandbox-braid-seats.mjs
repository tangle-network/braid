// Live proof: one retained Tangle Sandbox run in the Braid terminal, granted stored secrets and an
// optional model seat by its connection. It records the run, the tool trace fidelity, the advertised
// interaction kinds, and a canary scan, then deletes the exact sandbox it created.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { Sandbox } from '@tangle-network/sandbox'
import { castFor, createCapturedTerminal, pause, typeText } from '../live-demo/terminal.mjs'
import { scanSecretArtifacts } from '../scan-secret-artifacts.mjs'
import { safeJson, safeMessage } from './contracts.mjs'
import {
  closeSession,
  configEvidence,
  initializedSession,
  prepareProductionWorkspace,
  resolveBinary,
  rpcRequest,
} from './headless.mjs'
import { sandboxConfiguration } from './tangle-sandbox-braid-multirun.mjs'
import { cleanupOwnedRetainedResources } from './tangle-sandbox-braid-stress.mjs'
import { permissionFormAnswer } from './tangle-sandbox-braid-stress-support.mjs'
import { transcriptSurfaceReady } from './terminal-screen.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const SCHEMA = 'braid-tangle-sandbox-seats-proof-v1'
const COLUMNS = 120
const ROWS = 40
const TERMINAL = new Set([
  'completed',
  'failed',
  'cancelled',
  'aborted',
  'expired',
  'blocked',
  'unknown',
])
const CONNECTION_SECRET_NAMES = [
  'TANGLE_API_KEY',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_BEARER',
]

function list(value) {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** The default check: the granted GitHub secret authenticates gh without printing it. */
export function seatsPrompt(ghSecret, marker) {
  return [
    'Use your shell tool to run each command below exactly as written, once, in order.',
    'Never print environment variables, tokens, or credential files.',
    `1. GH_TOKEN="$${ghSecret}" gh auth status; echo gh_auth_exit=$?`,
    `2. GH_TOKEN="$${ghSecret}" gh api repos/tangle-network/discovery-lab --jq .full_name; echo gh_api_exit=$?`,
    '3. echo braid-bash-ok',
    `Then reply with exactly ${marker} on the last line.`,
  ].join(' ')
}

function messagesForRun(state, runId) {
  return (state?.messages ?? []).filter((message) => message?.runId === runId)
}

function partsForRun(state, runId) {
  return messagesForRun(state, runId).flatMap((message) => message.parts ?? [])
}

function bytes(value) {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort()
    : []
}

function textOf(value) {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/**
 * Deterministic evidence from Braid's own recorded state: tool calls with their inputs and
 * results, the gh checks read from tool output rather than the model's summary, and the
 * interaction requests the provider sent. Content is reduced to sizes and booleans.
 */
export function seatsEvidence(record, runId, marker) {
  const messages = messagesForRun(record.state, runId)
  const assistant = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text ?? '')
    .join('\n')
  const tools = partsForRun(record.state, runId)
    .filter((part) => typeof part?.toolName === 'string')
    .map((part) => ({
      command: textOf(part.input?.command),
      output: `${textOf(part.result)}\n${part.kind === 'result' ? (part.text ?? '') : ''}`,
      trace: {
        kind: part.kind,
        name: part.toolName,
        status: part.status ?? null,
        inputKeys: objectKeys(part.input),
        inputBytes: bytes(part.input),
        resultBytes: bytes(part.result),
      },
    }))
  const ran = (fragment, proof) =>
    tools.some((tool) => tool.command.includes(fragment) && proof.test(tool.output))
  const interactionRequests = (record.events ?? [])
    .filter((event) => event.kind === 'run.interaction' && event.payload?.runId === runId)
    .map((event) => ({
      kind: event.payload.interaction?.kind ?? null,
      subject: event.payload.interaction?.subject?.toolName ?? null,
      fields: (event.payload.interaction?.answerSpec?.fields ?? []).map((field) => field.name),
    }))
  return {
    modelTurnReached: assistant.trim().length > 0,
    markerReturned: assistant.split('\n').some((line) => line.trim() === marker),
    ghAuthenticated: ran(
      'gh auth status',
      /gh_auth_exit=0\b|exit_code=0\b|Logged in to github\.com/u,
    ),
    ghApiFullName: ran(
      'gh api repos/tangle-network/discovery-lab',
      /(^|\n)tangle-network\/discovery-lab(\n|$)/u,
    ),
    bashOk: ran('braid-bash-ok', /braid-bash-ok/u),
    toolTrace: {
      calls: tools.map((tool) => tool.trace),
      callsWithInput: tools.filter((tool) => tool.trace.inputBytes > 2).length,
      callsWithResult: tools.filter((tool) => tool.trace.resultBytes > 2).length,
    },
    interactionRequests,
    advertisedInteractions: advertisedInteractions(record.events),
  }
}

/** The first interaction capability document any journaled event carries. */
function advertisedInteractions(events) {
  const seen = new Set()
  const search = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 8 || seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value?.interactions?.kinds)) return value.interactions
    for (const child of Object.values(value)) {
      const found = search(child, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const event of events ?? []) {
    const found = search(event.payload, 0)
    if (found !== undefined) return found
  }
  return null
}

function formShape(interaction) {
  return (interaction.answerSpec?.fields ?? []).map((field) => ({
    name: field.name,
    type: field.type,
    required: field.required === true,
    options: field.options?.map((option) => option.value) ?? [],
  }))
}

/**
 * Follow the run through state frames. Each pending permission is answered once through the
 * terminal form, the way a user answers it, and recorded in the receipt.
 */
async function waitForTerminalRun(terminal, timeoutMs, observed) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = await terminal.captureState(30_000).catch(() => undefined)
    const run = frame?.state?.runs?.at(-1)
    if (run !== undefined) {
      observed.runId = run.id
      if (run.controlRef !== undefined) observed.controlRef = run.controlRef
      if (TERMINAL.has(run.status)) return frame
    }
    const pending = (frame?.view?.interactions ?? []).find(
      (interaction) => !observed.answered.has(interaction.interactionId),
    )
    if (pending !== undefined) {
      observed.answered.add(pending.interactionId)
      const answer = permissionFormAnswer(pending)
      observed.interactions.push({
        kind: pending.kind,
        allowedOutcomes: pending.allowedOutcomes,
        form: formShape(pending),
        answered: answer !== undefined,
      })
      if (answer === undefined) throw new Error(`The proof cannot answer a ${pending.kind} request`)
      await terminal.waitForStable('interaction form')
      await typeText(terminal, JSON.stringify(answer), 4)
      terminal.input('\r')
      await terminal.waitForStable('interaction answer').catch(() => undefined)
      continue
    }
    await pause(3_000)
  }
  throw new Error(`The run did not reach a terminal state within ${timeoutMs} ms`)
}

async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600 })
}

/**
 * Read the decrypted journal through Braid's own production storage after the terminal exits.
 * The saved connection must keep its granted names and seat reference, and no event may hold a
 * canary value.
 */
async function journalEvidence(config, { secrets, modelCredentials, canaries, runId }) {
  const previousDirectory = process.cwd()
  const previousEnvironment = { ...process.env }
  const dist = (path) => import(pathToFileURL(join(repository, 'dist', path)).href)
  Object.assign(process.env, config.environment)
  process.chdir(config.workspace)
  let opened
  try {
    const [startup, production, application, statePath, providerValues] = await Promise.all([
      dist('bin/runtime-startup-options.js'),
      dist('bin/production-startup.js'),
      dist('bin/production-application.js'),
      dist('bin/state-path.js'),
      dist('domain/provider-values.js'),
    ])
    const { startupOptions } = startup.createRuntimeStartupOptions({}, config.workspace)
    const loaded = await production.loadProductionStartup(startupOptions)
    const effective =
      startupOptions.databaseKeyFile === undefined && loaded.databaseKeyFile !== undefined
        ? { ...startupOptions, databaseKeyFile: loaded.databaseKeyFile }
        : startupOptions
    opened = await application.openProductionApplication({
      workspace: effective.workspace,
      statePath: statePath.defaultStatePath(effective.workspace, effective.configPath),
      startupOptions: effective,
      production: loaded,
    })
    // Restored state is what the next process trusts; the event list holds only this session.
    const state = opened.app.state()
    const serialized = JSON.stringify({ state, events: opened.app.events() })
    const stored = state.connections.find(
      (connection) => connection.id === config.connection.id,
    )?.providerOptions
    const run = state.runs.find((candidate) => candidate.id === runId)
    return {
      run: run
        ? {
            id: run.id,
            status: run.status,
            error: run.error ?? null,
            reason: run.terminalReason ?? null,
            outcomeDetail: providerValues.runOutcomeDetail(run) ?? null,
          }
        : null,
      source: 'restored-state',
      connectionRestored: stored !== undefined,
      grantedNamesKept: JSON.stringify(stored?.secrets ?? []) === JSON.stringify(secrets),
      seatReferenceKept: isDeepStrictEqual(
        stored?.modelCredentials ?? null,
        modelCredentials ?? null,
      ),
      canaryMatches: canaries.filter((canary) => serialized.includes(canary)).length,
    }
  } finally {
    await opened?.close().catch(() => undefined)
    process.chdir(previousDirectory)
    for (const name of Object.keys(process.env)) {
      if (!Object.hasOwn(previousEnvironment, name)) delete process.env[name]
    }
    Object.assign(process.env, previousEnvironment)
  }
}

/** Recompute the record evidence of an existing receipt from the record its run saved. */
export async function reevaluateSeatsReceipt(receiptPath, recordPath) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const marker = `BRAID_SEATS_${receipt.label.toUpperCase().replaceAll('-', '_')}_DONE`
  const evidence = seatsEvidence(record, receipt.run.id, marker)
  const updated = {
    ...receipt,
    ...evidence,
    ...(receipt.journal?.source === 'restored-state'
      ? {}
      : {
          journal: {
            measured: false,
            reason:
              'This run read the session event list, not restored state; test/tangle-connection-seats.test.ts proves the restored SQLite state',
          },
        }),
    modelTurnReached: receipt.run.status === 'completed' && evidence.modelTurnReached,
    evaluatedFromRecord: new Date().toISOString(),
  }
  await writePrivate(receiptPath, `${safeJson(updated)}\n`)
  return updated
}

async function readResolverEvidence(path, proofId) {
  const bytes = await readFile(path, 'utf8')
  if (Buffer.byteLength(bytes) > 65536)
    throw new Error('The resolver receipt exceeds its evidence bound')
  const calls = bytes
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((call) => call.proofId === proofId)
  return { measured: calls.length > 0, calls }
}

export async function runSeatsProof(environment = process.env) {
  const label = environment.BRAID_SEATS_LABEL ?? `run-${Date.now()}`
  if (!/^[a-z0-9-]{1,64}$/u.test(label)) throw new Error('BRAID_SEATS_LABEL must be a short slug')
  const outputDirectory = resolve(
    environment.BRAID_SEATS_OUTPUT ??
      join(repository, 'artifacts', 'verification', 'live', 'tangle-sandbox-braid-seats'),
  )
  const secrets = list(environment.BRAID_SEATS_SECRETS)
  const ghSecret = environment.BRAID_SEATS_GH_SECRET ?? secrets[0]
  if (ghSecret === undefined && environment.BRAID_SEATS_PROMPT === undefined) {
    throw new Error('BRAID_SEATS_SECRETS must name the GitHub secret for the default prompt')
  }
  const modelCredentials =
    environment.BRAID_SEATS_MODEL_CREDENTIALS === undefined
      ? undefined
      : JSON.parse(environment.BRAID_SEATS_MODEL_CREDENTIALS)
  const authoredProfile =
    environment.BRAID_SEATS_PROFILE === undefined
      ? undefined
      : JSON.parse(await readFile(environment.BRAID_SEATS_PROFILE, 'utf8'))
  const timeoutMs = Number(environment.BRAID_SEATS_TIMEOUT_MS ?? 600_000)
  // Values only feed the canary scan and the cleanup client; they never reach the Braid child.
  const canaryNames = list(environment.BRAID_SEATS_CANARY_ENV ?? 'DREW_GH_TOKEN,TANGLE_API_KEY')
  const canaries = canaryNames.map((name) => environment[name]).filter((value) => value?.length)
  if (canaries.length !== canaryNames.length) throw new Error('A canary variable is unset')
  const sandbox = sandboxConfiguration(environment)
  const cleanupKey = sandbox.credentialValue ?? environment.TANGLE_API_KEY
  const childEnvironment = { ...environment }
  for (const name of [...canaryNames, ...CONNECTION_SECRET_NAMES]) delete childEnvironment[name]
  for (const name of [...canaryNames, ...CONNECTION_SECRET_NAMES]) delete process.env[name]

  const marker = `BRAID_SEATS_${label.toUpperCase().replaceAll('-', '_')}_DONE`
  const prompt = environment.BRAID_SEATS_PROMPT ?? seatsPrompt(ghSecret, marker)
  const providerOptions = {
    lifecycle: 'retained',
    idleTtlSeconds: 1_800,
    ...(secrets.length === 0 ? {} : { secrets }),
    ...(modelCredentials === undefined ? {} : { modelCredentials }),
  }
  const cleanupClient = new Sandbox({ baseUrl: sandbox.endpoint, apiKey: cleanupKey })
  const startedAt = new Date().toISOString()
  const result = {
    schema: SCHEMA,
    label,
    startedAt,
    proofId: randomUUID(),
    // Field names avoid the receipt's key-based redaction; the values are names and references.
    grantedNames: secrets,
    seatReference: modelCredentials ?? null,
  }
  childEnvironment.BRAID_SEATS_PROOF_ID = result.proofId
  let config
  let terminal
  let cast
  const observed = {
    runId: undefined,
    controlRef: undefined,
    answered: new Set(),
    interactions: [],
  }
  try {
    config = await prepareProductionWorkspace({
      repository,
      environment: childEnvironment,
      kind: 'tangle-sandbox',
      endpoint: sandbox.endpoint,
      model: authoredProfile?.model?.default ?? sandbox.model,
      runner: authoredProfile?.harness ?? sandbox.runner,
      modelProvider: authoredProfile?.model?.provider ?? sandbox.modelProvider,
      ...(authoredProfile === undefined ? {} : { profile: authoredProfile }),
      providerOptions,
      ...(sandbox.credentialRef === undefined ? {} : { credentialRef: sandbox.credentialRef }),
      ...(sandbox.credentialValue === undefined
        ? {}
        : { credentialValue: sandbox.credentialValue }),
    })
    result.config = configEvidence(config)
    result.profile = {
      name: config.profile.name,
      version: config.profile.version ?? null,
      harness: config.profile.harness,
      model: config.profile.model?.default,
      seatSource: config.profile.model?.metadata?.credentialSource ?? 'managed',
    }
    const binary = await resolveBinary(repository, childEnvironment)
    const recordPath = join(config.root, 'interface-state.json')
    terminal = await createCapturedTerminal({
      binary,
      args: ['--inline', '--record-state', recordPath],
      columns: COLUMNS,
      rows: ROWS,
      cwd: config.workspace,
      environment: config.environment,
      recordPath,
    })
    await terminal.waitForScreen(transcriptSurfaceReady, 'Braid transcript surface', 60_000)
    await typeText(terminal, prompt, 4)
    terminal.input('\r')
    const frame = await waitForTerminalRun(terminal, timeoutMs, observed)
    const run = frame.state.runs.at(-1)
    const runId = run.id
    const controlRef = observed.controlRef
    await terminal.waitForStable('settled transcript')
    result.screen = terminal.snapshot().screen
    await terminal.closeNormally()
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    const finalRun = record.state.runs.find((candidate) => candidate.id === runId) ?? run
    if (environment.BRAID_SEATS_RECORD_COPY !== undefined) {
      await writePrivate(resolve(environment.BRAID_SEATS_RECORD_COPY), JSON.stringify(record))
    }
    result.run = {
      id: runId,
      status: finalRun.status,
      model: finalRun.model ?? null,
      runner: finalRun.runner ?? null,
      error: finalRun.error === undefined ? null : safeMessage(finalRun.error, environment),
      reason: finalRun.reason === undefined ? null : safeMessage(finalRun.reason, environment),
      sandboxId: controlRef?.environmentId ?? finalRun.environmentId ?? null,
      inputTokens: finalRun.inputTokens,
      outputTokens: finalRun.outputTokens,
    }
    Object.assign(result, seatsEvidence(record, runId, marker))
    result.modelTurnReached = finalRun.status === 'completed' && result.modelTurnReached
    result.journal = await journalEvidence(config, { secrets, modelCredentials, canaries, runId })
    if (result.journal.run === null)
      throw new Error('The encrypted journal did not restore the same run')
    Object.assign(result.run, result.journal.run)
    const refused = record.events.findLast(
      (event) => event.kind === 'run.unknown' && event.payload?.runId === runId,
    )?.payload?.error
    if (refused && result.run.outcomeDetail !== refused)
      throw new Error('The restored cause differs from the recorded provider refusal')
    const headless = await initializedSession(binary, config)
    try {
      const response = await rpcRequest(headless.session, 'get_details', {
        entityType: 'run',
        entityId: runId,
      })
      const detail = response.result?.data
      if (
        detail?.status !== result.run.status ||
        (detail?.error ?? null) !== result.run.error ||
        (detail?.terminalReason ?? null) !== result.run.reason ||
        (detail?.outcomeDetail ?? null) !== result.run.outcomeDetail
      )
        throw new Error('Headless details did not restore the same run outcome and cause')
      const restoredRun = headless.state.state.runs.find((candidate) => candidate.id === runId)
      if ((restoredRun?.outcomeDetail ?? null) !== result.run.outcomeDetail)
        throw new Error('Headless full state did not preserve the recorded cause')
      result.headless = {
        runId,
        status: detail.status,
        causeMatchesJournal: true,
        outcomeDetail: detail.outcomeDetail ?? null,
      }
    } finally {
      await closeSession(headless.session)
    }
    cast = castFor(terminal, `Braid ${label}`, 'braid --inline')
    result.captures = []
    for (const [columns, rows] of [
      [40, 12],
      [80, 24],
      [120, 40],
      [200, 60],
    ]) {
      const capturePath = join(config.root, `restored-${columns}x${rows}.json`)
      const restored = await createCapturedTerminal({
        binary,
        args: ['--inline', '--record-state', capturePath],
        columns,
        rows,
        cwd: config.workspace,
        environment: config.environment,
        recordPath: capturePath,
      })
      try {
        await restored.waitForScreen(transcriptSurfaceReady, 'restored transcript surface', 60_000)
        const restoredFrame = await restored.captureState(30_000)
        const restoredRun = restoredFrame.state.runs.find((candidate) => candidate.id === runId)
        if (restoredRun?.status !== finalRun.status)
          throw new Error('The packed client did not restore the same run')
        await restored.waitForStable('restored transcript')
        const screen = restored.snapshot().screen
        const recording = castFor(restored, `Braid ${label} ${columns}x${rows}`, 'braid --inline')
        if (canaries.some((canary) => screen.includes(canary) || recording.includes(canary))) {
          throw new Error('A restored capture contains a canary')
        }
        await writePrivate(join(outputDirectory, `${label}-${columns}x${rows}.txt`), screen)
        await writePrivate(join(outputDirectory, `${label}-${columns}x${rows}.cast`), recording)
        result.captures.push({ columns, rows, runId, status: restoredRun.status })
        await restored.closeNormally()
      } finally {
        await restored.dispose()
      }
    }
  } catch (error) {
    result.failure = safeMessage(error, environment)
    result.screen = terminal?.snapshot().screen
    const frame = await terminal?.captureState(10_000).catch(() => undefined)
    const lastRun = frame?.state?.runs?.at(-1)
    if (lastRun !== undefined) {
      result.lastRun = {
        id: lastRun.id,
        status: lastRun.status,
        error: lastRun.error === undefined ? null : safeMessage(lastRun.error, environment),
        completeness: lastRun.completeness ?? null,
      }
    }
    if (frame !== undefined && environment.BRAID_SEATS_RECORD_COPY !== undefined) {
      await writePrivate(resolve(environment.BRAID_SEATS_RECORD_COPY), JSON.stringify(frame))
    }
    if (terminal !== undefined) cast = castFor(terminal, `Braid ${label}`, 'braid --inline')
  } finally {
    await terminal?.dispose().catch(() => undefined)
    result.sandboxId = observed.controlRef?.environmentId ?? null
    result.interactions = observed.interactions
    try {
      result.cleanup =
        observed.runId !== undefined || observed.controlRef !== undefined
          ? await cleanupOwnedRetainedResources(cleanupClient, {
              controlRef: observed.controlRef,
              firstRunId: observed.runId,
            })
          : { skipped: 'no run was admitted' }
    } catch (error) {
      result.cleanup = { failed: safeMessage(error, environment) }
    }
    if (config !== undefined) {
      const matches = await scanSecretArtifacts(config.root, canaries).catch((error) => [
        { failed: safeMessage(error, environment) },
      ])
      result.canaryScan = {
        canaries: canaryNames,
        root: matches,
        cast: canaries.filter((canary) => cast?.includes(canary)).length,
      }
      await config.cleanup().catch(() => undefined)
    }
    if (environment.BRAID_SEATS_RESOLVER_RECEIPT !== undefined) {
      try {
        result.seatResolver = await readResolverEvidence(
          environment.BRAID_SEATS_RESOLVER_RECEIPT,
          result.proofId,
        )
      } catch (error) {
        const failure = safeMessage(error, environment)
        result.seatResolver = { measured: false, failure }
        result.failure ??= failure
      }
    }
    result.finishedAt = new Date().toISOString()
  }
  const serialized = `${safeJson(result, environment)}\n`
  if (canaries.some((canary) => serialized.includes(canary))) {
    throw new Error('The seats receipt contains a canary value; refusing to write it')
  }
  await writePrivate(join(outputDirectory, `${label}.json`), serialized)
  if (cast !== undefined && !canaries.some((canary) => cast.includes(canary))) {
    await writePrivate(join(outputDirectory, `${label}.cast`), cast)
  }
  return result
}

if (process.argv[1] === scriptPath) {
  const evaluate = process.argv.indexOf('--evaluate-record')
  const result =
    evaluate === -1
      ? await runSeatsProof()
      : await reevaluateSeatsReceipt(process.argv[evaluate + 1], process.argv[evaluate + 2])
  const passed =
    result.failure === undefined &&
    result.modelTurnReached === true &&
    result.markerReturned === true &&
    result.bashOk === true &&
    result.journal?.seatReferenceKept === true &&
    result.headless?.causeMatchesJournal === true &&
    result.cleanup?.confirmed === true &&
    result.canaryScan?.root?.length === 0 &&
    result.canaryScan?.cast === 0 &&
    (result.journal?.canaryMatches ?? 0) === 0
  process.stdout.write(
    `${JSON.stringify({
      label: result.label,
      status: result.run?.status ?? 'not-admitted',
      sandboxId: result.run?.sandboxId ?? result.sandboxId ?? null,
      modelTurnReached: result.modelTurnReached ?? false,
      ghAuthenticated: result.ghAuthenticated ?? false,
      ghApiFullName: result.ghApiFullName ?? false,
      bashOk: result.bashOk ?? false,
      cleanup: result.cleanup,
      failure: result.failure ?? null,
    })}\n`,
  )
  process.exitCode = passed ? 0 : 1
}

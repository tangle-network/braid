// Live proof: one retained Tangle Sandbox run in the Braid terminal, granted stored secrets and an
// optional model seat by its connection. It records the run, the tool trace fidelity, the advertised
// interaction kinds, and a canary scan, then deletes the exact sandbox it created.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Sandbox } from '@tangle-network/sandbox'
import { castFor, createCapturedTerminal, pause, typeText } from '../live-demo/terminal.mjs'
import { scanSecretArtifacts } from '../scan-secret-artifacts.mjs'
import { safeJson, safeMessage } from './contracts.mjs'
import { configEvidence, prepareProductionWorkspace, resolveBinary } from './headless.mjs'
import { sandboxConfiguration, transcriptSurfaceReady } from './tangle-sandbox-braid-multirun.mjs'
import {
  cleanupRetainedResourceByControlRef,
  cleanupRetainedResourceByRunId,
} from './tangle-sandbox-braid-stress.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repository = resolve(dirname(scriptPath), '../..')
const SCHEMA = 'braid-tangle-sandbox-seats-proof-v1'
const COLUMNS = 120
const ROWS = 40
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'aborted', 'expired', 'blocked'])
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
    'Use your shell tool. Run each command below exactly once, in order, and report each exit code on its own line.',
    'Never print environment variables, tokens, or credential files.',
    `1. GH_TOKEN="$${ghSecret}" gh auth status`,
    `2. GH_TOKEN="$${ghSecret}" gh api repos/tangle-network/discovery-lab --jq .full_name`,
    '3. echo braid-bash-ok',
    `Then reply with exactly ${marker} on the last line.`,
  ].join(' ')
}

function messagesForRun(state, runId) {
  return (state?.messages ?? []).filter((message) => message?.runId === runId)
}

/** Summarize tool parts without copying their content into the receipt. */
export function toolTraceEvidence(state, runId) {
  const parts = messagesForRun(state, runId).flatMap((message) => message.parts ?? [])
  const calls = parts
    .filter((part) => part?.kind === 'tool-call')
    .map((part) => {
      const input =
        part.arguments && typeof part.arguments === 'object' && !Array.isArray(part.arguments)
          ? part.arguments
          : {}
      return {
        name: part.name,
        status: part.status,
        callId: typeof part.callId === 'string',
        inputKeys: Object.keys(input).sort(),
        inputBytes: Buffer.byteLength(JSON.stringify(input)),
      }
    })
  const results = parts
    .filter((part) => part?.kind === 'tool-result')
    .map((part) => ({
      status: part.status,
      callId: typeof part.callId === 'string',
      summaryBytes: Buffer.byteLength(part.summary ?? ''),
      outputBytes: part.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(part.output)),
    }))
  return {
    calls,
    results,
    callsWithInput: calls.filter((call) => call.inputBytes > 2).length,
    resultsWithContent: results.filter((result) => result.summaryBytes + result.outputBytes > 0)
      .length,
  }
}

function runText(state, runId) {
  const messages = messagesForRun(state, runId)
  const text = messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text ?? '')
    .join('\n')
  const tools = messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part?.kind === 'tool-result')
    .map((part) => `${part.summary ?? ''}\n${JSON.stringify(part.output ?? '')}`)
    .join('\n')
  return { assistant: text, all: `${text}\n${tools}` }
}

async function waitForTerminalRun(terminal, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let frame
  while (Date.now() < deadline) {
    frame = await terminal.captureState(30_000).catch(() => undefined)
    const run = frame?.state?.runs?.at(-1)
    if (run !== undefined && TERMINAL.has(run.status)) return frame
    await pause(5_000)
  }
  throw new Error(`The run did not reach a terminal state within ${timeoutMs} ms`)
}

async function writePrivate(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, content, { mode: 0o600 })
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
  if (ghSecret === undefined) throw new Error('BRAID_SEATS_SECRETS must name the GitHub secret')
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
    secrets,
    ...(modelCredentials === undefined ? {} : { modelCredentials }),
  }
  const cleanupClient = new Sandbox({ baseUrl: sandbox.endpoint, apiKey: cleanupKey })
  const startedAt = new Date().toISOString()
  const result = {
    schema: SCHEMA,
    label,
    startedAt,
    proofId: randomUUID(),
    secretNames: secrets,
    modelCredentials: modelCredentials ?? null,
  }
  let config
  let terminal
  let controlRef
  let runId
  let cast
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
      credentialSource: config.profile.model?.metadata?.credentialSource ?? null,
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
    const frame = await waitForTerminalRun(terminal, timeoutMs)
    const run = frame.state.runs.at(-1)
    runId = run.id
    controlRef = run.controlRef
    await terminal.waitForStable('settled transcript')
    result.screen = terminal.snapshot().screen
    await terminal.closeNormally()
    const record = JSON.parse(await readFile(recordPath, 'utf8'))
    const finalRun = record.state.runs.find((candidate) => candidate.id === runId) ?? run
    const text = runText(record.state, runId)
    result.run = {
      id: runId,
      status: finalRun.status,
      model: finalRun.model ?? null,
      error: finalRun.error === undefined ? null : safeMessage(finalRun.error, environment),
      sandboxId: controlRef?.environmentId ?? finalRun.environmentId ?? null,
      providerSessionId: finalRun.providerSessionId ?? null,
      inputTokens: finalRun.inputTokens,
      outputTokens: finalRun.outputTokens,
      advertisedInteractions: finalRun.capabilities?.environment?.interactions ?? null,
      interactionCapabilities: finalRun.capabilities?.environment?.interactiveAgent ?? null,
    }
    result.modelTurnReached = finalRun.status === 'completed' && text.assistant.trim().length > 0
    result.markerReturned = text.assistant.split('\n').some((line) => line.trim() === marker)
    result.ghAuthenticated = /Logged in to github\.com/iu.test(text.all)
    result.ghApiFullName = text.all.includes('tangle-network/discovery-lab')
    result.bashOk = text.all.includes('braid-bash-ok')
    result.toolTrace = toolTraceEvidence(record.state, runId)
    result.journal = {
      events: record.events.length,
      connectionSecretNamesKept:
        JSON.stringify(record.state.connections?.[0]?.providerOptions?.secrets ?? null) ===
        JSON.stringify(secrets),
    }
    cast = castFor(terminal, `Braid ${label}`, 'braid --inline')
  } catch (error) {
    result.failure = safeMessage(error, environment)
    result.screen = terminal?.snapshot().screen
    if (terminal !== undefined) cast = castFor(terminal, `Braid ${label}`, 'braid --inline')
  } finally {
    await terminal?.dispose().catch(() => undefined)
    try {
      result.cleanup =
        controlRef !== undefined
          ? await cleanupRetainedResourceByControlRef(cleanupClient, controlRef)
          : runId !== undefined
            ? await cleanupRetainedResourceByRunId(cleanupClient, runId)
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
  const result = await runSeatsProof()
  const passed =
    result.failure === undefined &&
    result.modelTurnReached === true &&
    result.canaryScan?.root?.length === 0 &&
    result.canaryScan?.cast === 0
  process.stdout.write(
    `${JSON.stringify({
      label: result.label,
      status: result.run?.status ?? 'not-admitted',
      sandboxId: result.run?.sandboxId ?? null,
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

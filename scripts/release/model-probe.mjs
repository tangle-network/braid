import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { installPackedBraid } from '../packed-binary.mjs'
import { readCandidateIdentity } from './build-identity.mjs'
import { connectionConfiguration } from '../live-required/configuration.mjs'
import { safeMessage } from '../live-required/contracts.mjs'
import {
  closeSession,
  prepareProductionWorkspace,
  runHeadlessTurn,
} from '../live-required/headless.mjs'

const model = 'gemini-2.5-flash-lite'
const marker = 'BRAID_GEMINI_PROBE_OK'
const mode = process.env.BRAID_PROBE_MODE ?? 'braid'
if (mode !== 'raw' && mode !== 'braid') throw new Error('Unknown probe mode')
const source = resolve(process.env.BRAID_PROBE_SOURCE ?? '')
const artifactRoot = resolve(process.env.BRAID_PROBE_ARTIFACT_ROOT ?? '')
const commit = process.env.BRAID_PROBE_COMMIT
const rawSecret = process.env.BRAID_LIVE_TANGLE_ENV_JSON
if (!/^[a-f0-9]{40}$/u.test(commit ?? '') || !rawSecret) {
  throw new Error('Exact candidate commit and protected environment are required')
}
const protectedEnvironment = JSON.parse(rawSecret)
if (
  protectedEnvironment === null ||
  typeof protectedEnvironment !== 'object' ||
  Array.isArray(protectedEnvironment)
) {
  throw new Error('Protected environment is invalid')
}
const environment = { ...process.env, ...protectedEnvironment }
delete environment.BRAID_LIVE_TANGLE_ENV_JSON
const values = connectionConfiguration(environment, {
  prefix: 'BRAID_TANGLE',
  kind: 'tangle-inference',
  endpointNames: ['BRAID_TANGLE_INFERENCE_ENDPOINT'],
  modelNames: ['BRAID_TANGLE_INFERENCE_MODEL'],
  runnerNames: ['BRAID_TANGLE_INFERENCE_RUNNER'],
  providerNames: ['BRAID_TANGLE_INFERENCE_PROVIDER'],
  fallbackModelProvider: 'tangle-router',
  fallbackRunner: 'cli-base',
})
if (values.credentialValue === undefined) {
  throw new Error('Probe requires the existing protected credential value')
}
if (values.modelProvider !== 'tangle-router') {
  throw new Error('Protected credential is not configured for Tangle Router')
}
const catalogUrl = new URL('/v1/models', values.endpoint)
const auth = values.credentialValue.replace(/^Bearer\s+/iu, '')
const catalogResponse = await fetch(catalogUrl, {
  headers: { Authorization: `Bearer ${auth}` },
  signal: AbortSignal.timeout(10_000),
})
if (!catalogResponse.ok) {
  throw new Error(`Model catalog returned HTTP ${catalogResponse.status}`)
}
const catalog = await catalogResponse.json()
if (!Array.isArray(catalog.data) || !catalog.data.some((item) => item?.id === model)) {
  throw new Error('Model catalog does not list the selected model')
}
const { identity } = await readCandidateIdentity({
  repository: source,
  artifactRoot,
  expectedCommit: commit,
  expectedVersion: '0.3.4',
})
if (mode === 'raw') {
  const response = await fetch(new URL('/v1/chat/completions', values.endpoint), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `braid-model-probe-${randomUUID()}`,
      'X-Tangle-Client': 'braid-release-probe/0.3.4',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'Follow the release prompt exactly and return the requested marker.',
        },
        { role: 'user', content: `Reply with exactly ${marker}.` },
      ],
      max_tokens: 32,
      max_completion_tokens: 64,
      reasoning_effort: 'none',
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json().catch(() => null)
  const costHeader = Number(response.headers.get('x-tangle-cost-usd'))
  const costUsd =
    Number.isFinite(costHeader) && costHeader >= 0 && response.headers.has('x-tangle-cost-usd')
      ? costHeader
      : null
  const diagnostic = {
    schema: 'braid.release-model-raw-probe.v1',
    commit,
    tarballSha256: identity.tarballSha256,
    requestedModel: model,
    httpStatus: response.status,
    generationId: response.headers.get('x-generation-id'),
    servedModel: response.headers.get('x-tangle-served-model') ?? body?.model ?? null,
    costUsd,
    promptTokens: body?.usage?.prompt_tokens ?? null,
    completionTokens: body?.usage?.completion_tokens ?? null,
    errorCode: body?.error?.code ?? null,
    errorMessage: response.ok
      ? null
      : safeMessage(body?.error?.message ?? 'unknown Router error', environment),
    maxVisibleOutputTokens: 32,
    maxTotalOutputTokens: 64,
  }
  process.stdout.write(`${JSON.stringify(diagnostic)}\n`)
  if (!response.ok || (costUsd !== null && costUsd > 0.01)) process.exitCode = 1
} else {
  const packed = await installPackedBraid(source, {
    tarballPath: join(artifactRoot, identity.tarballPath),
  })
  let config
  let session
  try {
    if (packed.tarballSha256 !== identity.tarballSha256) {
      throw new Error('Installed archive differs from the candidate')
    }
    config = await prepareProductionWorkspace({
      repository: source,
      environment,
      ...values,
      model,
    })
    const profilePath = join(
      config.workspace,
      '.braid',
      'profiles',
      'profile-tangle-inference.json',
    )
    const profile = JSON.parse(await readFile(profilePath, 'utf8'))
    profile.model.maxVisibleOutputTokens = 32
    profile.model.maxTotalOutputTokens = 64
    await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
    process.env.BRAID_LIVE_REQUIRED_TIMEOUT_MS = '60000'
    const turn = await runHeadlessTurn({
      binary: packed.binary,
      config,
      marker,
      prompt: `Reply with exactly ${marker}.`,
    })
    session = turn.session
    const receipt = {
      schema: 'braid.release-model-probe.v1',
      commit,
      version: identity.braidVersion,
      tarballSha256: packed.tarballSha256,
      model: turn.run.model ?? model,
      status: turn.run.status,
      runId: turn.run.id,
      materializationDigest: turn.run.materializationDigest,
      costStatus: turn.run.costStatus ?? 'unknown',
      costUsd: turn.run.costUsd ?? null,
      maxVisibleOutputTokens: 32,
      maxTotalOutputTokens: 64,
      markerMatched: true,
    }
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
    if (typeof receipt.costUsd === 'number' && receipt.costUsd > 0.01) {
      throw new Error('One-turn cost exceeded the $0.01 probe ceiling')
    }
  } catch (error) {
    process.stderr.write(`Protected model probe failed: ${safeMessage(error, environment)}\n`)
    process.exitCode = 1
  } finally {
    if (session) await closeSession(session)
    if (config) await config.cleanup()
    await packed.cleanup()
  }
}

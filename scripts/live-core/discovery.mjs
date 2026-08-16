import assert from 'node:assert/strict'

const DEFAULT_ENDPOINT = 'http://127.0.0.1:3344'
const CODEX_PREFERENCES = ['codex/default', 'codex/gpt-5.6', 'codex/gpt-5.5']
const KNOWN_UNAVAILABLE_MODELS = new Map([
  [
    'pi/openai-codex/gpt-5.6-luna',
    {
      code: 'MODEL_NOT_CONFIGURED',
      detail:
        'Prior live probe returned HTTP 501 in 4.51s because the local Pi OpenAI refresh token was reused; the model is retained as unavailable evidence',
      observation: { httpStatus: 501, elapsedMs: 4510, source: 'prior-live-probe' },
    },
  ],
])

export async function readJson(endpoint, path, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${endpoint}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body}`)
    return JSON.parse(body)
  } finally {
    clearTimeout(timer)
  }
}

function unavailable(runner, model, code, detail, observation) {
  return {
    runner,
    ...(model === undefined ? {} : { model }),
    status: 'unavailable',
    code,
    detail,
    ...(observation === undefined ? {} : { observation }),
  }
}

function modelFor(models, backend, preferences) {
  const candidates = models.filter((model) => model.backend === backend)
  for (const preferred of preferences) {
    const found = candidates.find((model) => model.id === preferred)
    if (found) return found
  }
  return candidates[0]
}

function backendStatus(health, backend) {
  return health.backends?.find((candidate) => candidate?.name === backend)
}

export function chooseRunnerTargets(health, catalog) {
  const models = Array.isArray(catalog?.data)
    ? catalog.data.filter(
        (model) => model && typeof model.id === 'string' && typeof model.backend === 'string',
      )
    : []
  const backends = [...new Set(models.map((model) => model.backend))].sort()
  const preferred = []
  const pi = modelFor(models, 'pi', [])
  const codex = modelFor(models, 'codex', CODEX_PREFERENCES)
  if (pi) preferred.push({ runner: 'pi', model: pi.id, selection: 'health-discovered-pi' })
  if (codex) preferred.push({ runner: 'codex', model: codex.id, selection: 'preferred-codex' })

  const selected =
    preferred.length > 0
      ? preferred
      : backends.map((runner) => {
          const model = modelFor(models, runner, [])
          return { runner, ...(model ? { model: model.id } : {}), selection: 'advertised-fallback' }
        })
  const targets = selected.map((candidate) => {
    const status = backendStatus(health, candidate.runner)
    if (!status)
      return unavailable(
        candidate.runner,
        candidate.model,
        'RUNNER_NOT_READY',
        'The bridge catalog advertised this runner, but /health did not report it',
      )
    if (status.state !== 'ready')
      return unavailable(
        candidate.runner,
        candidate.model,
        'RUNNER_NOT_READY',
        `The bridge reported ${status.state ?? 'unknown'} for this runner`,
      )
    if (!candidate.model)
      return unavailable(
        candidate.runner,
        undefined,
        'MODEL_NOT_ADVERTISED',
        'The runner has no model in the bridge catalog',
      )
    return { ...candidate, status: 'selected', backendVersion: status.version }
  })

  const selectedRunners = new Set(selected.map((candidate) => candidate.runner))
  const inventory = backends
    .map((runner) => {
      if (selectedRunners.has(runner)) return undefined
      const status = backendStatus(health, runner)
      const model = modelFor(models, runner, [])
      return unavailable(
        runner,
        model?.id,
        status?.state === 'ready' ? 'RUNNER_NOT_SELECTED' : 'RUNNER_NOT_READY',
        status?.state === 'ready'
          ? 'A preferred Pi or Codex target was available; this advertised runner was not needed for this proof'
          : `The bridge reported ${status?.state ?? 'unknown'} for this runner`,
      )
    })
    .filter(Boolean)
  const selectedModels = new Set(selected.map((candidate) => candidate.model).filter(Boolean))
  for (const model of models) {
    if (selectedModels.has(model.id)) continue
    const known = KNOWN_UNAVAILABLE_MODELS.get(model.id)
    if (!known) continue
    inventory.push(
      unavailable(model.backend, model.id, known.code, known.detail, known.observation),
    )
  }
  return { targets, inventory, models: models.map(({ id, backend }) => ({ id, backend })) }
}

export async function discover(endpoint = DEFAULT_ENDPOINT) {
  const health = await readJson(endpoint, '/health')
  assert.equal(health?.status, 'ok', `CLI Bridge health is not ok: ${JSON.stringify(health)}`)
  const catalog = await readJson(endpoint, '/v1/models')
  return { endpoint, health, catalog, ...chooseRunnerTargets(health, catalog) }
}

export { DEFAULT_ENDPOINT }

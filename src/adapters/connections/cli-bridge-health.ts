import type { ConnectionHealth, IsoDateTime } from '../../domain/entities.js'

export interface CliBridgeHealthParse {
  readonly health: ConnectionHealth
  readonly diagnostic?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function statusHealth(status: number, checkedAt: IsoDateTime): ConnectionHealth {
  if (status === 401 || status === 403) {
    return {
      status: 'unauthorized',
      checkedAt,
      message: 'The bridge rejected optional authentication',
    }
  }
  if (status === 429) {
    return {
      status: 'rate-limited',
      checkedAt,
      message: 'The bridge rate-limited the health check',
    }
  }
  if (status >= 400 && status < 500) {
    return {
      status: 'incompatible',
      checkedAt,
      message: 'The bridge health endpoint is incompatible',
    }
  }
  return { status: 'unreachable', checkedAt, message: 'The bridge health endpoint was unavailable' }
}

function statusDiagnostic(endpoint: string, status: number): string {
  return `CLI Bridge health at ${endpoint}/health returned HTTP ${status}; backend readiness is unavailable`
}

function contractCondition(serviceStatus: 'ok' | 'degraded', readyNames: string): string {
  if (readyNames.length > 0) {
    return `${serviceStatus} service with ready backends: ${readyNames}`
  }
  return `${serviceStatus} service with no ready backend`
}

/** Parses the CLI Bridge /health contract without treating HTTP success as readiness. */
export function parseCliBridgeHealth(
  endpoint: string,
  status: number,
  body: string,
  checkedAt: IsoDateTime,
): CliBridgeHealthParse {
  if (status < 200 || status >= 300) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = undefined
    }
    const backends = isRecord(parsed) && Array.isArray(parsed.backends) ? parsed.backends : []
    const serviceStatus =
      isRecord(parsed) && (parsed.status === 'ok' || parsed.status === 'degraded')
        ? parsed.status
        : undefined
    const readyNames = backends
      .filter((backend) => isRecord(backend) && backend.state === 'ready')
      .map((backend) => (isRecord(backend) ? String(backend.name).trim() : ''))
      .filter((name) => name.length > 0)
      .join(', ')
    return {
      health: statusHealth(status, checkedAt),
      diagnostic:
        serviceStatus === undefined
          ? statusDiagnostic(endpoint, status)
          : `CLI Bridge health at ${endpoint}/health returned HTTP ${status} and reported ${contractCondition(serviceStatus, readyNames)}; selected-model validation remains required`,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {
      health: {
        status: 'incompatible',
        checkedAt,
        message: 'The bridge health response was not JSON',
      },
      diagnostic: `CLI Bridge health at ${endpoint}/health returned HTTP ${status} with malformed JSON; backend readiness is unknown`,
    }
  }
  if (!isRecord(parsed) || (parsed.status !== 'ok' && parsed.status !== 'degraded')) {
    return {
      health: {
        status: 'incompatible',
        checkedAt,
        message: 'The bridge health response is malformed',
      },
      diagnostic: `CLI Bridge health at ${endpoint}/health returned HTTP ${status} without a valid service status; backend readiness is unknown`,
    }
  }
  if (!Array.isArray(parsed.backends) || parsed.backends.length === 0) {
    return {
      health: {
        status: 'incompatible',
        checkedAt,
        message: 'The bridge health response has no backend states',
      },
      diagnostic: `CLI Bridge health at ${endpoint}/health returned HTTP ${status} without backend readiness states`,
    }
  }
  const validBackendStates = parsed.backends.every(
    (backend) =>
      isRecord(backend) &&
      typeof backend.name === 'string' &&
      backend.name.trim().length > 0 &&
      (backend.state === 'ready' || backend.state === 'unavailable' || backend.state === 'error'),
  )
  if (!validBackendStates) {
    return {
      health: {
        status: 'incompatible',
        checkedAt,
        message: 'The bridge backend states are malformed',
      },
      diagnostic: `CLI Bridge health at ${endpoint}/health returned HTTP ${status} with malformed backend readiness states`,
    }
  }

  const readyBackends = parsed.backends.filter(
    (backend): backend is Record<string, unknown> => isRecord(backend) && backend.state === 'ready',
  )
  const readyNames = readyBackends.map((backend) => String(backend.name).trim()).join(', ')
  if (parsed.status === 'ok' && readyBackends.length > 0) {
    return { health: { status: 'healthy', checkedAt } }
  }

  if (parsed.status === 'degraded' && readyBackends.length > 0) {
    return {
      health: {
        status: 'healthy',
        checkedAt,
        message: `The bridge reports degraded service; ready backends: ${readyNames}`,
      },
      diagnostic: `CLI Bridge health at ${endpoint}/health reported degraded service with ready backends: ${readyNames}; selected-model validation remains required`,
    }
  }

  const condition =
    parsed.status === 'degraded'
      ? 'reported degraded service with no ready backend'
      : 'reported ok service with no ready backend'
  return {
    health: { status: 'unreachable', checkedAt, message: `The bridge ${condition}` },
    diagnostic: `CLI Bridge health at ${endpoint}/health returned HTTP ${status} and ${condition}; selected-model validation cannot proceed until a backend is ready`,
  }
}

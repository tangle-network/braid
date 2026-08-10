import type { ExecutionEnvironmentObservation } from '../../domain/execution-observation.js'
import type { ExecutionObservationSource } from './prepared-execution.js'

type StaticObservation = Omit<ExecutionEnvironmentObservation, 'observedAt'>

export function staticExecutionObservation(
  observation: StaticObservation,
  now: () => string = () => new Date().toISOString(),
): ExecutionObservationSource {
  return {
    async snapshot() {
      return Object.freeze({ ...observation, observedAt: now() })
    },
  }
}

export function endpointLocation(
  endpoint: string,
): Pick<ExecutionEnvironmentObservation, 'location' | 'runtimeEndpointHost'> {
  try {
    const host = new URL(endpoint).hostname.toLowerCase()
    if (host.length === 0 || host.length > 253) return { location: 'unknown' }
    return {
      location: isLoopbackHost(host) ? 'local' : 'remote',
      runtimeEndpointHost: host,
    }
  } catch {
    return { location: 'unknown' }
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

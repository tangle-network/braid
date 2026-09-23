import { HttpConnectionProvider } from './http-provider.js'
import type { ConnectionHttpTransport } from './http-transport.js'

export interface ConnectionApiPaths {
  readonly health?: string
  readonly capabilities?: string
  readonly validateProfile?: string
}

export function createCliBridgeProvider(
  transport: ConnectionHttpTransport,
  paths?: ConnectionApiPaths,
): HttpConnectionProvider {
  return new HttpConnectionProvider({
    kind: 'cli-bridge',
    transport,
    ...(paths === undefined ? {} : { paths }),
  })
}

export function createTangleInferenceProvider(
  transport: ConnectionHttpTransport,
  paths?: ConnectionApiPaths,
): HttpConnectionProvider {
  return new HttpConnectionProvider({
    kind: 'tangle-inference',
    transport,
    ...(paths === undefined ? {} : { paths }),
  })
}

export function createTangleSandboxProvider(
  transport: ConnectionHttpTransport,
  paths?: ConnectionApiPaths,
): HttpConnectionProvider {
  return new HttpConnectionProvider({
    kind: 'tangle-sandbox',
    transport,
    ...(paths === undefined ? {} : { paths }),
  })
}

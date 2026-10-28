import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentEnvironment, AgentEnvironmentProvider } from '@tangle-network/agent-interface/environment-provider'
import { InteractiveEnvironmentFixture } from './interactive-environment-provider.js'

/** HTTP transport to one stateful provider process, shared by independent Braid children. */
export async function interactiveProviderServer() {
  const fixture = new InteractiveEnvironmentFixture()
  const provider = fixture.provider()
  let environment: AgentEnvironment | undefined
  let promptDelayMs = 0
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const args = JSON.parse(Buffer.concat(chunks).toString()) as unknown[]
      const method = request.url?.slice(1) ?? ''
      calls.push(method)
      let result: unknown
      if (method === 'capabilities') result = await provider.capabilities()
      else if (method === 'create') {
        environment = await provider.create(args[0] as Parameters<typeof provider.create>[0])
        result = { id: environment.id }
      } else if (method === 'get') result = environment === undefined ? null : { id: environment.id }
      else {
        if (environment === undefined) throw new Error('No environment')
        if (method === 'startInteractive') {
          result = await environment.startInteractive?.(args[0] as never)
        } else {
          const session = environment.interactive?.(args[0] as never)
          if (session === undefined) throw new Error('No interactive session')
          if (method === 'sendPrompt' && promptDelayMs > 0)
            await new Promise((resolve) => setTimeout(resolve, promptDelayMs))
          const action = session[method as keyof typeof session]
          if (typeof action !== 'function') throw new Error(`No action: ${method}`)
          result = await (action as (argument: unknown) => Promise<unknown>)(args[1])
        }
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ result }))
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ error: String(error) }))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    fixture,
    calls,
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    delayPrompts: (ms: number) => { promptDelayMs = ms },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

export function networkInteractiveProvider(endpoint: string): AgentEnvironmentProvider {
  const call = async (method: string, args: unknown[], signal?: AbortSignal) => {
    const response = await fetch(`${endpoint}/${method}`, {
      method: 'POST', body: JSON.stringify(args), ...(signal === undefined ? {} : { signal }),
    })
    const body = await response.json() as { result?: unknown; error?: string }
    if (!response.ok) throw new Error(body.error)
    return body.result
  }
  const environment = (id: string): AgentEnvironment => ({
    id, provider: 'tangle-sandbox',
    status: async () => 'running',
    async *stream() {},
    destroy: async () => {},
    startInteractive: (request, options) => call('startInteractive', [request], options?.signal) as never,
    interactive: (ref) => ({
      ref,
      attach: async () => { throw new Error('Network steer test opens no terminal') },
      status: (_options) => call('status', [ref]) as never,
      claimControl: (command, options) => call('claimControl', [ref, command], options?.signal) as never,
      sendPrompt: (command, options) => call('sendPrompt', [ref, command], options?.signal) as never,
      stop: (command, options) => call('stop', [ref, command], options?.signal) as never,
    }) as ReturnType<NonNullable<AgentEnvironment['interactive']>>,
  }) as AgentEnvironment
  return {
    name: 'tangle-sandbox',
    capabilities: () => call('capabilities', []) as never,
    create: async (request) => {
      const result = await call('create', [request]) as { id: string }
      return environment(result.id)
    },
    get: async (id) => await call('get', [id]) === null ? null : environment(id),
  }
}

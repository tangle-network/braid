import { spawn } from 'node:child_process'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class RpcSession {
  constructor(binary, workspace, keyFile, endpoint, timeoutMs = 180_000) {
    this.binary = binary
    this.workspace = workspace
    this.keyFile = keyFile
    this.endpoint = endpoint
    this.timeoutMs = timeoutMs
    this.responses = []
    this.commands = []
    this.waiters = new Set()
    this.buffer = ''
    this.stdout = ''
    this.stderr = ''
    this.child = spawn(
      process.execPath,
      [binary, 'rpc', '--workspace', workspace, '--database-key-file', keyFile],
      {
        cwd: workspace,
        env: {
          ...process.env,
          NO_COLOR: '1',
          NODE_NO_WARNINGS: '1',
          BRAID_STATE_PATH: `${keyFile}.state.sqlite`,
          BRAID_CLI_BRIDGE_ENDPOINT: endpoint,
          XDG_DATA_HOME: `${keyFile}.data`,
          XDG_CONFIG_HOME: `${keyFile}.config`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    this.exit = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('close', (code, signal) => {
        this.closed = true
        for (const waiter of this.waiters)
          waiter.reject(new Error(`RPC exited before ${waiter.label}: ${code ?? signal}`))
        this.waiters.clear()
        resolve({ code, signal })
      })
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this.#stdout(chunk))
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
  }

  #stdout(chunk) {
    this.stdout += chunk
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (line) {
        let response
        try {
          response = JSON.parse(line)
        } catch {
          response = { type: 'malformed', line }
        }
        this.responses.push(response)
        for (const waiter of this.waiters) {
          if (!waiter.predicate(response)) continue
          this.waiters.delete(waiter)
          waiter.resolve(response)
          break
        }
      }
      newline = this.buffer.indexOf('\n')
    }
  }

  send(command, params = {}, operationId) {
    if (this.closed) throw new Error('RPC process is closed')
    const requestId = `live-core-${this.commands.length + 1}`
    const request = {
      version: 1,
      requestId,
      command,
      params,
      ...(operationId === undefined ? {} : { operationId }),
    }
    this.commands.push(structuredClone(request))
    this.child.stdin.write(`${JSON.stringify(request)}\n`)
    return request
  }

  async waitFor(label, predicate, timeoutMs = this.timeoutMs) {
    const existing = this.responses.find(predicate)
    if (existing) return existing
    return new Promise((resolve, reject) => {
      const waiter = { label, predicate, resolve, reject }
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`Timed out waiting for ${label}`))
      }, timeoutMs)
      waiter.resolve = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      waiter.reject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      this.waiters.add(waiter)
    })
  }

  async request(command, params = {}, operationId, timeoutMs = this.timeoutMs) {
    const request = this.send(command, params, operationId)
    const response = await this.waitFor(
      `${command} acknowledgement`,
      (candidate) =>
        candidate.requestId === request.requestId &&
        (candidate.type === 'ack' || candidate.type === 'error'),
      timeoutMs,
    )
    if (response.type === 'error') throw Object.assign(new Error(response.message), { response })
    return { request, response }
  }

  async state(projection = 'full', timeoutMs = this.timeoutMs) {
    const request = this.send('get_state', { projection })
    return this.waitFor(
      `${projection} state`,
      (response) => response.requestId === request.requestId && response.type === 'state',
      timeoutMs,
    )
  }

  async close() {
    if (this.closed) return this.exit
    if (!this.child.stdin.destroyed) this.child.stdin.end()
    return this.exit
  }

  async shutdown() {
    if (this.closed) return this.exit
    const { request, response } = await this.request(
      'shutdown',
      {},
      `op-live-core-shutdown-${Date.now()}`,
    )
    await this.waitFor(
      'RPC exit after shutdown',
      (candidate) => candidate.requestId === request.requestId && candidate.type === 'ack',
    )
    await this.exit
    return { request, response }
  }

  async forceStop() {
    if (this.closed) return this.exit
    this.child.kill('SIGKILL')
    await this.exit
    await sleep(20)
    return { forced: true }
  }
}

export function stateFor(response, runId) {
  return response?.type === 'state' && response.state?.runs?.some((run) => run.id === runId)
}

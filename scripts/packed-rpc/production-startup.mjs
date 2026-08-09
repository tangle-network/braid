import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function runBinary(binaryPath, args, input, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binaryPath, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    child.stdin.end(input)
  })
}

export async function runBuiltStartupProof(binary, repository) {
  const sourceWorkspace = await mkdtemp(join(tmpdir(), 'braid-production-startup-'))
  const sourceState = join(sourceWorkspace, 'braid.sqlite')
  try {
    const sourceBinary = join(repository, 'dist', 'bin', 'braid.js')
    const empty = await runBinary(
      sourceBinary,
      ['rpc', '--workspace', sourceWorkspace],
      '',
      repository,
      {
        ...process.env,
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_STATE_PATH: sourceState,
      },
    )
    if (empty.code !== 0)
      throw new Error(
        `built RPC startup failed on a fresh workspace: exit=${empty.code} signal=${empty.signal ?? 'none'}\n${empty.stderr}`,
      )
    if (empty.stderr.includes('PRODUCTION_CONFIGURATION_NOT_FOUND'))
      throw new Error(`built RPC startup still rejected first-run setup\n${empty.stderr}`)

    const machineWorkspace = await mkdtemp(join(tmpdir(), 'braid-production-rpc-'))
    try {
      const machine = await runBinary(
        sourceBinary,
        ['rpc', '--workspace', machineWorkspace],
        `${[
          {
            version: 1,
            requestId: 'setup-init',
            command: 'initialize',
            params: { workspace: machineWorkspace },
          },
          {
            version: 1,
            requestId: 'setup-state',
            command: 'get_state',
            params: { projection: 'summary' },
          },
          {
            version: 1,
            requestId: 'setup-stop',
            operationId: 'setup-stop-operation',
            command: 'shutdown',
          },
        ]
          .map((request) => JSON.stringify(request))
          .join('\n')}\n`,
        repository,
        {
          ...process.env,
          NO_COLOR: '1',
          NODE_NO_WARNINGS: '1',
          BRAID_STATE_PATH: join(machineWorkspace, 'braid.sqlite'),
        },
      )
      if (machine.code !== 0 || machine.stderr)
        throw new Error(
          `built RPC setup protocol failed: exit=${machine.code} stderr=${machine.stderr}\n${machine.stdout}`,
        )
      const responses = machine.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (
        !responses.some(
          (response) => response.type === 'ack' && response.requestId === 'setup-init',
        )
      )
        throw new Error(
          `built RPC setup protocol omitted initialize acknowledgement\n${machine.stdout}`,
        )
      if (
        !responses.some(
          (response) => response.type === 'state' && response.requestId === 'setup-state',
        )
      )
        throw new Error(
          `built RPC setup protocol omitted machine-readable state\n${machine.stdout}`,
        )
    } finally {
      await rm(machineWorkspace, { force: true, recursive: true })
    }
    process.stdout.write('Built fresh-workspace RPC startup proof passed\n')
  } finally {
    await rm(sourceWorkspace, { force: true, recursive: true })
  }
  return binary
}

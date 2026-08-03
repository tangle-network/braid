import { join } from 'node:path'
import { assert } from './package-proof-assertions.mjs'
import { cleanEnvironment, runFifoCommand, shellArgument, sleep } from './package-proof-process.mjs'

export async function runRpc(binary, cwd) {
  const request = (value) => `printf '%s\\n' ${shellArgument(JSON.stringify(value))}`
  const script = [
    request({
      version: 1,
      requestId: 'req-init',
      command: 'initialize',
      params: { workspace: cwd, subscribe: true },
    }),
    request({
      version: 1,
      requestId: 'req-send',
      operationId: 'op-rpc-000001',
      command: 'send',
      params: {
        conversationId: 'conv-1',
        branchId: 'branch-1',
        text: 'hello from package proof',
      },
    }),
    'sleep 1',
    request({ version: 1, requestId: 'req-graph', command: 'get_graph', params: {} }),
    request({ version: 1, requestId: 'req-unavailable', command: 'list_profiles', params: {} }),
    request({
      version: 1,
      requestId: 'req-retry',
      operationId: 'op-rpc-000001',
      command: 'send',
      params: {
        conversationId: 'conv-1',
        branchId: 'branch-1',
        text: 'hello from package proof',
      },
    }),
    request({
      version: 1,
      requestId: 'req-cancel-send',
      operationId: 'op-rpc-cancel-send',
      command: 'send',
      params: { text: 'cancel from package proof' },
    }),
    request({
      version: 1,
      requestId: 'req-cancel',
      operationId: 'op-rpc-cancel',
      command: 'cancel_run',
      params: { runId: 'run-000005', reason: 'package proof cancellation' },
    }),
    request({
      version: 1,
      requestId: 'req-stop',
      operationId: 'op-rpc-shutdown',
      command: 'shutdown',
    }),
  ].join('; ')
  const result = await Promise.race([
    runFifoCommand(
      (stdoutPath, stderrPath) =>
        `{ ${script}; } | exec ${shellArgument(binary)} rpc --fixture deterministic > ${shellArgument(stdoutPath)} 2> ${shellArgument(stderrPath)}`,
      cwd,
      cleanEnvironment({
        NO_COLOR: '1',
        NODE_NO_WARNINGS: '1',
        BRAID_FIXTURE_CHUNK_DELAY_MS: '100',
        BRAID_JOURNAL_PATH: join(cwd, 'rpc-events.jsonl'),
      }),
    ),
    sleep(5_000).then(() => {
      throw new Error('packed RPC did not exit')
    }),
  ])
  const { stdout, stderr } = result
  const responses = () =>
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  if (stderr) throw new Error(`packed RPC wrote stderr: ${stderr}`)
  const allResponses = responses()
  const firstState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-send',
  )?.state
  if (!firstState) throw new Error('packed RPC did not return send state')
  const state = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-cancel',
  )?.state
  if (!state)
    throw new Error(
      `packed RPC did not return cancellation state; responses=${allResponses.map((response) => `${response.type}:${response.requestId ?? ''}:${response.code ?? ''}`).join(',')}`,
    )
  const events = allResponses
    .filter((response) => response.type === 'event')
    .map((response) => response.event)
  const baselineEvents = events.slice(
    0,
    events.findIndex((event) => event.kind === 'run.finished') + 1,
  )
  const retryAck = allResponses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-retry',
  )
  const graphState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-graph',
  )
  const unavailable = allResponses.find(
    (response) => response.type === 'error' && response.requestId === 'req-unavailable',
  )
  const cancelState = allResponses.find(
    (response) => response.type === 'state' && response.requestId === 'req-cancel',
  )
  const shutdownAck = allResponses.find(
    (response) => response.type === 'ack' && response.requestId === 'req-stop',
  )
  assert(retryAck?.replayed === true, 'packed RPC retry did not replay the operation')
  assert(
    graphState?.view?.selectedSurface === 'graph',
    'packed RPC graph command did not open graph',
  )
  assert(
    unavailable?.code === 'CAPABILITY_UNAVAILABLE',
    'packed RPC unavailable command changed behavior',
  )
  assert(
    cancelState?.state?.runs?.at(-1)?.status === 'aborted',
    'packed RPC cancel did not abort the active run',
  )
  assert(
    shutdownAck?.operationId === 'op-rpc-shutdown',
    'packed RPC shutdown was not operation-bound',
  )
  return {
    responses: allResponses,
    state,
    firstState,
    events,
    baselineEvents,
    stderr,
    flows: ['send', 'graph', 'unavailable', 'retry', 'cancel', 'shutdown'],
  }
}

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import xterm from '@xterm/headless'
import * as pty from 'node-pty'
import {
  createInMemoryRunContext,
  createSupervisor,
  serveCoordinationMcp,
} from '@tangle-network/agent-runtime/kernel'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { graphFor } from '../src/adapters/tui/ui-projection.js'
import { createDurableBraidApplication } from '../src/app/composition.js'
import { runtimeWorkerReference } from '../src/app/supervisor-projection.js'
import { queryDetails } from '../src/views/shared/semantic-details.js'
import { queryGraph } from '../src/views/shared/semantic-graph.js'

test('real Runtime workers cross authenticated HTTP into the conversation graph, selected stream, and encrypted restart', {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-remote-supervision-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const key = join(root, 'database.key')
  await writeFile(key, randomBytes(32), { mode: 0o600 })
  const options = {
    path: join(root, 'braid.sqlite'),
    storageRoot: root,
    workspaceRoot: workspace,
    databaseKeySource: { type: 'file' as const, path: key, workspaceRoot: workspace },
    credentialStore: new MemoryCredentialStore(),
  }
  const envName = 'BRAID_REMOTE_SUPERVISION_INTEGRATION'
  const previousEnv = process.env[envName]
  const secondEnv = 'BRAID_REMOTE_SUPERVISION_SECOND'
  const previousSecondEnv = process.env[secondEnv]
  const runtimeContext = createInMemoryRunContext()
  let durable = await createDurableBraidApplication(options)
  let allowTools = () => {}
  const toolsAllowed = new Promise<void>((resolve) => {
    allowTools = resolve
  })
  let allowSecret = () => {}
  const secretAllowed = new Promise<void>((resolve) => {
    allowSecret = resolve
  })
  let release = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    durable.app.initialize(workspace)
    const result = await createSupervisor().run(
      {
        name: 'real-code-workers',
        async act(_, scope) {
          const server = await serveCoordinationMcp({
            scope,
            blobs: runtimeContext.blobs,
            authentication: true,
            identity: { runId: 'remote-supervision-integration', actorId: 'manager' },
            perWorker: { maxIterations: 1, maxTokens: 10 },
            toolNames: ['spawn_worker', 'observe_agent', 'read_journal'],
            makeWorkerAgent(profile) {
              const name = profile.name
              assert.ok(name)
              return {
                name,
                act: async () => {
                  throw new Error('The real code executor must run')
                },
                executorSpec: {
                  profile,
                  harness: null,
                  executor: {
                    runtime: 'inline',
                    async *execute(task: unknown) {
                      assert.ok(typeof task === 'string')
                      await writeFile(join(root, name), task)
                      yield {
                        kind: 'progress' as const,
                        progress: {
                          kind: 'text_delta' as const,
                          text: `${profile.name}: actual output`,
                        },
                      }
                      await toolsAllowed
                      const credential = Object.values(server.readOnly.headers)[0]
                      assert.ok(credential)
                      const split = Math.ceil(credential.length / 2)
                      yield {
                        kind: 'progress' as const,
                        progress: {
                          kind: 'text_delta' as const,
                          text: ` credential="${credential.slice(0, split)}`,
                        },
                      }
                      await secretAllowed
                      yield {
                        kind: 'progress' as const,
                        progress: {
                          kind: 'text_delta' as const,
                          text: `${credential.slice(split)}" `,
                        },
                      }
                      yield {
                        kind: 'progress' as const,
                        progress: { kind: 'tool_call' as const, toolName: 'write_file' },
                      }
                      await released
                    },
                    async teardown() {
                      release()
                      return { destroyed: true }
                    },
                    resultArtifact() {
                      return {
                        outRef: `file:${profile.name}`,
                        out: profile.name,
                        spent: { iterations: 1, tokens: { input: 0, output: 0 }, usd: 0, ms: 1 },
                      }
                    },
                  },
                },
              }
            },
          })
          try {
            for (const name of ['Surveyor', 'Checker']) {
              const response = await fetch(server.url, {
                method: 'POST',
                headers: {
                  ...server.headers,
                  'content-type': 'application/json',
                  accept: 'application/json, text/event-stream',
                },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id: 1,
                  method: 'tools/call',
                  params: {
                    name: 'spawn_worker',
                    arguments: { profile: { name }, label: name, task: `actual-${name}` },
                  },
                }),
              })
              assert.equal(response.status, 200)
              const reply = (await response.json()) as { result: { isError?: boolean } }
              assert.ok(!reply.result.isError)
            }
            process.env[envName] = JSON.stringify(server.readOnly)
            // A separate real executable inherits the read capability; no Braid turn is admitted.
            const childRecord = join(root, 'observer-state.json')
            const emulator = new xterm.Terminal({ cols: 120, rows: 40, allowProposedApi: true })
            const child = pty.spawn(
              process.execPath,
              [
                fileURLToPath(new URL('../src/bin/braid.js', import.meta.url)),
                '--workspace',
                workspace,
                '--config',
                join(root, 'observer-config.json'),
                '--database-key-file',
                key,
                '--remote-env',
                envName,
                '--record-state',
                childRecord,
              ],
              {
                cwd: workspace,
                cols: 120,
                rows: 40,
                env: {
                  ...process.env,
                  HOME: root,
                  TERM: 'xterm-256color',
                  BRAID_CLI_BRIDGE_ENDPOINT: 'http://127.0.0.1:9',
                  XDG_CONFIG_HOME: join(root, 'config'),
                  XDG_DATA_HOME: join(root, 'data'),
                  BRAID_STATE_PATH: join(root, 'observer.sqlite'),
                },
              },
            )
            let output = ''
            const started = performance.now()
            const terminalEvents: unknown[] = []
            let childExited = false
            const closed = new Promise<number>((resolve) =>
              child.onExit(({ exitCode }) => {
                childExited = true
                resolve(exitCode)
              }),
            )
            child.onData((chunk) => {
              output += chunk
              terminalEvents.push([(performance.now() - started) / 1_000, 'o', chunk])
              emulator.write(chunk)
            })
            const screen = () =>
              Array.from(
                { length: 40 },
                (_, row) =>
                  emulator.buffer.active
                    .getLine(emulator.buffer.active.viewportY + row)
                    ?.translateToString(true) ?? '',
              ).join('\n')
            const waitForScreen = async (predicate: () => boolean) => {
              const deadline = Date.now() + 10_000
              while (!predicate()) {
                assert.ok(!childExited && Date.now() < deadline, screen())
                await new Promise((resolve) => setTimeout(resolve, 20))
              }
            }
            const watchdog = setTimeout(() => child.kill(), 15_000)
            try {
              await waitForScreen(
                () => screen().includes('conversation graph') && screen().includes('Surveyor'),
              )
              assert.ok(!screen().includes('choose an AgentProfile'))
              child.write('\u001b')
              await waitForScreen(() => !screen().includes('conversation graph'))
              child.write('/quit\r')
              assert.equal(await closed, 0, output)
            } finally {
              clearTimeout(watchdog)
              if (!childExited) child.kill()
              emulator.dispose()
            }
            const recorded = await readFile(childRecord, 'utf8')
            const observed = JSON.parse(recorded)
            assert.equal(observed.state.runs.length, 0)
            assert.equal(observed.state.workers.length, 2)
            assert.equal(observed.state.supervisors[0].remoteEndpointEnv, envName)
            for (const secret of [server.readOnly.url, ...Object.values(server.readOnly.headers)])
              assert.ok(!`${output}${recorded}`.includes(secret))
            if (process.env.BRAID_RELEASE_ARTIFACT_ROOT !== undefined)
              await writeFile(
                join(process.env.BRAID_RELEASE_ARTIFACT_ROOT, 'remote-startup.cast'),
                [
                  JSON.stringify({
                    version: 2,
                    width: 120,
                    height: 40,
                    title: 'Braid startup attachment to real Runtime workers',
                    env: { TERM: 'xterm-256color' },
                  }),
                  ...terminalEvents.map((event) => JSON.stringify(event)),
                  '',
                ].join('\n'),
                { mode: 0o600, flag: 'wx' },
              )
            let controller = createApplicationUiController(durable.app)
            const initial = await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { remoteEndpointEnv: envName },
            })
            assert.equal(initial.kind, 'accepted')
            const workers = durable.app.state().workers
            assert.equal(workers.length, 2)
            const waiting = workers.find((worker) => worker.title === 'Checker')
            assert.ok(waiting)
            assert.equal(waiting.status, 'pending')
            assert.equal(
              graphFor(durable.app.state()).find((node) => node.id === waiting.id)?.status,
              'pending',
            )
            const selected = workers.find((worker) => worker.title === 'Surveyor')
            assert.ok(selected)
            assert.equal(
              runtimeWorkerReference(
                durable.app.state(),
                String(selected.supervisorId),
                String(selected.id),
              ),
              undefined,
            )
            const graph = queryGraph(durable.app.state(), {
              conversationId: durable.app.state().conversationId ?? undefined,
            })
            assert.ok(
              graph.edges.some(
                (edge) =>
                  edge.sourceType === 'conversation' && edge.destinationType === 'supervisor',
              ),
            )
            assert.equal(graph.edges.filter((edge) => edge.kind === 'spawned').length, 2)
            for (let attempt = 0; attempt < 30; attempt += 1) {
              await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { workerId: selected.id },
              })
              if (
                durable.app
                  .state()
                  .workers.find((worker) => worker.id === selected.id)
                  ?.logTail?.includes('actual output')
              )
                break
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            const details = queryDetails(durable.app.state(), {
              entityType: 'worker',
              entityId: selected.id,
            })
            assert.match(String(details.data.logTail), /Surveyor: actual output/u)
            assert.doesNotMatch(String(details.data.logTail), /write_file/u)
            assert.equal(selected.status, 'running')
            allowTools()
            for (let attempt = 0; attempt < 30; attempt += 1) {
              await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { workerId: selected.id },
              })
              if (
                durable.app
                  .state()
                  .workers.find((worker) => worker.id === selected.id)
                  ?.logTail?.toLowerCase()
                  .includes('[redacted')
              )
                break
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            const partial = durable.app
              .state()
              .workers.find((worker) => worker.id === selected.id)?.logTail
            assert.match(String(partial), /redacted/iu)
            const credential = Object.values(server.readOnly.headers)[0]
            assert.ok(credential)
            assert.ok(
              !JSON.stringify(durable.app.events()).includes(
                credential.slice(0, Math.ceil(credential.length / 2)),
              ),
            )
            allowSecret()
            for (let attempt = 0; attempt < 30; attempt += 1) {
              await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { workerId: selected.id },
              })
              if (
                durable.app
                  .state()
                  .workers.find((worker) => worker.id === selected.id)
                  ?.logTail?.includes('write_file')
              )
                break
              await new Promise((resolve) => setTimeout(resolve, 10))
            }
            assert.match(
              String(
                durable.app.state().workers.find((worker) => worker.id === selected.id)?.logTail,
              ),
              /write_file/u,
            )
            assert.equal(
              durable.app.state().workers.find((worker) => worker.title === 'Checker')?.logTail,
              undefined,
            )
            const before = String(
              durable.app.state().workers.find((worker) => worker.id === selected.id)?.logTail,
            )
            await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { workerId: selected.id },
            })
            assert.equal(
              queryDetails(durable.app.state(), { entityType: 'worker', entityId: selected.id })
                .data.logTail,
              before,
            )
            await durable.app.whenDurable()
            const events = JSON.stringify(durable.app.events())
            for (const secret of Object.values(server.readOnly.headers))
              assert.ok(!events.includes(secret))
            assert.ok(!events.includes(server.readOnly.url))
            await durable.storage.close()
            durable = await createDurableBraidApplication(options)
            controller = createApplicationUiController(durable.app)
            assert.equal(durable.app.state().workers.length, 2)
            assert.equal(durable.app.state().supervisors[0]?.remoteEndpointEnv, envName)
            await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { workerId: selected.id },
            })
            assert.equal(
              durable.app.state().workers.find((worker) => worker.id === selected.id)?.logTail,
              before,
            )
            const second = await serveCoordinationMcp({
              scope,
              blobs: runtimeContext.blobs,
              authentication: true,
              identity: { runId: 'remote-supervision-integration', actorId: 'second-reader' },
              perWorker: { maxIterations: 1, maxTokens: 10 },
              toolNames: ['observe_agent', 'read_journal'],
              makeWorkerAgent() {
                throw new Error('Read-only source')
              },
            })
            try {
              process.env[secondEnv] = JSON.stringify(second.readOnly)
              const attached = await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { remoteEndpointEnv: secondEnv },
              })
              assert.equal(attached.kind, 'accepted')
              const owner = durable.app
                .state()
                .supervisors.find((record) => record.remoteEndpointEnv === secondEnv)
              assert.ok(owner)
              const secondWorker = durable.app
                .state()
                .workers.find(
                  (worker) => worker.supervisorId === owner.id && worker.title === 'Surveyor',
                )
              assert.ok(secondWorker)
              await server.close()
              const active = await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: {},
              })
              assert.equal(
                active.kind,
                'accepted',
                'Automatic refresh must retain the explicitly selected second endpoint',
              )
              const observed = await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { workerId: secondWorker.id },
              })
              assert.equal(observed.kind, 'accepted')
              assert.match(
                String(
                  durable.app.state().workers.find((worker) => worker.id === secondWorker.id)
                    ?.logTail,
                ),
                /Surveyor: actual output/u,
              )
              release()
              for (;;) {
                if (!(await scope.next())) break
              }
              const drained = await controller.dispatch({
                type: 'headless-command',
                command: 'refresh_supervision',
                params: { workerId: secondWorker.id },
              })
              assert.equal(drained.kind, 'accepted')
              const completed = durable.app
                .state()
                .workers.find((worker) => worker.id === secondWorker.id)
              assert.equal(completed?.status, 'completed')
              assert.match(String(completed?.logTail), /Surveyor: actual output/u)
            } finally {
              await second.close()
            }
            const failed = await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { workerId: selected.id },
            })
            assert.equal(failed.kind, 'unavailable')
            assert.equal(durable.app.state().workers.length, 4)
            release()
            for (;;) {
              if (!(await scope.next())) break
            }
            for (const name of ['Surveyor', 'Checker'])
              assert.equal(await readFile(join(root, name), 'utf8'), `actual-${name}`)
            return 'real network, files, stream cursor, and encrypted restart passed'
          } finally {
            allowTools()
            allowSecret()
            release()
            await server.close()
          }
        },
      },
      {},
      {
        ...runtimeContext,
        budget: { maxIterations: 5, maxTokens: 100, deadlineMs: 25_000 },
        runId: 'remote-supervision-integration',
        workerSlots: 1,
      },
    )
    assert.equal(result.kind, 'winner', JSON.stringify(result))
    const emptyContext = createInMemoryRunContext()
    const reset = await createSupervisor().run(
      {
        name: 'replacement-read-host',
        async act(_, scope) {
          const empty = await serveCoordinationMcp({
            scope,
            blobs: emptyContext.blobs,
            authentication: true,
            identity: { runId: 'remote-supervision-integration', actorId: 'replacement-reader' },
            perWorker: { maxIterations: 1, maxTokens: 10 },
            toolNames: ['observe_agent', 'read_journal'],
            makeWorkerAgent() {
              throw new Error('Read-only source')
            },
          })
          try {
            process.env[secondEnv] = JSON.stringify(empty.readOnly)
            const controller = createApplicationUiController(durable.app)
            const refreshed = await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { remoteEndpointEnv: secondEnv },
            })
            assert.equal(refreshed.kind, 'accepted')
            const owner = durable.app
              .state()
              .supervisors.find((record) => record.remoteEndpointEnv === secondEnv)
            assert.ok(owner)
            const omitted = durable.app
              .state()
              .workers.filter((worker) => worker.supervisorId === owner.id)
            assert.equal(omitted.length, 2)
            for (const worker of omitted) {
              assert.equal(worker.status, 'unknown')
              assert.equal(
                graphFor(durable.app.state()).find((node) => node.id === worker.id)?.status,
                'unknown',
              )
              assert.equal(
                queryDetails(durable.app.state(), { entityType: 'worker', entityId: worker.id })
                  .status,
                'unknown',
              )
            }
            return 'Omitted remote agents are unknown in both graph and details'
          } finally {
            await empty.close()
          }
        },
      },
      {},
      {
        ...emptyContext,
        budget: { maxIterations: 1, maxTokens: 10, deadlineMs: 5000 },
        runId: 'remote-supervision-integration',
      },
    )
    assert.equal(reset.kind, 'winner', JSON.stringify(reset))
  } finally {
    allowTools()
    allowSecret()
    release()
    await durable.storage.close()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
    if (previousSecondEnv === undefined) delete process.env[secondEnv]
    else process.env[secondEnv] = previousSecondEnv
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  createInMemoryRunContext,
  createSupervisor,
  serveCoordinationMcp,
} from '@tangle-network/agent-runtime/kernel'
import { MemoryCredentialStore } from '../src/adapters/credentials/memory.js'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
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
  const runtimeContext = createInMemoryRunContext()
  let durable = await createDurableBraidApplication(options)
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
            let controller = createApplicationUiController(durable.app)
            const initial = await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { remoteEndpointEnv: envName },
            })
            assert.equal(initial.kind, 'accepted')
            const workers = durable.app.state().workers
            assert.equal(workers.length, 2)
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
            assert.match(String(details.data.logTail), /write_file/u)
            assert.equal(
              durable.app.state().workers.find((worker) => worker.title === 'Checker')?.logTail,
              undefined,
            )
            const before = String(details.data.logTail)
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
            await server.close()
            const failed = await controller.dispatch({
              type: 'headless-command',
              command: 'refresh_supervision',
              params: { workerId: selected.id },
            })
            assert.equal(failed.kind, 'unavailable')
            assert.equal(durable.app.state().workers.length, 2)
            release()
            for (;;) {
              if (!(await scope.next())) break
            }
            for (const name of ['Surveyor', 'Checker'])
              assert.equal(await readFile(join(root, name), 'utf8'), `actual-${name}`)
            return 'real network, files, stream cursor, and encrypted restart passed'
          } finally {
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
      },
    )
    assert.equal(result.kind, 'winner', JSON.stringify(result))
  } finally {
    release()
    await durable.storage.close()
    if (previousEnv === undefined) delete process.env[envName]
    else process.env[envName] = previousEnv
    await rm(root, { recursive: true, force: true })
  }
})

import { access, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  PROOF_OPERATIONS,
  proofInvocation,
  proofReceipt,
  protectedUnavailable,
} from './contracts.mjs'

export async function runSupervisorFlow({
  repository,
  environment,
  invocationId = proofInvocation('live-supervisor'),
}) {
  const startedAt = new Date().toISOString()
  const rootDir = environment.BRAID_SUPERVISOR_ROOT
  const supervisorId = environment.BRAID_SUPERVISOR_ID
  const workerId = environment.BRAID_SUPERVISOR_WORKER
  if (!rootDir || !supervisorId || !workerId) {
    throw protectedUnavailable(
      'PROTECTED_SUPERVISOR_CONFIGURATION_REQUIRED',
      'Supervisor proof requires BRAID_SUPERVISOR_ROOT, BRAID_SUPERVISOR_ID, and BRAID_SUPERVISOR_WORKER for a real runtime root',
    )
  }
  const distRoot = resolve(repository, 'dist', 'adapters', 'runtime')
  try {
    await access(join(distRoot, 'supervisor-watch.js'))
    await access(join(distRoot, 'supervisor-control.js'))
  } catch (error) {
    throw protectedUnavailable(
      'BRAID_BUILD_REQUIRED',
      'The compiled Braid supervisor adapters are unavailable; run the release build before live checks',
      error,
    )
  }
  try {
    const [{ RuntimeSupervisorWatcher }, { RuntimeSupervisorController }] = await Promise.all([
      import(pathToFileURL(join(distRoot, 'supervisor-watch.js')).href),
      import(pathToFileURL(join(distRoot, 'supervisor-control.js')).href),
    ])
    const watcher = new RuntimeSupervisorWatcher()
    const first = watcher.snapshot(rootDir)
    const supervisor = first.supervisors.find((candidate) => candidate.id === supervisorId)
    const worker = supervisor?.workers.find(
      (candidate) => candidate.id === workerId || candidate.label === workerId,
    )
    if (!supervisor || !worker) {
      throw new Error(
        `The configured runtime root contains no supervisor '${supervisorId}' with worker '${workerId}'`,
      )
    }
    const reconnected = watcher.reconnect(rootDir)
    const reconnectedSupervisor = reconnected.supervisors.find(
      (candidate) => candidate.id === supervisorId,
    )
    if (!reconnectedSupervisor?.workers.some((candidate) => candidate.id === worker.id)) {
      throw new Error('supervisor reconnect did not recover the selected worker')
    }
    const message = environment.BRAID_SUPERVISOR_MESSAGE ?? `Braid live supervisor ${Date.now()}`
    const controller = new RuntimeSupervisorController({ watcher })
    const steered = controller.steerWorker(rootDir, supervisorId, worker.id, message, 'braid-live')
    if (steered.status !== 'queued' || !steered.requestId || !steered.file) {
      throw new Error('runtime supervisor rejected the typed worker steering request')
    }
    const inbox = await readFile(steered.file, 'utf8')
    if (!inbox.includes(message))
      throw new Error('worker inbox did not contain the steering message')
    const proof = proofReceipt({
      invocationId,
      operation: PROOF_OPERATIONS.supervisor,
      startedAt,
      completedAt: new Date().toISOString(),
      facts: {
        supervisorId: supervisor.id,
        workerId: worker.id,
        steeringRequestId: steered.requestId,
        cancellationAvailable: false,
      },
      checks: ['snapshot', 'reconnect', 'steering'],
    })
    return {
      supervisor: supervisor.id,
      worker: worker.id,
      reconnect: true,
      steering: { status: steered.status, requestId: steered.requestId },
      cancellation: 'unavailable: published runtime has no external worker-cancel operation',
      proof,
    }
  } catch (error) {
    if (error?.unavailable === true) throw error
    throw error
  }
}

export async function runSupervisorCheck({ repository, environment }) {
  const invocationId = proofInvocation('live-supervisor')
  const direct = await runSupervisorFlow({ repository, environment, invocationId })
  return {
    status: 'partial',
    evidence: direct.proof,
    unavailable: [
      {
        row: 'LIVE-11',
        reason:
          'The parent can prove snapshot, reconnect, and steering, but it has no worker-cancel operation. External adapters cannot certify LIVE-11.',
      },
    ],
  }
}

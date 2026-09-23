import type {
  NativeWorkerAttachPort,
  NativeWorkerAttachRequest,
} from '../ports/native-worker-attach.js'
import type { ProductionApplicationSlot } from './production-setup-transition.js'

export function createNativeWorkerAttachPort(
  active: ProductionApplicationSlot,
): NativeWorkerAttachPort {
  return {
    availability: () => {
      const capability = active.current.app.intelligence.supervisor.capabilities()
      return capability.workerAttach
        ? { available: true }
        : {
            available: false,
            reason: capability.workerAttachReason ?? 'Runtime worker attachment is unavailable',
          }
    },
    attach: (request) => attachWorker(active, request),
  }
}

async function attachWorker(
  active: ProductionApplicationSlot,
  request: NativeWorkerAttachRequest,
): Promise<Awaited<ReturnType<NativeWorkerAttachPort['attach']>>> {
  const app = active.current.app
  const capability = app.intelligence.supervisor.capabilities()
  if (!capability.workerAttach) {
    return {
      status: 'unavailable',
      reason: capability.workerAttachReason ?? 'Runtime worker attachment is unavailable',
    }
  }
  const state = app.state()
  const supervisor = state.supervisors.find(
    (candidate) => String(candidate.id) === request.supervisorId,
  )
  if (supervisor === undefined || state.workspace !== supervisor.runtimeRoot) {
    return {
      status: 'unavailable',
      reason: 'The selected supervisor is not present in this workspace',
    }
  }
  const worker = state.workers.find(
    (candidate) =>
      String(candidate.id) === request.workerId && candidate.supervisorId === supervisor.id,
  )
  if (worker === undefined) {
    return {
      status: 'unavailable',
      reason: 'The selected worker is not present under this supervisor',
    }
  }
  const result = await app.intelligence.supervisor.attachWorker(
    supervisor.runtimeRoot,
    supervisor.runtimeId,
    worker.runtimeId,
  )
  if (result.status === 'unavailable' || result.handle === undefined) {
    return {
      status: 'unavailable',
      reason: result.issue?.reason ?? 'Runtime worker attachment is unavailable',
    }
  }
  return { status: 'available', handle: result.handle }
}

import { createDeterministicExecution } from '../../src/app/composition.js'
import type { ExecutionPort } from '../../src/ports/execution.js'

/**
 * Deterministic fixture execution whose turns stay active until the test releases them or
 * cancels the run. Use it wherever a test needs an active run; a fixture delay can expire first
 * on a loaded machine.
 */
export interface HeldFixtureExecution {
  readonly execution: ExecutionPort
  /** Lets every held turn, and every later turn, complete. */
  readonly release: () => void
}

export function heldFixtureExecution(): HeldFixtureExecution {
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return { execution: createDeterministicExecution({ release: released }), release }
}

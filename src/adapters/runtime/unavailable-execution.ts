import type { ExecuteTurnInput, ExecutionAdmission, ExecutionPort } from '../../ports/execution.js'

export class ExecutionUnavailableError extends Error {
  readonly code = 'CONNECTION_REQUIRED'

  constructor() {
    super('Configure a connection before starting a run')
    this.name = 'ExecutionUnavailableError'
  }
}

export class UnavailableExecutionPort implements ExecutionPort {
  readonly admissionMode = 'sync' as const
  readonly capabilities = { cancel: false as const }

  admit(_input: ExecuteTurnInput): ExecutionAdmission {
    throw new ExecutionUnavailableError()
  }

  streamTurn(_input: ExecuteTurnInput): AsyncIterable<never> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next: async () => {
            throw new ExecutionUnavailableError()
          },
        }
      },
    }
  }
}

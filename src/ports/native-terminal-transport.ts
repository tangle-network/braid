import type { AgentTerminalSession } from '@tangle-network/agent-interface'

/** The existing local terminal boundary used by ProcessTerminal and tests. */
export interface NativeTerminalHost {
  readonly columns: number
  readonly rows: number
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  write(data: string): void
}

/** Optional ownership boundary for the process signal listeners. */
export interface NativeTerminalSignalPort {
  takeOver(handler: (exitCode: number) => void): () => void
}

export type NativeTerminalTransportPhase =
  | 'terminal-start'
  | 'signal-install'
  | 'output'
  | 'input'
  | 'resize'
  | 'events'

export type NativeTerminalCleanupPhase = 'remote-detach' | 'terminal-stop' | 'signal-release'

export type NativeTerminalTransportOutcome =
  | {
      readonly kind: 'detached'
      readonly sessionId: string
      readonly trigger: 'user'
    }
  | {
      readonly kind: 'remote-exit'
      readonly sessionId: string
      readonly reason: 'exited' | 'closed-during-detach'
      readonly exitCode?: number
      readonly exitSignal?: string
    }
  | {
      readonly kind: 'transport-error'
      readonly sessionId: string
      readonly phase: NativeTerminalTransportPhase
      readonly message: string
    }
  | {
      readonly kind: 'aborted'
      readonly sessionId: string
      readonly source: 'caller' | 'signal'
      readonly exitCode?: number
    }

export interface NativeTerminalCleanupIssue {
  readonly phase: NativeTerminalCleanupPhase
  readonly message: string
}

export interface NativeTerminalCleanup {
  readonly terminal: 'restored' | 'not-started' | 'failed'
  readonly signal: 'restored' | 'not-installed' | 'failed'
  readonly remote: 'detached' | 'closed' | 'not-required' | 'unknown'
  readonly issues: readonly NativeTerminalCleanupIssue[]
}

export interface NativeTerminalTransportResult {
  readonly outcome: NativeTerminalTransportOutcome
  readonly cleanup: NativeTerminalCleanup
}

export interface NativeTerminalTransportInput {
  readonly session: AgentTerminalSession
  readonly terminal: NativeTerminalHost
  readonly signals?: NativeTerminalSignalPort
  /** Ctrl+] (ASCII GS) is intentionally not forwarded to the remote PTY. */
  readonly detachChord?: string
  /** Bounds cleanup waits without delaying local terminal restoration forever. */
  readonly cleanupTimeoutMs?: number
}

export interface NativeTerminalTransport {
  run(options?: { readonly signal?: AbortSignal }): Promise<NativeTerminalTransportResult>
}

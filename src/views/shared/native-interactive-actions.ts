export type NativeInteractiveCommand =
  | {
      readonly action: 'start'
      readonly initialPrompt?: string
    }
  | {
      readonly action: 'attach'
      readonly runId?: string
    }

export interface NativeInteractiveAvailability {
  readonly available: boolean
  readonly reason?: string
}

export type NativeInteractiveCommandResult =
  | {
      readonly kind: 'returned'
      readonly runId: string
      readonly outcome: 'detached' | 'exited'
    }
  | {
      readonly kind: 'unavailable'
      readonly reason: string
    }
  | {
      readonly kind: 'error'
      readonly message: string
    }

/** Terminal-only actions. Runtime owns admission and recovery; this port only requests them. */
export interface NativeInteractiveUiActions {
  availability(action: NativeInteractiveCommand['action']): NativeInteractiveAvailability
  run(command: NativeInteractiveCommand): Promise<NativeInteractiveCommandResult>
}

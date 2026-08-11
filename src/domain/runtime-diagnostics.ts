export const BRAID_SANDBOX_INTERACTION_UNSUPPORTED =
  'BRAID_SANDBOX_INTERACTION_UNSUPPORTED' as const
export const BRAID_SANDBOX_CLEANUP_UNCONFIRMED = 'BRAID_SANDBOX_CLEANUP_UNCONFIRMED' as const

const PUBLIC_RUNTIME_DIAGNOSTICS = Object.freeze({
  [BRAID_SANDBOX_INTERACTION_UNSUPPORTED]:
    'Sandbox requested user interaction, but this ephemeral route cannot retain and resume the environment',
  [BRAID_SANDBOX_CLEANUP_UNCONFIRMED]:
    'Sandbox deletion was not acknowledged; resource state is unknown',
})

export function publicRuntimeDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Object.hasOwn(PUBLIC_RUNTIME_DIAGNOSTICS, value)) {
    return undefined
  }
  return PUBLIC_RUNTIME_DIAGNOSTICS[value as keyof typeof PUBLIC_RUNTIME_DIAGNOSTICS]
}

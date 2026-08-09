export interface UiConnectionMetadataDraft {
  readonly kind: 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox'
  readonly name: string
  readonly endpoint: string
  readonly region?: string
  readonly account?: string
}

export interface UiConnectionRemovalPreview {
  readonly connectionId: string
  readonly name: string
  readonly blockers: readonly {
    readonly kind: string
    readonly id: string
    readonly status?: string
    readonly action: string
  }[]
  readonly credential: 'none' | 'unique' | 'shared'
  readonly sharedCredentialConnectionIds: readonly string[]
}

/** View-facing callbacks; no provider, storage, or process type crosses this boundary. */
export interface UiConnectionLifecycle {
  requiresCredential(draft: UiConnectionMetadataDraft): boolean
  create(input: {
    readonly operationId: string
    readonly draft: UiConnectionMetadataDraft
    readonly credential?: Uint8Array
    readonly expectedRevision?: number
  }): Promise<unknown>
  previewRemoval(connectionId: string): UiConnectionRemovalPreview
  remove(input: {
    readonly operationId: string
    readonly connectionId: string
    readonly expectedRevision?: number
  }): Promise<unknown>
}

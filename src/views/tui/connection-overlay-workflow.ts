import type { ConnectionSummary } from '../../app/connection-action-types.js'
import type {
  UiConnectionLifecycle,
  UiConnectionRemovalPreview,
} from '../shared/connection-lifecycle.js'
import { ConfigurationCredential } from './configuration-credential.js'
import {
  ConnectionMetadataEditor,
  type ConnectionMetadataEditorOptions,
} from './connection-metadata-editor.js'
import type { ConnectionMetadataDraft } from './connection-metadata-editor-model.js'
import { ConversationConfirmation } from './conversation-dialogs.js'
import type { ModalCoordinator } from './modal-coordinator.js'
import type { BraidTheme } from './theme.js'

export interface ConnectionOverlayWorkflowOptions {
  readonly theme: BraidTheme
  readonly modals: ModalCoordinator
  readonly lifecycle: UiConnectionLifecycle
  readonly nextOperationId: () => string
  readonly revision: () => number
  readonly openPicker: () => void
  readonly showBlocked: (title: string, reason: string) => void
  readonly requestRender: () => void
}

export class ConnectionOverlayWorkflow {
  readonly #options: ConnectionOverlayWorkflowOptions

  constructor(options: ConnectionOverlayWorkflowOptions) {
    this.#options = options
  }

  openEditor(initialDraft?: Partial<ConnectionMetadataDraft>): void {
    const editorOptions: ConnectionMetadataEditorOptions = {
      theme: this.#options.theme,
      ...(initialDraft === undefined ? {} : { initialDraft }),
      onApply: (draft) => this.#create(draft),
      onCancel: this.#options.openPicker,
      requestRender: this.#options.requestRender,
    }
    this.#options.modals.open(new ConnectionMetadataEditor(editorOptions), {
      anchor: 'center',
      width: '82%',
      minWidth: 36,
      maxHeight: '90%',
    })
  }

  openRemoval(connection: ConnectionSummary): void {
    let preview: UiConnectionRemovalPreview
    try {
      preview = this.#options.lifecycle.previewRemoval(connection.id)
    } catch (error) {
      this.#options.showBlocked(
        'connection removal unavailable',
        error instanceof Error ? error.message : 'The connection could not be inspected',
      )
      return
    }
    if (preview.blockers.length > 0) {
      this.#options.showBlocked(
        'connection removal blocked',
        preview.blockers
          .map((blocker) => `${blocker.kind} ${blocker.id}: ${blocker.action}`)
          .join(' · '),
      )
      return
    }
    let dialog: ConversationConfirmation
    dialog = new ConversationConfirmation({
      theme: this.#options.theme,
      title: 'remove connection',
      target: preview.name,
      detail: removalDetail(preview),
      confirmLabel: 'remove metadata',
      onConfirm: () => {
        void this.#options.lifecycle
          .remove({
            operationId: this.#options.nextOperationId(),
            connectionId: preview.connectionId,
            expectedRevision: this.#options.revision(),
          })
          .then(this.#options.openPicker, (error: unknown) => {
            dialog.setError(error instanceof Error ? error.message : 'Connection removal failed')
            this.#options.requestRender()
          })
      },
      onCancel: this.#options.openPicker,
    })
    this.#options.modals.open(dialog, {
      anchor: 'center',
      width: '72%',
      minWidth: 36,
      maxHeight: 12,
    })
  }

  #create(draft: ConnectionMetadataDraft): Promise<void> {
    const operationId = this.#options.nextOperationId()
    if (!this.#options.lifecycle.requiresCredential(draft)) {
      return this.#commitCreate(operationId, draft)
    }
    return new Promise<void>((resolve, reject) => {
      this.#openCredential(operationId, draft, resolve, reject)
    })
  }

  #openCredential(
    operationId: string,
    draft: ConnectionMetadataDraft,
    resolve: () => void,
    reject: (reason: unknown) => void,
    error?: string,
  ): void {
    const prompt = new ConfigurationCredential({
      theme: this.#options.theme,
      connectionName: draft.name,
      ...(error === undefined ? {} : { error }),
      onSubmit: (credential) => {
        void this.#commitCreate(operationId, draft, credential).then(
          resolve,
          (failure: unknown) => {
            credential.fill(0)
            this.#openCredential(
              operationId,
              draft,
              resolve,
              reject,
              failure instanceof Error ? failure.message : 'Connection creation failed',
            )
          },
        )
      },
      onCancel: () => {
        reject(new Error('Credential entry cancelled'))
        this.openEditor(draft)
      },
    })
    this.#options.modals.open(prompt, {
      anchor: 'center',
      width: '72%',
      minWidth: 36,
      maxHeight: 10,
    })
  }

  async #commitCreate(
    operationId: string,
    draft: ConnectionMetadataDraft,
    credential?: Uint8Array,
  ): Promise<void> {
    try {
      await this.#options.lifecycle.create({
        operationId,
        draft,
        ...(credential === undefined ? {} : { credential }),
        expectedRevision: this.#options.revision(),
      })
      this.#options.openPicker()
    } finally {
      credential?.fill(0)
    }
  }
}

function removalDetail(preview: UiConnectionRemovalPreview): string {
  const credential =
    preview.credential === 'unique'
      ? 'its unshared secure credential will be deleted'
      : preview.credential === 'shared'
        ? `its credential stays because ${preview.sharedCredentialConnectionIds.length} other connection(s) use it`
        : 'no credential is attached'
  return `${credential}; historical records stay; cloud resources are never destroyed`
}

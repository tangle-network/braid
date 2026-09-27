import type {
  ConfigurationSelection,
  ConfigurationSession,
  ConfigurationSessionState,
} from '../../app/configuration-session.js'
import { configurationNeedsCredential } from './configuration-credential.js'
import type { BraidTheme } from './theme.js'
import { WorkspaceRequestForm } from './workspace-request-form.js'

export interface WorkspaceRequestWorkflowOptions {
  readonly session: ConfigurationSession
  readonly theme: BraidTheme
  readonly focused: boolean
  readonly requestRender?: () => void
  readonly requiresCredential?: Parameters<typeof configurationNeedsCredential>[1]
  readonly onInvalid: (state: ConfigurationSessionState) => void
  readonly onCredential: (state: ConfigurationSessionState) => void
  readonly onComplete: (state: ConfigurationSessionState) => void
  readonly onCancel: () => void
}

export function mountWorkspaceRequestForm(
  options: WorkspaceRequestWorkflowOptions,
): WorkspaceRequestForm {
  let selection: ConfigurationSelection | undefined
  try {
    selection = options.session.previewSelection()
  } catch {
    selection = undefined
  }
  return new WorkspaceRequestForm({
    theme: options.theme,
    ...(selection?.workspaceRequest === undefined
      ? {}
      : { initialRequest: selection.workspaceRequest }),
    ...(selection === undefined ? {} : { initialConnection: selection.connection }),
    ...(options.requestRender === undefined ? {} : { requestRender: options.requestRender }),
    onSubmit: (request, lifetime) => {
      const next = options.session.submitWorkspace(request, lifetime)
      if (next.error !== undefined) options.onInvalid(next)
      else if (configurationNeedsCredential(options.session, options.requiresCredential))
        options.onCredential(next)
      else options.onComplete(next)
    },
    onCancel: options.onCancel,
  })
}

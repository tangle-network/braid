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
  let initialRequest: ConfigurationSelection['workspaceRequest']
  try {
    initialRequest = options.session.previewSelection().workspaceRequest
  } catch {
    initialRequest = undefined
  }
  return new WorkspaceRequestForm({
    theme: options.theme,
    ...(initialRequest === undefined ? {} : { initialRequest }),
    ...(options.requestRender === undefined ? {} : { requestRender: options.requestRender }),
    onSubmit: (request) => {
      const next = options.session.submitWorkspace(request)
      if (next.error !== undefined) options.onInvalid(next)
      else if (configurationNeedsCredential(options.session, options.requiresCredential))
        options.onCredential(next)
      else options.onComplete(next)
    },
    onCancel: options.onCancel,
  })
}

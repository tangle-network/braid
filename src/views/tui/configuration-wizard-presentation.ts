import type { SelectItem } from '@earendil-works/pi-tui'
import type { WorkspaceRequest } from '@tangle-network/agent-interface'
import type {
  ConfigurationEffectiveValues,
  ConfigurationSelection,
  ConfigurationSession,
  ConfigurationSessionState,
} from '../../app/configuration-session.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { shortDigest } from './configuration-presenters.js'

export const BACK_TO_PROFILE = '__braid_back_profile__'
export const BACK_TO_CONNECTION = '__braid_back_connection__'
export const BACK_TO_WORKSPACE = '__braid_back_workspace__'
export const APPLY_SELECTION = '__braid_apply_selection__'
export const CANCEL_CONFIGURATION = '__braid_cancel_configuration__'
export const DOWN_ARROW = '\u001b[B'

export function configurationTitle(
  state: ConfigurationSessionState,
  busy: boolean,
  commitError?: string,
): string {
  if (busy) return 'applying selection…'
  switch (state.step) {
    case 'profile':
      return 'profile · choose an AgentProfile'
    case 'connection':
      return 'connection · choose a connection'
    case 'workspace':
      return 'workspace · choose remote files'
    case 'confirm':
      return 'review and start'
    case 'complete':
      return commitError === undefined ? 'selection applied' : 'review and start'
    case 'cancelled':
      return 'setup cancelled'
  }
}

export function configurationExplanation(state: ConfigurationSessionState): string {
  if (state.step === 'profile') return 'Choose the AgentProfile for this run.'
  if (state.step === 'connection') return 'Choose where this profile should run.'
  if (state.step === 'workspace')
    return 'Set the repository and working directory for the cloud sandbox.'
  return 'No changes were made.'
}

export function configurationFooter(state: ConfigurationSessionState, busy: boolean): string {
  if (busy) return 'waiting for the selected connection'
  if (state.step === 'workspace') return 'tab next · shift-tab back · esc cancel'
  if (state.step === 'confirm') return 'enter apply · arrows · ←/esc cancel'
  return 'filter · enter choose · ←/esc cancel'
}

export function configurationItems(
  state: ConfigurationSessionState,
  busy: boolean,
  commitError?: string,
): readonly SelectItem[] {
  if (state.step === 'profile') {
    if (state.profiles.length === 0) {
      return [
        {
          value: CANCEL_CONFIGURATION,
          label: 'No profiles available',
          description: '←/esc close',
        },
      ]
    }
    return state.profiles.map((profile) => ({
      value: profile.id,
      label: profile.label,
      description: profile.description,
    }))
  }
  if (state.step === 'connection') {
    const choices: SelectItem[] = state.connections.length
      ? state.connections.map((connection) => ({
          value: connection.id,
          label: connection.label,
          description: connection.description,
        }))
      : [
          {
            value: CANCEL_CONFIGURATION,
            label: 'No connections available',
            description: 'Add a connection through the product integration',
          },
        ]
    choices.push({
      value: BACK_TO_PROFILE,
      label: '← change AgentProfile',
      description: 'return to the previous step',
    })
    return choices
  }
  if (state.step === 'confirm' || state.step === 'complete') {
    if (state.step === 'complete' && !busy && commitError === undefined) {
      return [{ value: CANCEL_CONFIGURATION, label: 'Close', description: '←/esc close' }]
    }
    return [
      {
        value: APPLY_SELECTION,
        label: busy ? 'Applying…' : 'Apply and start',
        description: 'use this profile and connection for Braid',
      },
      ...(state.step === 'confirm' && state.selectedConnectionId !== undefined
        ? state.connections.find((connection) => connection.id === state.selectedConnectionId)
            ?.kind === 'tangle-sandbox'
          ? [
              {
                value: BACK_TO_WORKSPACE,
                label: '← change workspace',
                description: 'edit repository and working folder',
              },
            ]
          : []
        : []),
      {
        value: BACK_TO_CONNECTION,
        label: '← change connection',
        description: 'choose a different execution location',
      },
      {
        value: BACK_TO_PROFILE,
        label: '← change AgentProfile',
        description: 'choose a different agent definition',
      },
      {
        value: CANCEL_CONFIGURATION,
        label: 'Cancel',
        description: 'leave the current selection unchanged',
      },
    ]
  }
  return [{ value: CANCEL_CONFIGURATION, label: 'Close', description: '←/esc close' }]
}

export function reviewSummary(
  session: ConfigurationSession,
  state: ConfigurationSessionState,
  confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues,
  credentialPrepared = false,
): readonly string[] {
  try {
    const selection = session.previewSelection()
    const profile = state.profiles.find((item) => item.id === selection.profile.id)
    const connection = state.connections.find((item) => item.id === selection.connection.id)
    const effective = effectiveValues(selection, confirmation)
    return [
      `${sanitizeTerminalText(profile?.label ?? selection.profile.displayName)} → ${sanitizeTerminalText(connection?.label ?? selection.connection.name)}`,
      `profile digest ${shortDigest(selection.profileDigest)} · connection ${selection.connection.kind}`,
      `runner: ${sanitizeTerminalText(effective.runner)} · model: ${sanitizeTerminalText(effective.model)}`,
      `effort: ${sanitizeTerminalText(effective.effort)} · workdir: ${sanitizeTerminalText(effective.workdir)}`,
      ...workspaceRequestSummary(effective.workspaceRequest),
      `verification: ${sanitizeTerminalText(effective.verification)}`,
      `unsupported: ${
        effective.unsupported.length > 0
          ? effective.unsupported.map(sanitizeTerminalText).join(', ')
          : 'none'
      }`,
      `credentials ${credentialStatus(selection, credentialPrepared)}`,
    ]
  } catch {
    return ['Effective values are unavailable until both choices are selected.']
  }
}

export function compactReviewSummary(
  session: ConfigurationSession,
  state: ConfigurationSessionState,
  confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues,
  credentialPrepared = false,
): readonly string[] {
  try {
    const selection = session.previewSelection()
    const profile = state.profiles.find((item) => item.id === selection.profile.id)
    const connection = state.connections.find((item) => item.id === selection.connection.id)
    const effective = effectiveValues(selection, confirmation)
    const unsupported = effective.unsupported.length > 0 ? effective.unsupported.join(', ') : 'none'
    return [
      `profile ${profile?.label ?? selection.profile.displayName} → ${connection?.label ?? selection.connection.name}`,
      `cred ${compactCredentialStatus(selection, credentialPrepared)} · conn ${selection.connection.kind} · digest ${compactDigest(selection.profileDigest)}`,
      `runner: ${shortValue(effective.runner, 14)} · model: ${shortValue(effective.model, 16)}`,
      `effort: ${shortValue(effective.effort, 12)} · start in: ${shortValue(effective.workdir, 18)}`,
      ...compactWorkspaceRequestSummary(effective.workspaceRequest),
      `verify: ${shortValue(effective.verification, 18)} · unsupported: ${shortValue(unsupported, 12)}`,
    ].map(sanitizeTerminalText)
  } catch {
    return ['Effective values are unavailable until both choices are selected.']
  }
}

export function configurationReviewSummaries(
  session: ConfigurationSession,
  state: ConfigurationSessionState,
  confirmation: ((selection: ConfigurationSelection) => ConfigurationEffectiveValues) | undefined,
  credentialPrepared: boolean,
): { readonly summary: readonly string[]; readonly compactSummary: readonly string[] } {
  return {
    summary: reviewSummary(session, state, confirmation, credentialPrepared),
    compactSummary: compactReviewSummary(session, state, confirmation, credentialPrepared),
  }
}

function credentialStatus(selection: ConfigurationSelection, prepared: boolean): string {
  if (selection.connection.credentialRef !== undefined) {
    return 'configured outside Braid · value hidden'
  }
  return prepared ? 'ready for secure storage · value hidden' : 'not configured'
}

function compactCredentialStatus(selection: ConfigurationSelection, prepared: boolean): string {
  if (selection.connection.credentialRef !== undefined) return 'hidden'
  return prepared ? 'ready · hidden' : 'not set'
}

function effectiveValues(
  selection: ConfigurationSelection,
  confirmation?: (selection: ConfigurationSelection) => ConfigurationEffectiveValues,
): ConfigurationEffectiveValues {
  if (confirmation !== undefined) return withWorkspaceRequest(selection, confirmation(selection))
  const profile = selection.profile.profile
  return {
    runner: profile.harness ?? 'provider default',
    model: profile.model?.default ?? 'provider default',
    effort: profile.model?.reasoningEffort ?? 'provider default',
    workdir:
      selection.connection.kind === 'tangle-sandbox'
        ? selection.workspaceRequest?.cwd === undefined
          ? 'repository root (provider default)'
          : selection.workspaceRequest.cwd
        : 'workspace-selected workdir',
    ...(selection.workspaceRequest === undefined
      ? {}
      : {
          workspaceRequest: selection.workspaceRequest,
        }),
    verification: `${selection.connection.lastHealth.status}: unverified`,
    unsupported: [],
  }
}

function withWorkspaceRequest(
  selection: ConfigurationSelection,
  confirmed: ConfigurationEffectiveValues,
): ConfigurationEffectiveValues {
  const workspaceRequest = selection.workspaceRequest
  if (workspaceRequest === undefined) return confirmed
  return {
    ...confirmed,
    workspaceRequest: { ...(confirmed.workspaceRequest ?? {}), ...workspaceRequest },
    ...(selection.connection.kind === 'tangle-sandbox' && workspaceRequest.cwd !== undefined
      ? { workdir: workspaceRequest.cwd }
      : {}),
  }
}

function workspaceRequestSummary(
  workspace: Readonly<WorkspaceRequest> | undefined,
): readonly string[] {
  if (workspace === undefined) return []
  const values = [
    workspace.environment === undefined ? undefined : `environment ${workspace.environment}`,
    workspace.image === undefined ? undefined : `image ${workspace.image}`,
    workspace.repoUrl === undefined ? undefined : `repo ${workspace.repoUrl}`,
    workspace.gitRef === undefined ? undefined : `ref ${workspace.gitRef}`,
    workspace.cwd === undefined ? undefined : `start in repo ${workspace.cwd}`,
  ].filter((value): value is string => value !== undefined)
  return values.length === 0
    ? ['cloud workspace: provider defaults']
    : [`cloud workspace · ${values.join(' · ')}`]
}

function compactWorkspaceRequestSummary(
  workspace: Readonly<WorkspaceRequest> | undefined,
): readonly string[] {
  if (workspace === undefined) return []
  const values = [
    workspace.environment === undefined ? undefined : `env ${workspace.environment}`,
    workspace.image === undefined ? undefined : `image ${workspace.image}`,
    workspace.repoUrl === undefined ? undefined : `repo ${workspace.repoUrl}`,
    workspace.gitRef === undefined ? undefined : `ref ${workspace.gitRef}`,
    workspace.cwd === undefined ? undefined : `start in repo ${workspace.cwd}`,
  ].filter((value): value is string => value !== undefined)
  return [
    `cloud: ${values.length > 0 ? values.map((value) => shortValue(value, 18)).join(' · ') : 'defaults'}`,
  ]
}

function compactDigest(value: string): string {
  const digest = shortDigest(value).replace(/^sha256:/u, '')
  return digest.length <= 10 ? digest : `${digest.slice(0, 5)}…${digest.slice(-3)}`
}

function shortValue(value: string, limit: number): string {
  const sanitized = sanitizeTerminalText(value)
  if (sanitized.length <= limit) return sanitized
  return `${sanitized.slice(0, Math.max(1, limit - 4))}…${sanitized.slice(-3)}`
}

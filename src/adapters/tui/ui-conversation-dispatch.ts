import { snapshotWorkspaceRequest, type WorkspaceRequest } from '../../app/workspace-request.js'
import type { BraidApplication } from '../../app/application.js'
import {
  parseConfidentialWorkspaceForkArgument,
  parseConfidentialWorkspaceForkRequest,
} from '../../app/confidential-workspace-fork.js'
import type {
  ForkDestinationProfile,
  ForkPlan,
  ForkPlanInput,
} from '../../app/conversation-types.js'
import { AppError } from '../../app/errors.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import { freezeView, type BraidViewModel, type ForkPreviewView } from '../../views/shared/models.js'

type RunCommandIntent = Extract<BraidIntent, { readonly type: 'run-command' }>
type HeadlessCommandIntent = Extract<BraidIntent, { readonly type: 'headless-command' }>

export interface ConversationDispatchContext {
  readonly app: BraidApplication
  readonly view: () => BraidViewModel
  /** The trusted profile catalog; a fork can select only a profile it resolves. */
  readonly profileConnections?: {
    readonly profiles: {
      resolveForFork(ref: string): Promise<ForkDestinationProfile>
    }
  }
  setNotice(notice: string): void
  setForkPreview(preview: ForkPreviewView): void
}

export async function dispatchConversationRunCommand(
  intent: RunCommandIntent,
  context: ConversationDispatchContext,
): Promise<UiDispatchResult | undefined> {
  const operationId = requiredOperationId(intent.operationId, intent.command)
  switch (intent.command) {
    case 'new': {
      const conversation = await context.app.conversations.lifecycle.create({
        operationId,
        ...(intent.args.length === 0 ? {} : { title: intent.args.join(' ') }),
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'open': {
      const query = intent.args.join(' ').trim()
      if (!query) {
        const conversations = context.app.conversations.lifecycle.list({ status: 'all' })
        return accepted(context, operationId, conversations, 'Choose a conversation')
      }
      const conversations = context.app.conversations.lifecycle.list({
        query,
        status: 'all',
      })
      const exact = conversations.find((conversation) => conversation.id === query)
      const match = exact ?? (conversations.length === 1 ? conversations[0] : undefined)
      if (!match) {
        const notice =
          conversations.length === 0
            ? `No conversation matches ${query}`
            : `${conversations.length} conversations match; press Ctrl+O to choose`
        return accepted(context, operationId, conversations, notice)
      }
      const conversation = await context.app.conversations.lifecycle.open({
        operationId,
        conversationId: match.id,
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'branch': {
      const branch = await context.app.conversations.branches.create({
        operationId,
        ...(intent.args[0] === undefined ? {} : { throughMessageId: intent.args[0] }),
      })
      return accepted(context, operationId, branch, 'Created branch')
    }
    case 'clone': {
      const conversation = await context.app.conversations.branches.clone({
        operationId,
        ...(intent.args.length === 0 ? {} : { title: intent.args.join(' ') }),
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'fork': {
      const workspace = intent.args.includes('--workspace')
      const runner = flagValue(intent.args, '--runner')
      const destinationProvider = flagValue(intent.args, '--provider')
      const connectionId = flagValue(intent.args, '--connection')
      const profileRef = flagValue(intent.args, '--profile')
      if (
        intent.args.some((argument) => argument === '--profile' || argument === '--profile=') &&
        profileRef === undefined
      )
        throw new AppError('INVALID_FORK_PLAN', '/fork --profile requires a profile reference')
      const throughMessageId = intent.args.find((argument) => argument.startsWith('message-'))
      const confidential = confidentialRequestForForkArgs(intent.args)
      const text = forkText(intent.args, throughMessageId)
      const destinationProfile = await resolveForkProfile(context, profileRef)
      const input = {
        operationId,
        kind: workspace
          ? 'workspace'
          : runner === undefined && connectionId === undefined && profileRef === undefined
            ? 'conversation'
            : 'cross-runner',
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
        ...(runner === undefined ? {} : { runner }),
        ...(destinationProvider === undefined ? {} : { destinationProvider }),
        ...(connectionId === undefined ? {} : { connectionId }),
        ...(confidential === undefined ? {} : { confidential }),
        ...(text === undefined ? {} : { text }),
        ...(destinationProfile === undefined ? {} : { destinationProfile }),
      } satisfies ForkPlanInput
      const plan = await context.app.conversations.branches.plan(input)
      context.setForkPreview(forkPreview(plan, input))
      return accepted(
        context,
        operationId,
        plan,
        plan.allowed ? 'Review the fork before creating it' : (plan.reason ?? 'Fork unavailable'),
      )
    }
    case 'runner':
    case 'model':
    case 'effort': {
      if (intent.args.length !== 1) throw new Error(`/${intent.command} requires exactly one value`)
      const value = intent.args[0]
      if (value === undefined) throw new Error(`/${intent.command} requires a value`)
      const branch = await context.app.conversations.branches.setRunOverrides({
        operationId,
        [intent.command]: value,
      })
      return accepted(
        context,
        operationId,
        branch,
        `${overrideLabel(intent.command)} set for this branch`,
      )
    }
    case 'export': {
      const format = exportFormat(intent.args[0])
      const result = await context.app.conversations.exports.export({ operationId, format })
      return accepted(
        context,
        operationId,
        result,
        `Prepared ${format.toUpperCase()} export (${result.bytes} bytes)`,
      )
    }
    case 'import': {
      const result = await context.app.conversations.imports.import({
        operationId,
        source: intent.args.join(' ').trim(),
      })
      return accepted(context, operationId, result, 'Imported conversation safely offline')
    }
    default:
      return undefined
  }
}

export async function dispatchConversationHeadlessCommand(
  intent: HeadlessCommandIntent,
  context: ConversationDispatchContext,
): Promise<UiDispatchResult | undefined> {
  const params = intent.params
  switch (intent.command) {
    case 'set_run_override': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const clear = optionalBoolean(params, 'clear')
      const branch = await context.app.conversations.branches.setRunOverrides({
        operationId,
        ...optionalString(params, 'runner'),
        ...optionalString(params, 'model'),
        ...optionalString(params, 'effort'),
        ...optionalString(params, 'mode'),
        ...(clear === undefined ? {} : { clear }),
      })
      return accepted(context, operationId, branch, 'Run configuration updated')
    }
    case 'new_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const conversation = await context.app.conversations.lifecycle.create({
        operationId,
        ...optionalString(params, 'title'),
        ...renamedOptionalString(params, 'profileRef', 'profileId'),
        ...optionalString(params, 'connectionId'),
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'list_conversations': {
      const status = optionalStatus(params.status)
      const conversations = context.app.conversations.lifecycle.list({
        ...optionalString(params, 'query'),
        ...optionalString(params, 'workspace'),
        ...(status === undefined ? {} : { status }),
      })
      return accepted(context, undefined, conversations)
    }
    case 'open_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const conversation = await context.app.conversations.lifecycle.open({
        operationId,
        conversationId: requiredString(params, 'conversationId', intent.command),
        ...optionalString(params, 'branchId'),
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'rename_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const conversation = await context.app.conversations.lifecycle.rename({
        operationId,
        conversationId: requiredString(params, 'conversationId', intent.command),
        title: requiredString(params, 'title', intent.command),
      })
      return accepted(context, operationId, conversation, `Renamed to ${conversation.title}`)
    }
    case 'archive_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const archived = params.archived
      if (typeof archived !== 'boolean') {
        throw new Error('archive_conversation.params.archived must be a boolean')
      }
      const conversation = await context.app.conversations.lifecycle.archive({
        operationId,
        conversationId: requiredString(params, 'conversationId', intent.command),
        archived,
      })
      return accepted(
        context,
        operationId,
        conversation,
        archived ? `Archived ${conversation.title}` : `Restored ${conversation.title}`,
      )
    }
    case 'delete_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const conversation = await context.app.conversations.lifecycle.delete({
        operationId,
        conversationId: requiredString(params, 'conversationId', intent.command),
      })
      return accepted(context, operationId, conversation, 'Deleted conversation')
    }
    case 'set_draft': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const result = await context.app.conversations.drafts.set({
        operationId,
        text: requiredString(params, 'text', intent.command),
        ...optionalString(params, 'conversationId'),
        ...optionalString(params, 'branchId'),
      })
      return accepted(context, operationId, result.draft)
    }
    case 'import_conversation': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const result = await context.app.conversations.imports.import({
        operationId,
        ...optionalString(params, 'content'),
        ...optionalString(params, 'source'),
        ...optionalString(params, 'title'),
      })
      return accepted(context, operationId, result, 'Imported conversation safely offline')
    }
    case 'branch': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const branch = await context.app.conversations.branches.create({
        operationId,
        ...optionalString(params, 'conversationId'),
        ...optionalString(params, 'branchId'),
        ...renamedOptionalString(params, 'messageId', 'throughMessageId'),
        ...optionalString(params, 'text'),
      })
      return accepted(context, operationId, branch, 'Created branch')
    }
    case 'clone': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const conversation = await context.app.conversations.branches.clone({
        operationId,
        ...optionalString(params, 'conversationId'),
        ...optionalString(params, 'branchId'),
        ...optionalString(params, 'title'),
      })
      return accepted(context, operationId, conversation, `Opened ${conversation.title}`)
    }
    case 'plan_fork': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const input = await forkInput(params, operationId, context)
      const plan = await context.app.conversations.branches.plan(input)
      context.setForkPreview(forkPreview(plan, input))
      return accepted(context, operationId, plan, plan.reason)
    }
    case 'execute_fork': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const branch = await context.app.conversations.branches.execute({
        ...(await forkInput(params, operationId, context)),
        planDigest: requiredString(params, 'planDigest', intent.command),
      })
      return accepted(context, operationId, branch, 'Created fork')
    }
    case 'export': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const target = optionalStringValue(params.target)
      const result = await context.app.conversations.exports.export({
        operationId,
        ...(target === undefined || target === 'conversation'
          ? {}
          : { conversationId: target.replace(/^conversation:/u, '') }),
        format: exportFormat(optionalStringValue(params.format)),
        ...optionalString(params, 'destination'),
      })
      return accepted(
        context,
        operationId,
        result,
        `Prepared ${result.format.toUpperCase()} export`,
      )
    }
    default:
      return undefined
  }
}

async function forkInput(
  params: Readonly<Record<string, unknown>>,
  operationId: string,
  context: ConversationDispatchContext,
) {
  const workspace = params.workspace === true || params.workspace === 'true'
  const runner = optionalStringValue(params.runner)
  const confidential = parseConfidentialWorkspaceForkRequest(params.confidential)
  const workspaceRequest = snapshotWorkspaceRequest(
    params.workspaceRequest as WorkspaceRequest | undefined,
  )
  if (params.profileRef !== undefined && optionalStringValue(params.profileRef) === undefined)
    throw new AppError('INVALID_FORK_PLAN', 'profileRef must be a non-empty profile reference')
  const profileRef = optionalStringValue(params.profileRef)
  const destinationProfile = await resolveForkProfile(context, profileRef)
  return {
    operationId,
    kind: workspace
      ? ('workspace' as const)
      : runner === undefined && params.connectionId === undefined && profileRef === undefined
        ? ('conversation' as const)
        : ('cross-runner' as const),
    ...optionalString(params, 'conversationId'),
    ...optionalString(params, 'branchId'),
    ...optionalString(params, 'connectionId'),
    ...renamedOptionalString(params, 'messageId', 'throughMessageId'),
    ...optionalString(params, 'runner'),
    ...optionalString(params, 'model'),
    ...optionalString(params, 'effort'),
    ...optionalString(params, 'text'),
    ...optionalString(params, 'acceptedDigest'),
    ...optionalString(params, 'destinationProvider'),
    ...(confidential === undefined ? {} : { confidential }),
    ...(workspaceRequest === undefined ? {} : { workspaceRequest }),
    ...(destinationProfile === undefined ? {} : { destinationProfile }),
  }
}

/** Resolve a fork destination only through the trusted profile catalog. */
async function resolveForkProfile(
  context: ConversationDispatchContext,
  profileRef: string | undefined,
): Promise<ForkDestinationProfile | undefined> {
  if (profileRef === undefined) return undefined
  const profiles = context.profileConnections?.profiles
  if (profiles === undefined)
    throw new AppError(
      'PROFILE_SELECTION_UNAVAILABLE',
      'This session has no profile catalog, so a fork cannot change profile',
    )
  return profiles.resolveForFork(profileRef)
}

function confidentialRequestForForkArgs(
  args: readonly string[],
): ReturnType<typeof parseConfidentialWorkspaceForkArgument> | undefined {
  const matches: Array<{ readonly index: number; readonly inline?: string }> = []
  for (const [index, argument] of args.entries()) {
    if (argument === '--confidential') matches.push({ index })
    else if (argument.startsWith('--confidential='))
      matches.push({ index, inline: argument.slice('--confidential='.length) })
  }
  if (matches.length === 0) return undefined
  if (matches.length > 1)
    throw new AppError('INVALID_FORK_PLAN', 'Specify one confidential placement request')
  const match = matches[0]
  if (match === undefined) return undefined
  const raw = match.inline ?? args[match.index + 1]
  if (raw === undefined || raw.startsWith('--'))
    throw new AppError('INVALID_FORK_PLAN', 'Confidential placement request requires JSON')
  return parseConfidentialWorkspaceForkArgument(raw)
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const inline = args.find((argument) => argument.startsWith(`${flag}=`))
  if (inline !== undefined) return inline.slice(flag.length + 1) || undefined
  const index = args.indexOf(flag)
  const value = index < 0 ? undefined : args[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

function forkText(args: readonly string[], boundary: string | undefined): string | undefined {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === undefined) continue
    if (value === '--workspace' || value === boundary) continue
    if (
      value === '--runner' ||
      value === '--provider' ||
      value === '--confidential' ||
      value === '--connection' ||
      value === '--profile'
    ) {
      index += 1
      continue
    }
    if (
      value.startsWith('--runner=') ||
      value.startsWith('--provider=') ||
      value.startsWith('--connection=') ||
      value.startsWith('--profile=') ||
      value.startsWith('--confidential=')
    )
      continue
    values.push(value)
  }
  const text = values.join(' ').trim()
  return text === '' ? undefined : text
}

function forkPreview(plan: ForkPlan, input: ForkPlanInput): ForkPreviewView {
  const {
    operationId: _operationId,
    kind: _kind,
    throughMessageId,
    destinationProfile,
    ...params
  } = input
  // Execution re-resolves the reference, so a changed profile file cannot
  // reuse the reviewed plan digest.
  const executionParams = freezeView({
    ...params,
    conversationId: plan.sourceConversationId,
    branchId: plan.sourceBranchId,
    workspace: plan.kind === 'workspace',
    ...(throughMessageId === undefined ? {} : { messageId: throughMessageId }),
    ...(destinationProfile === undefined ? {} : { profileRef: destinationProfile.ref }),
  })
  const profile = plan.profileSelection
  const execution = Object.freeze(
    Object.defineProperties(
      { operationId: plan.operationId, planDigest: plan.digest },
      {
        planDigest: { enumerable: false, writable: false, configurable: false },
        params: { value: executionParams, enumerable: false, writable: false, configurable: false },
      },
    ),
  )
  const preview: ForkPreviewView = {
    source: `${plan.sourceConversationId} / ${plan.sourceBranchId}`,
    destination: `${plan.sourceConversationId} / ${plan.destinationBranchId}`,
    kind: plan.kind,
    execution,
    fields: [
      {
        label: 'conversation context',
        source: plan.context.sourceBoundary,
        destination: `${plan.context.messages.length} messages`,
      },
      ...(profile === undefined
        ? []
        : [
            { label: 'profile', source: profile.sourceName, destination: profile.name },
            {
              label: 'copied context',
              source: 'history',
              destination: copiedContextSummary(plan),
            },
          ]),
      { label: 'provider session', source: 'current', destination: 'new' },
      ...(plan.destinationConnectionId === undefined
        ? []
        : [
            {
              label: 'connection',
              source: 'source connection',
              destination: plan.destinationConnectionId,
            },
          ]),
      { label: 'workspace', source: 'current', destination: plan.environment },
    ],
    allowed: plan.allowed,
    ...(plan.reason === undefined ? {} : { unavailableReason: plan.reason }),
  }
  Object.defineProperty(preview, 'plan', {
    value: freezeView(plan),
    enumerable: false,
    writable: false,
    configurable: false,
  })
  return Object.freeze(preview)
}

/** Summarize the exact canonical plan the destination profile receives. */
function copiedContextSummary(plan: ForkPlan): string {
  const messages = plan.portableContextPlan?.messages
  if (messages === undefined) return 'unavailable'
  const included = messages.filter((message) => message.action === 'include')
  const parts = included.flatMap((message) => message.parts)
  const omitted =
    messages.length - included.length + parts.filter((part) => part.action === 'omit').length
  const transformed = parts.filter((part) => part.action === 'transform').length
  return [
    `${included.length} ${included.length === 1 ? 'message' : 'messages'}`,
    ...(omitted === 0 ? [] : [`${omitted} omitted`]),
    ...(transformed === 0 ? [] : [`${transformed} transformed`]),
  ].join(' · ')
}

function accepted(
  context: ConversationDispatchContext,
  operationId: string | undefined,
  data: unknown,
  notice?: string,
): UiDispatchResult {
  if (notice !== undefined) context.setNotice(notice)
  return {
    kind: 'accepted',
    revision: context.app.state().revision,
    ...(operationId === undefined ? {} : { operationId }),
    data,
    ...(notice === undefined ? {} : { notice }),
  }
}

function requiredOperationId(value: string | undefined, command: string): string {
  if (!value) throw new Error(`${command} requires operationId`)
  return value
}

function requiredString(
  params: Readonly<Record<string, unknown>>,
  key: string,
  command: string,
): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${command}.params.${key} must be a non-empty string`)
  }
  return value
}

function optionalString(
  params: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, string>> {
  const value = optionalStringValue(params[key])
  return value === undefined ? {} : { [key]: value }
}

function renamedOptionalString(
  params: Readonly<Record<string, unknown>>,
  source: string,
  destination: string,
): Readonly<Record<string, string>> {
  const value = optionalStringValue(params[source])
  return value === undefined ? {} : { [destination]: value }
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalBoolean(
  params: Readonly<Record<string, unknown>>,
  key: string,
): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  return value
}

function overrideLabel(command: 'runner' | 'model' | 'effort'): string {
  return command === 'effort'
    ? 'Thinking effort'
    : `${command[0]?.toUpperCase()}${command.slice(1)}`
}

function optionalStatus(value: unknown): 'active' | 'archived' | 'all' | undefined {
  if (value === undefined) return undefined
  if (value === 'active' || value === 'archived' || value === 'all') return value
  throw new Error('list_conversations.params.status must be active, archived, or all')
}

function exportFormat(value: string | undefined): 'json' | 'markdown' {
  if (value === undefined || value === 'json') return 'json'
  if (value === 'markdown' || value === 'md') return 'markdown'
  throw new Error('export format must be json or markdown')
}

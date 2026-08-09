import type { BraidApplication } from '../../app/application.js'
import type { ForkPlan } from '../../app/conversation-types.js'
import type { BraidIntent, UiDispatchResult } from '../../views/shared/intents.js'
import type { BraidViewModel, ForkPreviewView } from '../../views/shared/models.js'

type RunCommandIntent = Extract<BraidIntent, { readonly type: 'run-command' }>
type HeadlessCommandIntent = Extract<BraidIntent, { readonly type: 'headless-command' }>

export interface ConversationDispatchContext {
  readonly app: BraidApplication
  readonly view: () => BraidViewModel
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
      const throughMessageId = intent.args.find((argument) => argument !== '--workspace')
      const plan = context.app.conversations.branches.plan({
        operationId,
        kind: workspace ? 'workspace' : 'conversation',
        ...(throughMessageId === undefined ? {} : { throughMessageId }),
      })
      context.setForkPreview(forkPreview(plan))
      return accepted(
        context,
        operationId,
        plan,
        plan.allowed ? 'Review the fork before creating it' : (plan.reason ?? 'Fork unavailable'),
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
      const plan = context.app.conversations.branches.plan(forkInput(params, operationId))
      context.setForkPreview(forkPreview(plan))
      return accepted(context, operationId, plan, plan.reason)
    }
    case 'execute_fork': {
      const operationId = requiredOperationId(intent.operationId, intent.command)
      const branch = await context.app.conversations.branches.execute({
        ...forkInput(params, operationId),
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

function forkInput(params: Readonly<Record<string, unknown>>, operationId: string) {
  const workspace = params.workspace === true || params.workspace === 'true'
  return {
    operationId,
    kind: workspace ? ('workspace' as const) : ('conversation' as const),
    ...optionalString(params, 'conversationId'),
    ...optionalString(params, 'branchId'),
    ...renamedOptionalString(params, 'messageId', 'throughMessageId'),
    ...optionalString(params, 'runner'),
    ...optionalString(params, 'model'),
    ...optionalString(params, 'effort'),
  }
}

function forkPreview(plan: ForkPlan): ForkPreviewView {
  return {
    source: `${plan.sourceConversationId} / ${plan.sourceBranchId}`,
    destination: `${plan.sourceConversationId} / ${plan.destinationBranchId}`,
    kind: plan.kind,
    fields: [
      { label: 'operation id', source: plan.operationId, destination: plan.operationId },
      { label: 'plan digest', source: plan.digest, destination: plan.digest },
      {
        label: 'conversation context',
        source: plan.context.sourceBoundary,
        destination: `${plan.context.messages.length} messages`,
      },
      { label: 'provider session', source: 'current', destination: 'new' },
      { label: 'workspace', source: 'current', destination: plan.environment },
    ],
    allowed: plan.allowed,
    ...(plan.reason === undefined ? {} : { unavailableReason: plan.reason }),
  }
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

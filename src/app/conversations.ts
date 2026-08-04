import { ConversationBranches } from './conversation-branches.js'
import { ConversationContext } from './conversation-context.js'
import { ConversationDrafts } from './conversation-drafts.js'
import { ConversationExports } from './conversation-exports.js'
import { ConversationImports } from './conversation-imports.js'
import { ConversationLifecycle } from './conversation-lifecycle.js'
import type { ConversationHost } from './conversation-types.js'

/**
 * A small facade over focused conversation services.
 *
 * It owns no state: every read comes from the canonical Braid projection and
 * every mutation goes through the canonical application event stream.
 */
export class ConversationActions {
  readonly lifecycle: ConversationLifecycle
  readonly branches: ConversationBranches
  readonly context: ConversationContext
  readonly drafts: ConversationDrafts
  readonly exports: ConversationExports
  readonly imports: ConversationImports

  constructor(host: ConversationHost) {
    this.lifecycle = new ConversationLifecycle(host)
    this.branches = new ConversationBranches(host)
    this.context = new ConversationContext(host)
    this.drafts = new ConversationDrafts(host)
    this.exports = new ConversationExports(host)
    this.imports = new ConversationImports(host)
  }
}

export type {
  SetConversationDraftInput,
  SetConversationDraftResult,
} from './conversation-drafts.js'
export type {
  ConversationExportDocument,
  ExportConversationInput,
  ExportConversationResult,
} from './conversation-exports.js'
export type {
  ImportConversationInput,
  ImportConversationResult,
} from './conversation-imports.js'
export type {
  CloneConversationInput,
  ConversationListQuery,
  CreateBranchInput,
  CreateConversationInput,
  ForkPlan,
  ForkPlanInput,
  OpenConversationInput,
  PlanContextInput,
  UpdateConversationInput,
} from './conversation-types.js'

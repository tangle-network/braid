export {
  AppError,
  BraidApplication,
  type SendInput,
  type SendReceipt,
} from './app/application.js'
export {
  createBraidApplication,
  type CompositionOptions,
  STARTER_PROFILE,
} from './app/composition.js'
export { buildAppView, type AppView, type MessageView } from './app/view-model.js'
export type { BraidEvent, BraidEventEnvelope, TurnUsage } from './domain/events.js'
export { reduceEvent, replayEvents } from './domain/reducer.js'
export type { BraidMessage, BraidRun, BraidState } from './domain/state.js'
export {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
} from './views/headless/protocol.js'
export { sanitizeTerminalText } from './views/shared/sanitize.js'
export {
  answerSpecContainsSecret,
  canonicalInteractionData,
  interactionAnswerTypes,
  interactionResponseDigest,
  parseInteractionRequest,
  permissionScopeOffered,
  publicInteractionData,
  validateInteractionData,
  validateAnswerSpec,
  type InteractionDataValidation,
  type AnswerSpecValidation,
  type InteractionOutcome,
  type InteractionRequestValidation,
  type NonSecretInteractionData,
  type SafeInteractionRequest,
} from './domain/interaction.js'
export {
  initialInteractionState,
  interactionKey,
  type AutomationAuditRecord,
  type AutomationRuleMatcher,
  type AutomationRuleRecord,
  type FeedbackDecisionRecord,
  type InteractionEvent,
  type InteractionEventEnvelope,
  type InteractionQueueState,
  type InteractionRecord,
  type InteractionResolution,
  type InteractionStatus,
} from './domain/interaction-state.js'
export { replayInteractionEvents, reduceInteractionEvent } from './domain/interaction-reducer.js'
export {
  InteractionController,
  InteractionError,
  type AutomationCandidate,
  type AutomationDryRunInput,
  type AutomationDryRunResult,
  type CreateAutomationRuleInput,
  type InteractionControllerOptions,
  type InteractionSubscriber,
} from './controllers/interaction-controller.js'
export type {
  CancelInteractionInput,
  InteractionAck,
  InteractionCapabilities,
  InteractionControllerPort,
  InteractionReceiveResult,
  InteractionResponseResult,
  InteractionRuntimePort,
  ReceiveInteractionInput,
  ReconciledInteraction,
  RespondInteractionInput,
} from './ports/interactions.js'
export {
  buildAnswerSpecView,
  buildInteractionView,
  buildInteractionViews,
  buildPermissionView,
  buildPlanView,
  buildQuestionView,
  type AnswerFieldView,
  type AnswerSpecView,
  type InteractionSurface,
  type InteractionSubjectView,
  type InteractionViewModel,
} from './views/shared/interaction.js'
export {
  keyboardAnswerForView,
  responseForInteractionIntent,
  type InteractionKeyboardIntent,
} from './views/shared/interaction-intent.js'
export {
  DeterministicInteractionRuntime,
  type DeterministicInteractionRuntimeOptions,
} from './testing/deterministic-interaction-runtime.js'

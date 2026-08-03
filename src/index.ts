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
export {
  createApplicationUiController,
  ApplicationUiController,
  buildBraidViewModel,
} from './adapters/tui/application-ui-controller.js'
export {
  COMMAND_DEFINITIONS,
  COMMAND_NAMES,
  commandAvailability,
  commandItems,
  completeCommands,
  parseCommandInput,
} from './views/shared/command-registry.js'
export type {
  BraidIntent,
  BraidUiController,
  UiDispatchResult,
  UiEvent,
} from './views/shared/intents.js'
export type {
  AnalysisView,
  BraidViewModel,
  CapabilityMap,
  ForkPreviewView,
  HeadlessState,
  InteractionView,
  ViewStatus,
} from './views/shared/models.js'
export {
  sanitizeClipboardText,
  sanitizeDiff,
  sanitizeForSurface,
  sanitizeImageAlt,
  sanitizeMarkdown,
  sanitizeNotification,
  sanitizeTerminalText,
  sanitizeTitle,
  sanitizeUrl,
} from './views/shared/sanitize.js'

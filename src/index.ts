export {
  closeHeadlessKeyFile,
  openHeadlessKeyFile,
  readHeadlessKey,
  rejectEnvironmentKeySource,
} from './adapters/credentials/headless-key.js'
export { MemoryCredentialStore } from './adapters/credentials/memory.js'
export {
  createOperatingSystemCredentialStore,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  WindowsCredentialManagerStore,
} from './adapters/credentials/os.js'
export {
  AgentRuntimeExecutionPort,
  type AgentTurnBackendResolver,
} from './adapters/runtime/agent-runtime-execution.js'
export { MemoryStorage } from './adapters/storage/memory.js'
export type { DurableBoundaryHook, SqliteStorageOptions } from './adapters/storage/sqlite.js'
export {
  openSqliteStorage,
  SqliteStorage,
} from './adapters/storage/sqlite.js'
export { SQLITE_DRIVER_PACKAGE, SQLITE_DRIVER_VERSION } from './adapters/storage/sqlite-driver.js'
export { StorageError } from './adapters/storage/sqlite-errors.js'
export {
  ApplicationUiController,
  buildBraidViewModel,
  createApplicationUiController,
} from './adapters/tui/application-ui-controller.js'
export { createNativeTerminalTransport } from './adapters/tui/native-terminal-transport.js'
export {
  AppError,
  BraidApplication,
  type SendInput,
  type SendReceipt,
} from './app/application.js'
export {
  type CompositionOptions,
  createBraidApplication,
  createDurableBraidApplication,
  type DurableBraidApplication,
  type DurableCompositionOptions,
  STARTER_PROFILE,
} from './app/composition.js'
export type {
  CloneConversationInput,
  ConversationListQuery,
  CreateBranchInput,
  CreateConversationInput,
  ForkPlan,
  ForkPlanInput,
  OpenConversationInput,
  PlanContextInput,
  SetRunOverridesInput,
  UpdateConversationInput,
  WorkspaceForkCleanupInput,
  WorkspaceForkCleanupResult,
} from './app/conversations.js'
export {
  type EffectContext,
  EffectCoordinator,
  EffectCoordinatorError,
  type EffectDispatchResult,
  type EffectHandle,
  type EffectHandler,
  type EffectIntent,
  effectRequestDigest,
  SerializedEffectCoordinator,
} from './app/effect-coordinator.js'
export { FailClosedJournal } from './app/fail-closed-journal.js'
export { MemoryJournal } from './app/journal.js'
export { StorageJournal } from './app/storage-journal.js'
export {
  canonicalDigest,
  canonicalJson,
} from './domain/canonical.js'
export type * from './domain/entities.js'
export type {
  EffectRecord as DomainEffectRecord,
  OperationRecord as DomainOperationRecord,
} from './domain/entities.js'
export type {
  BraidEvent,
  BraidEventEnvelope,
  DomainBraidEventMap,
  JournalEventEnvelope,
  LegacyBraidEvent,
  ProviderEventMeta,
  RunTerminalStatus,
  TurnUsage,
} from './domain/events.js'
export * from './domain/ids.js'
export {
  assertBraidState,
  assertIdKind,
  assertJsonValue,
  DomainInvariantError,
} from './domain/invariants.js'
export { canonicalProjectionChecksum } from './domain/projection-checksum.js'
export {
  type ContextTransferReceipt,
  createAdmissionReceipt,
  createPortableContextPlan,
  type NativeContextBoundaryProof,
  type PortableContextPlan,
  type RequestedInteractions,
  type RunAdmissionReceipt,
  type RunCapabilities,
} from './domain/receipts.js'
export {
  DuplicateEventConflictError,
  initialDomainState,
  reduceEvent,
  replayEvents,
  replayJournal,
  SequenceGapError,
} from './domain/reducer.js'
export type {
  BraidRuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeEventSummary,
} from './domain/runtime-events.js'
export type {
  BraidActivity,
  BraidInteraction,
  BraidMessage,
  BraidMessagePart,
  BraidRun,
  BraidState,
  QueuedInput,
} from './domain/state.js'
export type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from './ports/credentials.js'
export { CredentialError, credentialRef } from './ports/credentials.js'
export type {
  EffectOutcomeStatus,
  EffectRecord,
  EffectStatus,
  EffectStoragePort,
  JournalPort,
} from './ports/effect-storage.js'
export type {
  ContextTransferExecutionPort,
  ControlAcknowledgement,
  ExecuteTurnInput,
  ExecutionAdmission,
  ExecutionPort,
  ProviderRunSnapshot,
} from './ports/execution.js'
export {
  capabilitiesFromEnvironment,
  DEFAULT_RUN_CAPABILITIES,
  UNKNOWN_RUN_CAPABILITIES,
} from './ports/execution.js'
export type {
  NativeInteractiveExecutionControl,
  NativeInteractiveRunOutcome,
} from './ports/native-interactive-execution.js'
export type {
  NativeTerminalCleanup,
  NativeTerminalCleanupIssue,
  NativeTerminalCleanupPhase,
  NativeTerminalHost,
  NativeTerminalSignalPort,
  NativeTerminalTransport,
  NativeTerminalTransportInput,
  NativeTerminalTransportOutcome,
  NativeTerminalTransportPhase,
  NativeTerminalTransportResult,
} from './ports/native-terminal-transport.js'
export type {
  AppendResult,
  BackupReport,
  DestructionReport,
  IntegrityReport,
  JournalEvent,
  MigrationReport,
  MissingHistory,
  OperationIntent,
  OperationRecord,
  ProjectionSnapshot,
  RedactionReport,
  ReplayResult,
  RestoreReport,
  RetentionReport,
  StorageArtifacts,
  StoragePort,
  StoredJournalEvent,
} from './ports/storage.js'
export {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
} from './views/headless/protocol.js'
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
  UiFrameTiming,
  UiSubscriptionOptions,
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
export type {
  NativeInteractiveAvailability,
  NativeInteractiveCommand,
  NativeInteractiveCommandResult,
  NativeInteractiveUiActions,
} from './views/shared/native-interactive-actions.js'
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

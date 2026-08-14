export {
  AgentRuntimeExecutionPort,
  type AgentTurnBackendResolver,
} from './adapters/runtime/agent-runtime-execution.js'
export {
  AppError,
  BraidApplication,
  type SendInput,
  type SendReceipt,
} from './app/application.js'
export {
  createBraidApplication,
  createDurableBraidApplication,
  type CompositionOptions,
  type DurableBraidApplication,
  type DurableCompositionOptions,
  STARTER_PROFILE,
} from './app/composition.js'
export { MemoryJournal } from './app/journal.js'
export {
  EffectCoordinator,
  EffectCoordinatorError,
  effectRequestDigest,
  SerializedEffectCoordinator,
  type EffectContext,
  type EffectDispatchResult,
  type EffectHandle,
  type EffectHandler,
  type EffectIntent,
} from './app/effect-coordinator.js'
export type {
  BraidEvent,
  BraidEventEnvelope,
  DomainBraidEventMap,
  JournalEventEnvelope,
  LegacyBraidEvent,
  TurnUsage,
} from './domain/events.js'
export {
  DuplicateEventConflictError,
  initialDomainState,
  reduceEvent,
  replayEvents,
  replayJournal,
  SequenceGapError,
} from './domain/reducer.js'
export {
  canonicalDigest,
  canonicalJson,
} from './domain/canonical.js'
export { canonicalProjectionChecksum } from './domain/projection-checksum.js'
export type {
  BraidMessage,
  BraidRun,
  BraidState,
} from './domain/state.js'
export type * from './domain/entities.js'
export type {
  EffectRecord as DomainEffectRecord,
  OperationRecord as DomainOperationRecord,
} from './domain/entities.js'
export * from './domain/ids.js'
export {
  assertBraidState,
  assertIdKind,
  assertJsonValue,
  assertNoSecretInteractionData,
  DomainInvariantError,
} from './domain/invariants.js'
export type {
  EffectOutcomeStatus,
  EffectRecord,
  EffectStatus,
  EffectStoragePort,
  JournalPort,
} from './ports/effect-storage.js'
export type {
  CredentialPort,
  CredentialRef,
  CredentialStoreInput,
  SecretHandle,
} from './ports/credentials.js'
export { CredentialError, credentialRef } from './ports/credentials.js'
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
  RetentionReport,
  StoragePort,
  StorageArtifacts,
  StoredJournalEvent,
  RestoreReport,
} from './ports/storage.js'
export { MemoryStorage } from './adapters/storage/memory.js'
export {
  SqliteStorage,
  openSqliteStorage,
} from './adapters/storage/sqlite.js'
export type { DurableBoundaryHook, SqliteStorageOptions } from './adapters/storage/sqlite.js'
export { SQLITE_DRIVER_PACKAGE, SQLITE_DRIVER_VERSION } from './adapters/storage/sqlite-driver.js'
export { StorageError } from './adapters/storage/sqlite-errors.js'
export { MemoryCredentialStore } from './adapters/credentials/memory.js'
export {
  createOperatingSystemCredentialStore,
  LinuxSecretServiceCredentialStore,
  MacOsKeychainCredentialStore,
  WindowsCredentialManagerStore,
} from './adapters/credentials/os.js'
export {
  closeHeadlessKeyFile,
  openHeadlessKeyFile,
  readHeadlessKey,
  rejectEnvironmentKeySource,
} from './adapters/credentials/headless-key.js'
export type {
  ProviderEventMeta,
  RunTerminalStatus,
} from './domain/events.js'
export {
  type ContextTransferReceipt,
  createAdmissionReceipt,
  createPortableContextPlan,
  type NativeContextBoundaryProof,
  type PortableContextPlan,
  type RunAdmissionReceipt,
  type RunCapabilities,
} from './domain/receipts.js'
export type {
  BraidRuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeEventSummary,
} from './domain/runtime-events.js'
export type {
  BraidActivity,
  BraidInteraction,
  BraidMessagePart,
  QueuedInput,
} from './domain/state.js'
export type {
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
export {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
} from './views/headless/protocol.js'
export { StorageJournal } from './app/storage-journal.js'
export { FailClosedJournal } from './app/fail-closed-journal.js'
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

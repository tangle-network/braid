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
export { buildAppView, type AppView, type MessageView } from './app/view-model.js'
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
  canonicalProjectionChecksum,
} from './domain/canonical.js'
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
export {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
} from './views/headless/protocol.js'
export { sanitizeTerminalText } from './views/shared/sanitize.js'
export { StorageJournal } from './app/storage-journal.js'
export { FailClosedJournal } from './app/fail-closed-journal.js'

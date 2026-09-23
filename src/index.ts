export {
  type ConnectionHttpRequest,
  type ConnectionHttpResponse,
  type ConnectionHttpTransport,
  createCliBridgeProvider,
  createTangleInferenceProvider,
  createTangleSandboxProvider,
  FetchConnectionHttpTransport,
  HTTP_TRANSPORT_LIMITS,
  HttpConnectionProvider,
  type HttpTransportLimits,
  ProviderCapabilityError,
  ProviderContentTypeError,
  ProviderHttpStatusError,
  ProviderOriginError,
  ProviderPayloadError,
  ProviderRedirectError,
  ProviderRequestAbortedError,
  ProviderRequestTimeoutError,
  ProviderRequestTooLargeError,
  ProviderResponseTooLargeError,
  readCapabilitySnapshot,
  resolveProviderUrl,
  unsupportedProfileDimensions,
} from './adapters/connections/index.js'
export {
  AppError,
  BraidApplication,
  type SendInput,
  type SendReceipt,
} from './app/application.js'
export {
  type CompositionOptions,
  createBraidApplication,
  STARTER_PROFILE,
} from './app/composition.js'
export { type AppView, buildAppView, type MessageView } from './app/view-model.js'
export {
  ConnectionPersistenceConflictError,
  type ConnectionRecordPersistence,
  JsonConnectionRecordPersistence,
} from './connection/connection-persistence.js'
export {
  ConnectionRegistry,
  type ConnectionUsage,
} from './connection/connection-registry.js'
export {
  CLI_BRIDGE_SETUP,
  type ConnectionCapabilitySnapshot,
  type ConnectionHealth,
  type ConnectionHealthStatus,
  type ConnectionKind,
  type ConnectionProviderPort,
  type ConnectionRecord,
  type ConnectionSetupInput,
  connectionCapabilityDigest,
  connectionCredentialReferences,
  connectionIdentityDigest,
  createConnectionRecord,
  type ProviderRequestOptions,
  type ProviderValidationContext,
  TANGLE_INFERENCE_SETUP,
  TANGLE_SANDBOX_SETUP,
  updateConnectionHealth,
  validateConnectionRecord,
  withCapabilityDigest,
} from './connection/connections.js'
export {
  type CredentialReference,
  type CredentialStore,
  EnvironmentCredentialStore,
  environmentCredentialReference,
  type OperatingSystemCredentialBackend,
  OperatingSystemCredentialStore,
  parseCredentialReference,
  type SecretHandle,
  sessionCredentialReference,
} from './connection/credentials.js'
export {
  hasTrustedTunnel,
  type ProviderCredentialOption,
  ProviderOptionError,
  type ProviderOptionsSpec,
  providerOptionCredentialReferences,
  providerOptionsSpec,
  validateProviderOptions,
} from './connection/provider-options.js'
export {
  containsControlCharacters,
  containsSecretShape,
  isSecretBearingKey,
  redactErrorMessage,
  redactProviderText,
  redactProviderValue,
  redactProviderValues,
} from './connection/redaction.js'
export {
  type ConnectionRunLease,
  ConnectionRunLeaseRegistry,
} from './connection/run-leases.js'
export {
  ConnectionSetupCancelledError,
  ConnectionSetupTimeoutError,
  withConnectionSetupDeadline,
} from './connection/setup-deadline.js'
export {
  closeWorkspaceRoot,
  containedWorkspacePath,
  openWorkspaceRoot,
  readWorkspaceFile,
  resolveWorkspaceRoot,
  type WorkspaceFileRead,
  WorkspacePathEscapeError,
  type WorkspaceRootHandle,
} from './connection/workspace-paths.js'
export {
  inspectWorkspaceTrust,
  isVerifiedWorkspaceTrust,
  MAX_WORKSPACE_CONFIG_BYTES,
  type VerifiedWorkspaceTrust,
  verifyWorkspaceTrust,
  type WorkspaceConfigEntry,
  type WorkspaceIdentity,
  type WorkspaceInspectionFile,
  WorkspaceNotTrustedError,
  type WorkspaceTrustPreview,
  type WorkspaceTrustRecord,
  WorkspaceTrustStore,
} from './connection/workspace-trust.js'
export { MaterializationReceiptConflictError } from './controllers/admission-contracts.js'
export {
  AdmissionConflictError,
  AdmissionFailedError,
  AdmissionInFlightError,
  type AdmissionLedger,
  type AdmissionLedgerEntry,
  admissionOperationDigest,
  completeAdmission,
  failAdmission,
  MemoryAdmissionLedger,
  requireOperationId,
  reserveAdmission,
} from './controllers/admission-ledger.js'
export {
  ConnectionController,
  type ConnectionSetupResult,
  type ConnectionViewModel,
  type EffectiveRunConfirmationViewModel,
  FirstRunController,
  type FirstRunViewModel,
  ProfileController,
  type ProfileEditorViewModel,
  type ProfileListItem,
} from './controllers/index.js'
export { JsonAdmissionLedger } from './controllers/json-admission-ledger.js'
export { JsonReceiptStore } from './controllers/json-receipt-store.js'
export {
  MaterializationReceiptError,
  materializationReceiptDigest,
  validateMaterializationReceipt,
} from './controllers/materialization-receipt.js'
export {
  AdmissionBindingError,
  AdmissionRecoveryError,
  type AdmissionResult,
  type AdmissionWorkspace,
  MemoryReceiptStore,
  type PostMaterializationReceipt,
  type PreAdmissionReceipt,
  type PreparedAdmission,
  type ProviderMaterializationPath,
  type ProviderMaterializationReceipt,
  type PublicCapabilitySnapshot,
  RunAdmissionController,
  type RunAdmissionPort,
  type RunIdentifiers,
} from './controllers/run-admission.js'
export { canonicalDigest, canonicalJson } from './domain/canonical.js'
export type { BraidEvent, BraidEventEnvelope, TurnUsage } from './domain/events.js'
export { reduceEvent, replayEvents } from './domain/reducer.js'
export type { BraidMessage, BraidRun, BraidState } from './domain/state.js'
export { FileLockTimeoutError, fileLockPath, withFileLock } from './persistence/file-lock.js'
export {
  buildStructuredProfileView,
  ConcurrentProfileModificationError,
  editRawProfile,
  editStructuredProfile,
  exportProfile,
  exportProfileAtomically,
  openProfileEditor,
  type ProfileEditorDraft,
  type ProfileExport,
  type StructuredProfileEntry,
  type StructuredProfileView,
  saveProfileAtomically,
} from './profile/profile-editor.js'
export {
  ConcurrentFileModificationError,
  type FileIdentity,
  readFileIdentity,
  replaceFileAtomically,
} from './profile/profile-files.js'
export {
  assertProfileJsonLimits,
  cloneBoundedProfileValue,
  DuplicateProfileJsonKeyError,
  freezeBoundedProfileValue,
  PROFILE_JSON_LIMITS,
  ProfileJsonLimitError,
  type ProfileJsonLimits,
  parseBoundedProfileJson,
} from './profile/profile-json.js'
export {
  ForbiddenProfilePointerError,
  immutableProfileValue,
  pointerParts,
  pointerSegment,
  STRUCTURED_VIEW_LIMITS,
  type StructuredProfilePage,
  type StructuredViewLimits,
  setAtProfilePointer,
  structuredProfilePage,
} from './profile/profile-pointer.js'
export {
  type ProfileSchemaIdentity,
  profileSchemaIdentity,
} from './profile/profile-schema-identity.js'
export {
  type DiscoveredProfile,
  discoverProfiles,
  InlineProfileSourceAdapter,
  importProfileText,
  LoadedProfileSourceAdapter,
  LocalProfileSourceAdapter,
  type ProfileDiscoveryInput,
  type ProfileDocument,
  type ProfileReferenceLoader,
  type ProfileResolveOptions,
  type ProfileSaveBlock,
  type ProfileSourceAdapter,
  type ProfileSourceReference,
  ProfileSourceRegistry,
  parseCanonicalProfileJson,
  profileDocumentFromJson,
  type ResolvedProfileSource,
} from './profile/profile-sources.js'
export {
  type ProfileValidationReport,
  requireCanonicalProfile,
  validateCanonicalProfile,
} from './profile/profile-validation.js'
export {
  type EffectiveRunSelection,
  type EffectiveSelection,
  type ProfileSelectionLayers,
  type RunnerCapabilityCatalog,
  type RunOverrides,
  resolveEffectiveRun,
  type SelectedProfileReference,
  type SelectionLayers,
  selectionDimensions,
  selectionHasBlockingUnsupportedValue,
  selectProfileReference,
} from './profile/run-selection.js'
export {
  BRAID_PROTOCOL_VERSION,
  type BraidRequest,
  type BraidResponse,
} from './views/headless/protocol.js'
export type {
  ConnectionIntent,
  FirstRunIntent,
  ProfileIntent,
  ProfileViewModel,
} from './views/profile/contracts.js'
export { freezeProfileViewModel } from './views/profile/contracts.js'
export { sanitizeTerminalText } from './views/shared/sanitize.js'

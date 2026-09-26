import { prepareProofTools } from './build-proof-tools.mjs'

const tools = await import(await prepareProofTools())

export const {
  LiveBridgeError,
  proofHarnessTools,
  parseProofTargetPolicy,
  targetPolicyEvidence,
  secretValues,
  withoutBridgeSecrets,
  withoutBraidLiveSecrets,
  redactString,
  evidenceValue,
  REDACTION_INPUT_CHUNK_CHARS,
  MINIMUM_LITERAL_SECRET_LENGTH,
  literalSecrets,
  redactText,
  sanitizeArgv,
  collectCredentialSecrets,
  collectRedactionSecrets,
  sanitizeEnvironment,
  appendBounded,
  StreamingRedactor,
  BoundedCapture,
} = tools

import { createHash, X509Certificate } from 'node:crypto'
import type {
  ConfidentialAttestation,
  ConfidentialAttestationVerifier,
  ConfidentialExecutionEnvironment,
  Sha256Digest,
} from '@tangle-network/agent-interface'
import { confidentialExecutionVerified, sha256Bytes } from '@tangle-network/agent-interface'
import type {
  SandboxTeeAttestationReportLike,
  TangleConfidentialAttestationVerification,
  TangleConfidentialAttestationVerifier,
} from '@tangle-network/agent-provider-tangle'
import {
  decodeTangleConfidentialAttestationQuote,
  encodeTangleConfidentialAttestationQuote,
} from '@tangle-network/agent-provider-tangle'
import {
  createNitroHardwareVerifier,
  normalizeTeeType,
  parseNitroAttestationDocument,
  toHex,
  verifyAttestation,
} from '@tangle-network/tcloud-attestation'
import type { ConfidentialAttestationTrustPolicy, ConnectionRecord } from '../../domain/entities.js'
import {
  MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS,
  MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS,
} from '../../domain/entities-core.js'
import {
  AWS_NITRO_ENCLAVES_ROOT_G1_PEM,
  AWS_NITRO_ENCLAVES_ROOT_G1_SHA256,
} from './aws-nitro-root-g1.js'

const MAX_MEASUREMENT_BYTES = 48
const MIN_NONCE_HEX_CHARS = 64
const MAX_NONCE_HEX_CHARS = 128
const MAX_NITRO_TIMESTAMP_SKEW_SECONDS = 60
const POLICY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,255}$/u
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
/** The trust policy is public and contains no credential or executable state. */
export type NitroConfidentialAttestationTrustPolicy = ConfidentialAttestationTrustPolicy

export interface NitroConfidentialAttestationVerifierOptions {
  /** Unix seconds clock used by freshness and certificate checks. */
  readonly now?: () => number
}

export interface NitroConfidentialAttestationVerifiers {
  readonly policy: NitroConfidentialAttestationTrustPolicy
  readonly tangle: TangleConfidentialAttestationVerifier
  readonly canonical: ConfidentialAttestationVerifier
}

interface ConfiguredConfidentialAttestationVerifiers {
  readonly policy?: NitroConfidentialAttestationTrustPolicy
  readonly tangle?: TangleConfidentialAttestationVerifier
  readonly canonical?: ConfidentialAttestationVerifier
}

interface RawNitroReport {
  readonly tee_type: string
  readonly evidence: readonly number[]
  readonly measurement: readonly number[]
  readonly timestamp: number
}

interface VerifiedNitroEvidence {
  readonly measurement: Sha256Digest
  readonly providerKeyId: string
  readonly providerSignature: string
}

/**
 * Build the one Nitro trust path used for provider admission and replay.
 *
 * The root is pinned before any verifier callback is returned. The callback
 * never accepts a missing policy, an unverified quote, or a copied signature.
 */
export function createNitroConfidentialAttestationVerifiers(
  policy: NitroConfidentialAttestationTrustPolicy,
  options: NitroConfidentialAttestationVerifierOptions = {},
): NitroConfidentialAttestationVerifiers {
  const normalizedPolicy = normalizeNitroConfidentialAttestationTrustPolicy(policy)
  const root = assertOfficialNitroRoot()
  const nowSeconds = options.now ?? (() => Math.floor(Date.now() / 1000))

  const verifyEvidence = (
    report: RawNitroReport,
    attestation: ConfidentialAttestation,
    expected: ConfidentialExecutionEnvironment,
  ): VerifiedNitroEvidence | null => {
    if (!canonicalBindingsMatch(attestation, expected)) return null
    if (!normalizedPolicy.acceptedPolicyIds.includes(attestation.policy)) return null
    if (!isCanonicalNonce(attestation.nonce)) return null

    const measurement = sha256Bytes(Uint8Array.from(report.measurement))
    if (
      measurement !== attestation.measurement ||
      !normalizedPolicy.acceptedMeasurements.includes(measurement)
    ) {
      return null
    }
    if (attestation.verifiedAt !== verifiedAtFor(report.timestamp)) return null

    let document: ReturnType<typeof parseNitroAttestationDocument>
    try {
      document = parseNitroAttestationDocument(Uint8Array.from(report.evidence))
    } catch {
      return null
    }
    if (
      document.nonce === undefined ||
      toHex(document.nonce) !== attestation.nonce ||
      document.certificate.length === 0 ||
      document.signature.length === 0
    ) {
      return null
    }

    const now = nowSeconds()
    if (!Number.isSafeInteger(now) || now < 0) return null
    const signedTimestamp = Math.floor(document.timestamp / 1000)
    const signedMaxAge = normalizedPolicy.maxAgeSeconds
    const signedMaxFutureSkew = MAX_NITRO_TIMESTAMP_SKEW_SECONDS
    if (
      !Number.isSafeInteger(signedTimestamp) ||
      signedTimestamp > now + signedMaxFutureSkew ||
      now - signedTimestamp > signedMaxAge
    ) {
      return null
    }
    const result = verifyAttestation(
      {
        tee_type: report.tee_type,
        evidence: [...report.evidence],
        measurement: [...report.measurement],
        timestamp: report.timestamp,
      },
      {
        acceptedTeeTypes: ['nitro'],
        acceptedMeasurements: [toHex(Uint8Array.from(report.measurement))],
        maxAgeSeconds: normalizedPolicy.maxAgeSeconds,
        now,
        // Do not pass expectedNonce. tcloud-attestation pads string nonces to
        // 64 bytes, while AWS Nitro preserves the caller's 32-byte nonce.
        hardwareVerifier: createNitroHardwareVerifier({
          trustedRootCertificates: [root.raw],
          nowMs: now * 1000,
          maxTimestampSkewSeconds: signedMaxFutureSkew,
        }),
      },
    )
    if (!result.valid || result.attestation?.teeType !== 'nitro') return null

    const leaf = leafCertificate(document.certificate)
    if (leaf === null || equalBytes(leaf.raw, root.raw)) return null
    return {
      measurement,
      providerKeyId: digestBytes(leaf.raw),
      providerSignature: digestBytes(document.signature),
    }
  }

  const tangle: TangleConfidentialAttestationVerifier = async ({
    report,
    expected,
    attestation,
  }): Promise<TangleConfidentialAttestationVerification | null> => {
    try {
      const parsed = parseRawNitroReport(report)
      if (!quoteMatchesReport(attestation.quote, parsed)) return null
      const verified = verifyEvidence(parsed, attestation, expected)
      if (verified === null) return null
      return verified
    } catch {
      return null
    }
  }

  const canonical: ConfidentialAttestationVerifier = (attestation, expected): boolean => {
    try {
      const report = decodeNitroQuote(attestation.quote)
      const verified = verifyEvidence(report, attestation, expected)
      return (
        verified !== null &&
        attestation.providerKeyId === verified.providerKeyId &&
        attestation.providerSignature === verified.providerSignature
      )
    } catch {
      return false
    }
  }

  return Object.freeze({
    policy: normalizedPolicy,
    tangle,
    canonical,
  })
}

/** Resolve a policy on the selected connection, then fall back to test hooks. */
export function nitroVerifiersForConnection(
  record: ConnectionRecord,
  options: {
    readonly tangleConfidentialAttestationPolicy?: NitroConfidentialAttestationTrustPolicy
    readonly tangleConfidentialAttestationVerifier?: TangleConfidentialAttestationVerifier
    readonly confidentialAttestationVerifier?: ConfidentialAttestationVerifier
  },
): ConfiguredConfidentialAttestationVerifiers | undefined {
  if (
    options.tangleConfidentialAttestationVerifier !== undefined ||
    options.confidentialAttestationVerifier !== undefined
  ) {
    return Object.freeze({
      ...(options.tangleConfidentialAttestationVerifier === undefined
        ? {}
        : { tangle: options.tangleConfidentialAttestationVerifier }),
      ...(options.confidentialAttestationVerifier === undefined
        ? {}
        : { canonical: options.confidentialAttestationVerifier }),
    })
  }
  const policy = options.tangleConfidentialAttestationPolicy ?? record.confidentialAttestationPolicy
  return policy === undefined ? undefined : createNitroConfidentialAttestationVerifiers(policy)
}

/** Validate and freeze a startup trust policy before it reaches provider code. */
export function normalizeNitroConfidentialAttestationTrustPolicy(
  policy: NitroConfidentialAttestationTrustPolicy,
): NitroConfidentialAttestationTrustPolicy {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new TypeError('Nitro confidential attestation policy must be an object')
  }
  const keys = Object.keys(policy)
  if (
    keys.some(
      (key) =>
        key !== 'acceptedMeasurements' && key !== 'acceptedPolicyIds' && key !== 'maxAgeSeconds',
    )
  ) {
    throw new TypeError('Nitro confidential attestation policy contains an unsupported field')
  }
  const acceptedMeasurements = policy.acceptedMeasurements
  const acceptedPolicyIds = policy.acceptedPolicyIds
  if (
    !Array.isArray(acceptedMeasurements) ||
    acceptedMeasurements.length === 0 ||
    acceptedMeasurements.length > 256 ||
    acceptedMeasurements.some((measurement) => !SHA256_DIGEST_PATTERN.test(measurement))
  ) {
    throw new TypeError(
      'Nitro confidential attestation policy requires one to 256 canonical SHA-256 measurements',
    )
  }
  if (new Set(acceptedMeasurements).size !== acceptedMeasurements.length) {
    throw new TypeError('Nitro confidential attestation policy measurements must be unique')
  }
  if (
    !Array.isArray(acceptedPolicyIds) ||
    acceptedPolicyIds.length === 0 ||
    acceptedPolicyIds.length > 256 ||
    acceptedPolicyIds.some((value) => !POLICY_ID_PATTERN.test(value))
  ) {
    throw new TypeError(
      'Nitro confidential attestation policy requires one to 256 canonical policy ids',
    )
  }
  if (new Set(acceptedPolicyIds).size !== acceptedPolicyIds.length) {
    throw new TypeError('Nitro confidential attestation policy ids must be unique')
  }
  if (
    !Number.isSafeInteger(policy.maxAgeSeconds) ||
    policy.maxAgeSeconds < MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS ||
    policy.maxAgeSeconds > MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS
  ) {
    throw new TypeError(
      `Nitro confidential attestation maxAgeSeconds must be an integer from ${MIN_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS} to ${MAX_CONFIDENTIAL_ATTESTATION_MAX_AGE_SECONDS}`,
    )
  }
  const normalized = {
    acceptedMeasurements: Object.freeze([...acceptedMeasurements]),
    acceptedPolicyIds: Object.freeze([...acceptedPolicyIds]),
    maxAgeSeconds: policy.maxAgeSeconds,
  }
  return Object.freeze(normalized)
}

function canonicalBindingsMatch(
  attestation: ConfidentialAttestation,
  expected: ConfidentialExecutionEnvironment,
): boolean {
  return confidentialExecutionVerified({
    request: {
      requested: true,
      nonce: attestation.nonce,
      policy: attestation.policy,
      profileDigest: attestation.profileDigest,
    },
    environment: expected,
    attestation,
    verifyProviderAttestation: () => true,
  })
}

function parseRawNitroReport(value: SandboxTeeAttestationReportLike): RawNitroReport {
  const quote = encodeTangleConfidentialAttestationQuote(value)
  if (quote === undefined)
    throw new TypeError('Nitro attestation report is outside the provider bounds')
  const report = decodeTangleConfidentialAttestationQuote(quote)
  if (report === undefined || normalizeTeeType(report.tee_type) !== 'nitro') {
    throw new TypeError('Nitro attestation report must declare tee_type=nitro')
  }
  if (report.measurement.length !== MAX_MEASUREMENT_BYTES) {
    throw new TypeError('Nitro attestation measurement must be 48 bytes')
  }
  return report
}

function quoteMatchesReport(quote: string, report: RawNitroReport): boolean {
  try {
    const decoded = decodeTangleConfidentialAttestationQuote(quote)
    return decoded !== undefined && JSON.stringify(report) === JSON.stringify(decoded)
  } catch {
    return false
  }
}

function decodeNitroQuote(quote: string): RawNitroReport {
  const report = decodeTangleConfidentialAttestationQuote(quote)
  if (report === undefined) throw new TypeError('Nitro quote is not a canonical Tangle TEE quote')
  return parseRawNitroReport(report)
}

function isCanonicalNonce(value: string): boolean {
  return (
    (value.length === MIN_NONCE_HEX_CHARS || value.length === MAX_NONCE_HEX_CHARS) &&
    /^[0-9a-f]+$/u.test(value)
  )
}

function verifiedAtFor(timestamp: number): string {
  const date = new Date(timestamp * 1000)
  if (!Number.isFinite(date.getTime()))
    throw new TypeError('Nitro timestamp is outside date bounds')
  return date.toISOString()
}

function leafCertificate(bytes: Uint8Array): X509Certificate | null {
  try {
    return new X509Certificate(bytes)
  } catch {
    return null
  }
}

function assertOfficialNitroRoot(): X509Certificate {
  const root = new X509Certificate(AWS_NITRO_ENCLAVES_ROOT_G1_PEM)
  const fingerprint = digestBytes(root.raw)
  if (fingerprint !== AWS_NITRO_ENCLAVES_ROOT_G1_SHA256) {
    throw new Error('The bundled AWS Nitro Root-G1 certificate fingerprint does not match AWS')
  }
  if (!root.verify(root.publicKey)) {
    throw new Error('The bundled AWS Nitro Root-G1 certificate is not self-signed')
  }
  return root
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

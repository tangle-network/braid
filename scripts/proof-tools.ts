import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  IncrementalSecretTextSanitizer,
  redactSensitiveText,
} from '../src/domain/secret-sanitizer.js'
export {
  ProtectedWork,
  ProofWindow,
  countProtectedWork,
  createProtectedWork,
  observeOwnedSandbox,
  protectedSpan,
} from './protected-work.js'

export class LiveBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number,
    readonly details: unknown = {},
  ) {
    super(message)
    this.name = 'LiveBridgeError'
  }
}

export interface ProofTargetDefinition {
  readonly key: string
  readonly label: string
  readonly modelId: string
  readonly bridgeModelId?: string
  readonly backend: string
}

export interface ProofTargetPolicy {
  readonly source: string
  readonly requested?: readonly string[]
  readonly definitions: readonly ProofTargetDefinition[]
}

/** Redaction-only consumers do not load the source package's harness dependencies. */
export async function proofHarnessTools() {
  const { bridgeCatalogTarget } = await import(
    '../src/adapters/connections/cli-bridge-model-route.js'
  )
  function routeParts(route: unknown, backend?: string) {
    if (typeof route !== 'string' || route.split('/').some((part) => part.length === 0))
      return undefined
    const target = bridgeCatalogTarget(route, backend)
    if (target === undefined) return undefined
    return {
      runner: target.runner,
      provider: target.provider,
      model:
        target.provider === undefined
          ? target.model
          : target.model.slice(target.provider.length + 1),
    }
  }
  function targetDefinition(backend: string, route: string): ProofTargetDefinition | undefined {
    const target = routeParts(route, backend)
    if (target === undefined) return undefined
    const suffix = route
      .replace(`${backend}/`, '')
      .replaceAll(/[^a-z0-9]+/giu, '-')
      .replace(/^-|-$/gu, '')
      .toLowerCase()
    return {
      key: `${backend}-${suffix || 'default'}`,
      label:
        target.provider === undefined
          ? `${backend} ${target.model}`
          : `${backend} ${target.provider}/${target.model}`,
      modelId: route,
      bridgeModelId: route,
      backend,
    }
  }
  function profileForBridgeTarget(target: ProofTargetDefinition) {
    const parts = routeParts(target.modelId, target.backend)
    if (parts === undefined)
      throw new LiveBridgeError(
        'TARGET_MODEL_ROUTE_INVALID',
        `CLI Bridge target ${target.modelId} must be <runner>/<model> or <runner>/<provider>/<model> and agree with backend ${target.backend}`,
        2,
        { target: target.modelId, backend: target.backend },
      )
    return {
      name: `Braid live ${target.modelId}`,
      description: 'Opt-in packed CLI Bridge smoke profile',
      version: '0.1.0',
      harness: parts.runner,
      model: {
        ...(parts.provider === undefined ? {} : { provider: parts.provider }),
        default: parts.model,
      },
    }
  }
  function releaseTargetDefinitions(
    definitions: readonly ProofTargetDefinition[],
    advertised: readonly string[],
    readyBackends: readonly string[],
  ) {
    const selected: ProofTargetDefinition[] = []
    const missingBackends: string[] = []
    for (const backend of readyBackends) {
      const preferred = definitions.find(
        (definition) =>
          definition.backend === backend &&
          advertised.includes(definition.bridgeModelId ?? definition.modelId),
      )
      const candidate = advertised.find((modelId) => modelId.startsWith(`${backend}/`))
      const definition =
        preferred ?? (candidate === undefined ? undefined : targetDefinition(backend, candidate))
      if (definition === undefined) missingBackends.push(backend)
      else selected.push(definition)
    }
    if (missingBackends.length > 0)
      throw new LiveBridgeError(
        'LIVE_RELEASE_RUNNER_MODEL_UNAVAILABLE',
        `CLI Bridge has ready runners without an advertised model route: ${missingBackends.join(', ')}`,
        2,
        { missingBackends, advertisedModels: advertised },
      )
    return selected
  }
  return { routeParts, profileForBridgeTarget, releaseTargetDefinitions }
}

export function parseProofTargetPolicy(
  raw: string | undefined,
  definitions: readonly ProofTargetDefinition[],
  defaultPolicy: ProofTargetPolicy,
): ProofTargetPolicy {
  if (raw === undefined || raw.trim() === '') return defaultPolicy
  const keys = raw
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
  const unknown = keys.filter((key) => !byKey.has(key))
  const duplicates = keys.filter((key, index) => keys.indexOf(key) !== index)
  if (keys.length === 0 || unknown.length > 0 || duplicates.length > 0)
    throw new LiveBridgeError(
      'TARGET_POLICY_INVALID',
      'BRAID_LIVE_BRIDGE_TARGETS must list each supported target key once',
      2,
      { requested: keys, supported: definitions.map(({ key }) => key), unknown, duplicates },
    )
  return {
    source: 'environment',
    requested: keys,
    definitions: keys.map((key) => {
      const definition = byKey.get(key)
      if (definition === undefined) throw new Error('Validated proof target is missing')
      return definition
    }),
  }
}

export function targetPolicyEvidence(policy: ProofTargetPolicy) {
  return {
    source: policy.source,
    ...(policy.requested === undefined ? {} : { requested: policy.requested }),
    required: policy.definitions.map(({ key, label, modelId, backend }) => ({
      key,
      label,
      modelId,
      backend,
    })),
  }
}

const BRIDGE_SECRET_NAMES = ['BRAID_CLI_BRIDGE_BEARER', 'CLI_BRIDGE_BEARER', 'BRIDGE_BEARER']
const LIVE_SECRET_NAMES = [
  'BRAID_ANALYSIS_AUTH',
  'BRAID_ANALYSIS_API_KEY',
  'BRAID_ANALYSIS_BEARER',
  'BRAID_CLI_BRIDGE_AUTH',
  'BRAID_CLI_BRIDGE_API_KEY',
  'BRAID_CLI_BRIDGE_BEARER',
  'BRAID_TANGLE_AUTH',
  'BRAID_TANGLE_API_KEY',
  'BRAID_TANGLE_BEARER',
  'BRAID_TANGLE_CREDENTIAL_REF',
  'BRAID_TANGLE_SANDBOX_AUTH',
  'BRAID_TANGLE_SANDBOX_API_KEY',
  'BRAID_TANGLE_SANDBOX_BEARER',
  'BRAID_TANGLE_SANDBOX_CLEANUP_API_KEY',
  'BRAID_TANGLE_SANDBOX_CREDENTIAL_REF',
  'BRAID_TANGLE_SANDBOX_MODEL_API_KEY',
  'TANGLE_API_KEY',
]
const STRUCTURED_SECRET_KEYS = new Set([
  'authorization',
  'bearer',
  'token',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'secret',
  'secretvalue',
  'password',
  'cookie',
  'credential',
  'credentialvalue',
])
const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_?KEY|AUTH(?:ORIZATION)?|BEARER|COOKIE|CREDENTIAL|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/iu
const SENSITIVE_FLAG =
  /(?:auth|api[-_ ]*key|bearer|credential|password|private[-_ ]*key|secret|token)/iu
const SAFE_ENVIRONMENT_NAMES = new Set([
  'CI',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'NODE_ENV',
  'TERM',
  'TZ',
])
const MAX_PENDING_CHARS = 1024 * 1024
export const REDACTION_INPUT_CHUNK_CHARS = 64 * 1024
export const MINIMUM_LITERAL_SECRET_LENGTH = 8

function boundedText(value: unknown, maximum = 512): string {
  const text = String(value)
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

function uniqueSecrets(values: readonly unknown[], minimum: number): string[] {
  return [...new Set(values.map(String).filter((value) => value.length >= minimum))].sort(
    (left, right) => right.length - left.length,
  )
}

export function literalSecrets(values: readonly unknown[] = []): string[] {
  return uniqueSecrets(values, MINIMUM_LITERAL_SECRET_LENGTH)
}

function replaceLiterals(value: string, secrets: readonly string[], marker: string): string {
  for (const secret of secrets) value = value.split(secret).join(marker)
  return value
}

function markerText(value: string, marker: string): string {
  return value.replace(/\[redacted (?:secret|bearer|credential|link)\]/gu, marker)
}

export function redactText(value: unknown, secrets: readonly unknown[] = []): string {
  return markerText(
    redactSensitiveText(
      replaceLiterals(String(value), literalSecrets(secrets), '[REDACTED]'),
      Number.MAX_SAFE_INTEGER,
    ),
    '[REDACTED]',
  )
}

export function secretValues(environment: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = [...BRIDGE_SECRET_NAMES, ...LIVE_SECRET_NAMES]
    .map((key) => environment[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return collectCredentialSecrets(environment, explicit)
}

export function redactString(value: string, secrets: readonly unknown[] = secretValues()): string {
  return markerText(
    redactSensitiveText(
      replaceLiterals(value, uniqueSecrets(secrets, 1), '[redacted]'),
      Number.MAX_SAFE_INTEGER,
    ),
    '[redacted]',
  )
}

export function evidenceValue(
  value: unknown,
  key = '',
  depth = 0,
  secrets: readonly unknown[] = secretValues(),
): unknown {
  if (STRUCTURED_SECRET_KEYS.has(key.replaceAll(/[-_]/gu, '').toLowerCase())) return '[redacted]'
  if (typeof value === 'string') return redactString(value, secrets)
  if (value === null || typeof value !== 'object') return value
  if (depth > 8) return '[depth-limited]'
  if (Array.isArray(value)) return value.map((item) => evidenceValue(item, key, depth + 1, secrets))
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      evidenceValue(entryValue, entryKey, depth + 1, secrets),
    ]),
  )
}

function withoutNames(environment: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const result = { ...environment }
  for (const name of names) delete result[name]
  return result
}

export const withoutBridgeSecrets = (environment: NodeJS.ProcessEnv = process.env) =>
  withoutNames(environment, BRIDGE_SECRET_NAMES)
export const withoutBraidLiveSecrets = (environment: NodeJS.ProcessEnv = process.env) =>
  withoutNames(environment, LIVE_SECRET_NAMES)

function safeEnvironmentValue(name: string, value: unknown): boolean {
  const text = String(value)
  if (name === 'CI' || name === 'FORCE_COLOR' || name === 'NO_COLOR')
    return /^(?:0|1|true|false)?$/iu.test(text)
  if (name === 'NODE_ENV') return /^(?:development|production|test)$/u.test(text)
  if (name === 'LANG' || name === 'LC_ALL')
    return /^[A-Za-z]{2,12}(?:[_-][A-Za-z0-9]{2,12})?(?:\.[A-Za-z0-9_-]+)?$/u.test(text)
  if (name === 'TERM') return /^[A-Za-z0-9._-]{1,64}$/u.test(text)
  if (name === 'TZ') return /^[A-Za-z0-9_+./-]{1,64}$/u.test(text)
  return false
}

export function collectCredentialSecrets(
  environment: NodeJS.ProcessEnv = {},
  explicit: readonly unknown[] = [],
) {
  return literalSecrets([
    ...explicit,
    ...Object.entries(environment)
      .filter(([name]) => CREDENTIAL_ENVIRONMENT_NAME.test(name))
      .map(([, value]) => value),
  ])
}

export function collectRedactionSecrets(
  environment: NodeJS.ProcessEnv = {},
  explicit: readonly unknown[] = [],
) {
  return literalSecrets([
    ...explicit,
    ...Object.entries(environment)
      .filter(([name, value]) => !safeEnvironmentValue(name, value))
      .map(([, value]) => value),
  ])
}

export function sanitizeEnvironment(environment: NodeJS.ProcessEnv = {}, maximumEntries = 512) {
  const entries = Object.entries(environment).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  return {
    variables: entries.slice(0, maximumEntries).map(([name, value]) => ({
      name,
      value:
        SAFE_ENVIRONMENT_NAMES.has(name) && safeEnvironmentValue(name, value)
          ? boundedText(redactText(value))
          : '[REDACTED]',
      byteLength: Buffer.byteLength(String(value)),
    })),
    omittedCount: Math.max(0, entries.length - maximumEntries),
  }
}

export function sanitizeArgv(argv: readonly unknown[], secrets: readonly unknown[] = []): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('Command argv must be non-empty')
  let redactNext = false
  return argv.map((value, index) => {
    const argument = String(value)
    if (redactNext) {
      redactNext = false
      return '[REDACTED]'
    }
    if (index > 0 && SENSITIVE_FLAG.test(argument) && index + 1 < argv.length) {
      redactNext = true
      return redactText(argument, secrets)
    }
    return boundedText(redactText(argument, secrets))
  })
}

function prefixLength(text: string, secret: string): number {
  const table: number[] = new Array(secret.length).fill(0)
  for (let index = 1, length = 0; index < secret.length; index += 1) {
    while (length > 0 && secret[index] !== secret[length]) length = table[length - 1] ?? 0
    if (secret[index] === secret[length]) length += 1
    table[index] = length
  }
  let length = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    while (length > 0 && character !== secret[length]) length = table[length - 1] ?? 0
    if (character === secret[length]) length += 1
    if (length === secret.length) length = table[length - 1] ?? 0
  }
  return length
}

class ProofRedactor {
  readonly #decoder = new StringDecoder('utf8')
  readonly #generic = new IncrementalSecretTextSanitizer(Number.MAX_SAFE_INTEGER)
  readonly #secrets: readonly string[]
  readonly #marker: string
  readonly #maximumPending: number
  readonly #emit: (value: string) => void
  #literalPending = ''
  #suppressedBytes = 0
  #failClosed = false

  constructor(
    secrets: readonly unknown[],
    minimum: number,
    marker: string,
    emit: (value: string) => void,
    maximumPending = MAX_PENDING_CHARS,
  ) {
    this.#secrets = uniqueSecrets(secrets, minimum)
    this.#marker = marker
    this.#maximumPending = maximumPending
    this.#emit = emit
  }

  get redactionFailClosed(): boolean {
    return this.#failClosed
  }

  push(chunk: Uint8Array | string): void {
    const text = typeof chunk === 'string' ? chunk : this.#decoder.write(Buffer.from(chunk))
    for (
      let offset = 0;
      offset < text.length && !this.#failClosed;
      offset += REDACTION_INPUT_CHUNK_CHARS
    ) {
      const part = text.slice(offset, offset + REDACTION_INPUT_CHUNK_CHARS)
      const sanitized = this.#generic.push(part)
      this.#suppressedBytes =
        sanitized.length === 0 ? this.#suppressedBytes + Buffer.byteLength(part) : 0
      if (this.#suppressedBytes > this.#maximumPending) this.#close()
      else this.#literal(sanitized, false)
    }
  }

  finish(): void {
    if (this.#failClosed) return
    this.#literal(this.#generic.push(this.#decoder.end()) + this.#generic.finish(), true)
  }

  #close(): void {
    this.#emit(this.#marker)
    this.#literalPending = ''
    this.#failClosed = true
  }

  #literal(text: string, final: boolean): void {
    const value = replaceLiterals(
      this.#literalPending + markerText(text, this.#marker),
      this.#secrets,
      this.#marker,
    )
    let boundary = value.length
    if (!final) {
      for (const secret of this.#secrets) {
        const length = prefixLength(value, secret)
        if (length > 0) boundary = Math.min(boundary, value.length - length)
      }
    }
    if (value.length - boundary > this.#maximumPending) {
      this.#close()
      return
    }
    this.#emit(replaceLiterals(value.slice(0, boundary), this.#secrets, this.#marker))
    this.#literalPending = value.slice(boundary)
  }
}

export function appendBounded(current: string, chunk: string, maxBytes = 256_000): string {
  const next = Buffer.from(current + chunk)
  if (next.length <= maxBytes) return next.toString('utf8')
  if (maxBytes <= 0) return ''
  let start = next.length - maxBytes
  while (start < next.length && ((next[start] ?? 0) & 0xc0) === 0x80) start += 1
  return next.subarray(start).toString('utf8')
}

export class StreamingRedactor {
  readonly #redactor: ProofRedactor
  #retained = ''
  #finished = false
  constructor(maxBytes = 256_000, _holdChars = 512, secrets: readonly unknown[] = []) {
    this.#redactor = new ProofRedactor(
      secrets,
      1,
      '[redacted]',
      (value) => {
        this.#retained = appendBounded(this.#retained, value, maxBytes)
      },
      8_192,
    )
  }
  push(chunk: string): string {
    if (!this.#finished) this.#redactor.push(chunk)
    return this.#retained
  }
  snapshot(): string {
    return this.#retained
  }
  finish(): string {
    if (!this.#finished) {
      this.#redactor.finish()
      this.#finished = true
    }
    return this.#retained
  }
}

export class BoundedCapture {
  readonly #maximum: number
  readonly #redactor: ProofRedactor
  #rawByteLength = 0
  #retained: Buffer[] = []
  #retainedBytes = 0
  #truncated = false
  #finished = false
  constructor(maximum: number, secrets: readonly unknown[] = []) {
    if (!Number.isInteger(maximum) || maximum <= 0)
      throw new Error('Maximum log bytes must be positive')
    this.#maximum = maximum
    this.#redactor = new ProofRedactor(secrets, 8, '[REDACTED]', (value) => this.#retain(value))
  }
  #retain(value: string): void {
    if (value.length === 0) return
    const bytes = Buffer.from(value.normalize('NFC'))
    let end = Math.min(bytes.length, this.#maximum - this.#retainedBytes)
    while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    const kept = bytes.subarray(0, end)
    this.#retained.push(kept)
    this.#retainedBytes += kept.length
    if (end < bytes.length) this.#truncated = true
  }
  push(chunk: Uint8Array | string): void {
    if (this.#finished) throw new Error('Cannot append to a finished output capture')
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
    this.#rawByteLength += bytes.length
    this.#redactor.push(bytes)
  }
  finish() {
    if (this.#finished) throw new Error('Output capture was finished twice')
    this.#finished = true
    this.#redactor.finish()
    const bytes = Buffer.concat(this.#retained)
    this.#retained = []
    return Object.freeze({
      bytes,
      rawByteLength: this.#rawByteLength,
      redactedSha256: createHash('sha256').update(bytes).digest('hex'),
      redactedByteLength: bytes.length,
      redactedTruncated: this.#truncated,
      redactionFailClosed: this.#redactor.redactionFailClosed,
    })
  }
}

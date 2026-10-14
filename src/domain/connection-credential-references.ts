import type { ConnectionTransportOptions } from './entities-core.js'
import { redactSensitiveText } from './secret-sanitizer.js'

/**
 * Credential references a Tangle Sandbox connection may store: stored Sandbox secret names and a
 * model-seat reference. Both are names or commands, never values.
 *
 * Every message is fixed text. None quotes a configured value, so a rejected value cannot reach a
 * log, a journal event, or the screen through the refusal itself.
 */
export interface ConnectionCredentialReferenceProblem {
  /** True when the refused field looks like a credential value rather than a reference. */
  readonly credentialMaterial: boolean
  readonly message: string
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u
const SEAT_ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/u
const SEAT_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u
const SEAT_FORMATS = new Set(['token', 'bundle', 'files'])
const MAX_SECRET_NAMES = 64
const MAX_ENV_NAMES = 32
const MAX_COMMAND_PARTS = 128
const MAX_COMMAND_PART_LENGTH = 4096
// An unbroken run that mixes upper case, lower case and digits reads as a key, not a flag or path.
const OPAQUE_RUN = /[A-Za-z0-9+=_-]{24,}/gu

const COMMAND_FIELDS = new Set(['command', 'env', 'connectionKeyEnv', 'connectionEndpointEnv'])
const SEAT_FIELDS = new Set(['account', 'secretEnv', 'format'])

function invalid(message: string): ConnectionCredentialReferenceProblem {
  return { credentialMaterial: false, message }
}

function material(message: string): ConnectionCredentialReferenceProblem {
  return { credentialMaterial: true, message }
}

/** A value that the shared sanitizer would rewrite, or an opaque key-like run. */
export function credentialShaped(value: string): boolean {
  if (redactSensitiveText(value) !== value) return true
  for (const run of value.match(OPAQUE_RUN) ?? []) {
    if (/[a-z]/u.test(run) && /[A-Z]/u.test(run) && /[0-9]/u.test(run)) return true
  }
  return false
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function variableNamesProblem(
  value: unknown,
  field: string,
  limit: number,
  noun = 'variable names',
): ConnectionCredentialReferenceProblem | undefined {
  if (!Array.isArray(value)) {
    return material(`${field} must list ${noun}; values are never accepted`)
  }
  if (value.length > limit) return invalid(`${field} may list at most ${limit} names`)
  for (const name of value) {
    if (typeof name !== 'string') return invalid(`${field} must contain only names`)
    if (credentialShaped(name)) {
      return material(`${field} contains credential material; list names, not values`)
    }
    if (!VARIABLE_NAME.test(name)) {
      return invalid(`${field} entries must be environment-variable names such as GH_TOKEN`)
    }
  }
  if (new Set(value).size !== value.length) return invalid(`${field} must not repeat a name`)
  return undefined
}

function seatProblem(value: unknown): ConnectionCredentialReferenceProblem | undefined {
  const field = 'connection.providerOptions.modelCredentials.cliAuth'
  if (!isRecord(value) || Object.keys(value).some((key) => !SEAT_FIELDS.has(key))) {
    return material(
      `${field} accepts only account, secretEnv and format; seat values are never accepted`,
    )
  }
  for (const key of ['account', 'secretEnv'] as const) {
    const entry = value[key]
    if (typeof entry === 'string' && credentialShaped(entry)) {
      return material(`${field}.${key} contains credential material`)
    }
  }
  if (typeof value.account !== 'string' || !SEAT_ACCOUNT.test(value.account)) {
    return invalid(`${field}.account must be an account label`)
  }
  if (typeof value.secretEnv !== 'string' || !SEAT_SECRET_NAME.test(value.secretEnv)) {
    return invalid(`${field}.secretEnv must be a stored secret name`)
  }
  if (typeof value.format !== 'string' || !SEAT_FORMATS.has(value.format)) {
    return invalid(`${field}.format must be token, bundle or files`)
  }
  return undefined
}

function commandProblem(
  value: Readonly<Record<string, unknown>>,
): ConnectionCredentialReferenceProblem | undefined {
  const field = 'connection.providerOptions.modelCredentials'
  const command = value.command
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > MAX_COMMAND_PARTS ||
    command.some(
      (part) =>
        typeof part !== 'string' ||
        part.length === 0 ||
        part.length > MAX_COMMAND_PART_LENGTH ||
        part.includes('\0'),
    )
  ) {
    return invalid(`${field}.command must be an executable followed by its arguments`)
  }
  if (command.some((part) => credentialShaped(part as string))) {
    return material(
      `${field}.command contains credential material; pass secrets to the resolver through env names`,
    )
  }
  if (value.env !== undefined) {
    const problem = variableNamesProblem(value.env, `${field}.env`, MAX_ENV_NAMES)
    if (problem !== undefined) return problem
  }
  const supplied: string[] = []
  for (const key of ['connectionKeyEnv', 'connectionEndpointEnv'] as const) {
    const name = value[key]
    if (name === undefined) continue
    if (typeof name === 'string' && credentialShaped(name)) {
      return material(`${field}.${key} contains credential material; name a variable instead`)
    }
    if (typeof name !== 'string' || !VARIABLE_NAME.test(name)) {
      return invalid(`${field}.${key} must be an environment-variable name`)
    }
    supplied.push(name)
  }
  const forwarded = (value.env as readonly string[] | undefined) ?? []
  if (
    new Set(supplied).size !== supplied.length ||
    supplied.some((name) => forwarded.includes(name))
  ) {
    return invalid(`${field} must give each resolver variable exactly one source`)
  }
  return undefined
}

function modelCredentialsProblem(value: unknown): ConnectionCredentialReferenceProblem | undefined {
  const field = 'connection.providerOptions.modelCredentials'
  if (!isRecord(value)) {
    return material(`${field} must be a resolver command or a stored seat reference`)
  }
  const keys = Object.keys(value)
  if (keys.includes('cliAuth')) {
    if (keys.length !== 1) {
      return invalid(`${field} accepts cliAuth alone or a resolver command, not both`)
    }
    return seatProblem(value.cliAuth)
  }
  if (keys.some((key) => !COMMAND_FIELDS.has(key))) {
    return material(
      `${field} accepts only command, env, connectionKeyEnv and connectionEndpointEnv, or cliAuth alone; credential values are never accepted`,
    )
  }
  return commandProblem(value)
}

/** Return why a connection's credential references are unsafe or malformed, or undefined. */
export function connectionCredentialReferenceProblem(
  kind: string,
  options: Readonly<ConnectionTransportOptions>,
): ConnectionCredentialReferenceProblem | undefined {
  const values = options as Readonly<Record<string, unknown>>
  if (values.secrets !== undefined) {
    if (kind !== 'tangle-sandbox') {
      return invalid('connection.providerOptions.secrets is available only for tangle-sandbox')
    }
    if (Array.isArray(values.secrets) && values.secrets.length === 0) {
      return invalid('connection.providerOptions.secrets must name at least one stored secret')
    }
    const problem = variableNamesProblem(
      values.secrets,
      'connection.providerOptions.secrets',
      MAX_SECRET_NAMES,
      'stored Sandbox secret names',
    )
    if (problem !== undefined) return problem
  }
  if (values.modelCredentials !== undefined) {
    if (kind !== 'tangle-sandbox') {
      return invalid(
        'connection.providerOptions.modelCredentials is available only for tangle-sandbox',
      )
    }
    return modelCredentialsProblem(values.modelCredentials)
  }
  return undefined
}

import {
  connectRemoteSupervisor,
  type RemoteSupervisorReader,
  type RemoteSupervisorTree,
} from '@tangle-network/agent-runtime/kernel'
import { canonicalDigest } from '../../domain/canonical.js'
import { redactSensitiveText } from '../../domain/redaction.js'
import { IncrementalSecretTextSanitizer } from '../../domain/secret-sanitizer.js'

export interface RemoteAgentStream {
  readonly text: string
  readonly status: string
}

export interface RemoteSupervisorObservation {
  readonly tree: RemoteSupervisorTree
  readonly streams: ReadonlyMap<string, RemoteAgentStream>
}

interface StreamState extends RemoteAgentStream {
  readonly cursor?: { readonly epoch: string; readonly next: number }
  readonly sanitizer: IncrementalSecretTextSanitizer
}

const MAX_STREAM_CHARACTERS = 24_000

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function safe(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
    character === '\n' || character === '\t' ? character : '',
  )
}

/** Only Runtime's normalized executor events enter the worker stream; no harness output parsing. */
function eventText(value: unknown): string {
  const event = record(value)
  const text = typeof event.text === 'string' ? safe(event.text) : ''
  switch (event.kind) {
    case 'text_delta':
      return text
    case 'reasoning_delta':
      return `\nreasoning: ${text}`
    case 'tool_call':
      return `\n→ ${safe(String(event.toolName ?? 'tool'))}\n`
    case 'tool_result': {
      const result = typeof event.result === 'string' ? event.result : JSON.stringify(event.result)
      return `\n← ${safe(String(event.toolName ?? 'tool'))}${result === undefined ? '' : `: ${safe(result)}`}\n`
    }
    case 'interaction':
      return `\ninput requested: ${safe(String(record(event.request).title ?? 'worker interaction'))}\n`
    case 'child_task':
      return `\nchild: ${safe(String(record(event.event).title ?? record(event.event).childId ?? 'activity'))}\n`
    default:
      return '\n[unrecognized Runtime event]\n'
  }
}

function endpoint(name: string): {
  readonly url: string
  readonly protectedHeaders: Record<string, string>
  readonly fingerprint: string
} {
  if (!/^[A-Z_][A-Z0-9_]*$/u.test(name))
    throw new Error('Name an environment reference for the Runtime read endpoint')
  const value = process.env[name]
  if (value === undefined || value.length > 32_768)
    throw new Error('The protected Runtime read endpoint is unavailable in this process')
  let parsed: Record<string, unknown>
  try {
    parsed = record(JSON.parse(value))
  } catch {
    throw new Error('The protected Runtime read endpoint is invalid')
  }
  const headers = record(parsed.headers)
  if (
    typeof parsed.url !== 'string' ||
    Object.keys(headers).length === 0 ||
    Object.values(headers).some((header) => typeof header !== 'string' || header.length === 0)
  ) {
    throw new Error('The Runtime read endpoint requires a URL and protected headers')
  }
  let url: URL
  try {
    url = new URL(parsed.url)
  } catch {
    throw new Error('The Runtime read endpoint URL is invalid')
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
  ) {
    throw new Error(
      'The Runtime read endpoint requires HTTPS or loopback HTTP without URL credentials',
    )
  }
  return {
    url: url.href,
    protectedHeaders: headers as Record<string, string>,
    fingerprint: canonicalDigest({ url: url.href, headers }),
  }
}

/** Holds protected transport state and bounded cursors in memory, separate from Braid's journal. */
export class RemoteSupervisorWatcher {
  readonly #connections = new Map<
    string,
    {
      readonly fingerprint: string
      readonly reader: RemoteSupervisorReader
      readonly streams: Map<string, StreamState>
    }
  >()

  async snapshot(endpointEnv: string, workerId?: string): Promise<RemoteSupervisorObservation> {
    const spec = endpoint(endpointEnv)
    let connection = this.#connections.get(endpointEnv)
    try {
      if (connection?.fingerprint !== spec.fingerprint) {
        await connection?.reader.close()
        this.#connections.delete(endpointEnv)
        connection = {
          fingerprint: spec.fingerprint,
          reader: await connectRemoteSupervisor({
            url: spec.url,
            protectedHeaders: spec.protectedHeaders,
            timeoutMs: 5_000,
          }),
          streams: new Map(),
        }
        this.#connections.set(endpointEnv, connection)
      }
      const tree = await connection.reader.tree()
      if (workerId !== undefined && tree.nodes.some((node) => node.id === workerId)) {
        const previous = connection.streams.get(workerId)
        const { events } = await connection.reader.observe(workerId, previous?.cursor)
        if (events.status === 'unavailable') {
          connection.streams.set(workerId, {
            text: previous?.text ?? '',
            status: `live events unavailable: ${events.reason}`,
            sanitizer: previous?.sanitizer ?? new IncrementalSecretTextSanitizer(Number.POSITIVE_INFINITY),
          })
        } else {
          const prefix = events.reset ? '[stream reset]\n' : (previous?.text ?? '')
          const notice = events.historyExpired ? '[earlier live events expired]\n' : ''
          const added = events.entries
            .map((entry) =>
              entry.omitted === undefined
                ? eventText(entry.event)
                : `\n[event omitted: ${entry.omitted}]\n`,
            )
            .join('')
          const sanitizer = events.reset || events.historyExpired ? new IncrementalSecretTextSanitizer(Number.POSITIVE_INFINITY) : previous?.sanitizer ?? new IncrementalSecretTextSanitizer(Number.POSITIVE_INFINITY)
          const terminal = !['queued', 'acquiring', 'running'].includes(tree.nodes.find((node) => node.id === workerId)?.status ?? 'unknown')
          let text = `${prefix}${notice}${sanitizer.push(added)}${terminal ? sanitizer.finish() : ''}`
          for (const protectedValue of [spec.url, ...Object.values(spec.protectedHeaders)]) {
            text = text.split(protectedValue).join('[redacted credential]')
          }
          text = redactSensitiveText(text)
          connection.streams.set(workerId, {
            sanitizer,
            cursor: events.cursor,
            text:
              text.length > MAX_STREAM_CHARACTERS
                ? `[earlier display text omitted]\n${text.slice(-MAX_STREAM_CHARACTERS)}`
                : text,
            status: events.remaining > 0 ? 'live events catching up' : 'live events connected',
          })
        }
      }
      const ids = new Set(tree.nodes.map((node) => node.id))
      for (const id of connection.streams.keys()) if (!ids.has(id)) connection.streams.delete(id)
      return { tree, streams: connection.streams }
    } catch {
      this.#connections.delete(endpointEnv)
      await connection?.reader.close().catch(() => undefined)
      // Transport errors can contain a private capability URL. The reader's protected values never reach diagnostics.
      throw new Error(
        'Remote Runtime observation failed; check the read endpoint, its protected headers, and listener lifetime',
      )
    }
  }
}

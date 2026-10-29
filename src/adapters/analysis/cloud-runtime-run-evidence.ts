import { createHash } from 'node:crypto'
import { isToolSpan, type ToolSpan } from '@tangle-network/agent-eval/traces'
import { AnalysisSourceError, type RuntimeRunEvidence } from '../../app/analysis-types.js'
import { canonicalDigest } from '../../domain/canonical.js'
import type { RuntimeRunReference } from '../../domain/entities.js'
import { MAX_ANALYSIS_EVENT_BYTES } from '../../domain/redaction.js'
import {
  REMOTE_RUNTIME_READ_TIMEOUT_MS,
  runtimeReadEndpoint,
} from '../runtime/remote-supervisor.js'
import { redactedSpan, safeAnalysisText } from './trace-event-projection.js'

type CloudReference = Extract<RuntimeRunReference, { readonly remoteEndpointEnv: string }>

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new AnalysisSourceError('The Workflow API returned incomplete Runtime evidence')
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value)
    throw new AnalysisSourceError('The Workflow API omitted a Runtime source identity')
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new AnalysisSourceError('The Workflow API omitted a Runtime checkpoint counter')
  return value
}

/** Bounded JSON only; the API and agent-eval retain ownership of trace production and projection. */
async function readRun(reference: CloudReference): Promise<Record<string, unknown>> {
  const endpoint = runtimeReadEndpoint(reference.remoteEndpointEnv)
  const url = new URL(endpoint.url)
  if (
    !/^wfrun_[A-Za-z0-9_-]+$/u.test(reference.runId) ||
    !new RegExp(
      `^/(?:api/)?v1/workflows/(?:wf_[A-Za-z0-9_-]+/)?runs/${reference.runId}/?$`,
      'u',
    ).test(url.pathname)
  )
    throw new AnalysisSourceError('The protected endpoint must name this exact Workflow run')
  url.searchParams.set('trace', '1')
  const protectedValues = [
    endpoint.url,
    ...Object.values(endpoint.protectedHeaders).flatMap((value) => [
      value,
      value.replace(/^(?:Bearer|Basic)\s+/iu, ''),
    ]),
  ]
  try {
    const response = await fetch(url, {
      headers: endpoint.protectedHeaders,
      signal: AbortSignal.timeout(REMOTE_RUNTIME_READ_TIMEOUT_MS),
      redirect: 'error',
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AnalysisSourceError(
        `Workflow Runtime evidence read refused (HTTP ${response.status})`,
      )
    }
    const reader = response.body?.getReader()
    if (reader === undefined)
      throw new AnalysisSourceError('Workflow Runtime evidence body is missing')
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > MAX_ANALYSIS_EVENT_BYTES)
          throw new AnalysisSourceError(
            'Workflow Runtime evidence exceeds the analysis event bound',
          )
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
    const body = record(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        (key, value: unknown) => {
          if (protectedValues.some((secret) => key.includes(secret)))
            throw new AnalysisSourceError(
              'Workflow Runtime evidence contains a protected transport value',
            )
          if (typeof value !== 'string') return value
          for (const secret of protectedValues)
            value = (value as string).split(secret).join('[redacted credential]')
          return value
        },
      ),
    )
    if (body.success !== true)
      throw new AnalysisSourceError('Workflow Runtime evidence was refused')
    return record(body.data)
  } catch (error) {
    if (error instanceof AnalysisSourceError) throw error
    // Fetch/JSON errors may contain the capability URL or protected response content.
    throw new AnalysisSourceError('Workflow Runtime evidence could not be read securely')
  }
}

export async function readCloudRuntimeRunEvidence(
  reference: CloudReference,
): Promise<RuntimeRunEvidence> {
  const run = await readRun(reference)
  if (run.id !== reference.runId)
    throw new AnalysisSourceError('The Workflow API returned another run')
  const execution = record(run.execution)
  const runtime = record(run.runtime)
  const recovery = record(run.recovery)
  const snapshot = record(runtime.snapshot)
  const supervisors = snapshot.supervisors
  const trace = record(runtime.trace)
  if (
    execution.kind !== 'graph' ||
    typeof runtime.owned !== 'boolean' ||
    !Array.isArray(supervisors) ||
    supervisors.length !== 1 ||
    !Array.isArray(trace.spans) ||
    !Array.isArray(trace.gaps) ||
    !['complete', 'partial', 'missing'].includes(String(trace.status))
  )
    throw new AnalysisSourceError(
      'The Workflow API did not capture canonical Runtime graph evidence',
    )
  const sourceSha = createHash('sha256').update(text(run.definitionSnapshot)).digest('hex')
  if (sourceSha !== execution.sourceSha || record(execution.graph).digest !== execution.graphDigest)
    throw new AnalysisSourceError(
      'Captured Workflow source or graph digest does not match its execution',
    )
  const status = trace.status as 'complete' | 'partial' | 'missing'
  const gaps = trace.gaps.map((value) => {
    const gap = record(value)
    return {
      ...(gap.nodeId === undefined ? {} : { nodeId: text(gap.nodeId) }),
      reason: safeAnalysisText(text(gap.reason)),
    }
  })
  if (status === 'complete' && gaps.length > 0)
    throw new AnalysisSourceError('Complete Runtime trace evidence cannot contain coverage gaps')
  const checkpoint = {
    workflowId: text(run.workflowId),
    runtimeRunId: text(record(supervisors[0]).id),
    revUsed: integer(run.revUsed),
    sourceSha,
    authoredGraphDigest: text(execution.authoredGraphDigest),
    graphDigest: text(execution.graphDigest),
    generation: integer(runtime.generation),
    revision: integer(runtime.revision),
    namespace: text(runtime.namespace),
    owned: runtime.owned,
    status: text(run.status),
    attempts: integer(recovery.attempts),
    trace: { status, gaps },
  }
  if (
    reference.checkpoint !== undefined &&
    canonicalDigest(reference.checkpoint) !== canonicalDigest(checkpoint)
  )
    throw new AnalysisSourceError('The remote Runtime checkpoint changed since it was frozen')
  const ids = new Set<string>()
  const spans = trace.spans.map((value) => {
    const span = record(value)
    if (
      !isToolSpan(span as unknown as ToolSpan) ||
      typeof span.startedAt !== 'number' ||
      !Number.isFinite(span.startedAt) ||
      typeof span.toolName !== 'string'
    )
      throw new AnalysisSourceError('The Workflow API returned a malformed canonical tool span')
    const id = JSON.stringify([text(span.runId), text(span.spanId)])
    if (ids.has(id))
      throw new AnalysisSourceError('The Workflow API returned ambiguous span citations')
    ids.add(id)
    return redactedSpan(span as unknown as ToolSpan)
  })
  return {
    runId: reference.runId,
    remoteEndpointEnv: reference.remoteEndpointEnv,
    checkpoint,
    settled:
      ['succeeded', 'failed', 'cancelled'].includes(checkpoint.status) &&
      recovery.state === 'settled' &&
      !checkpoint.owned,
    spans,
  }
}

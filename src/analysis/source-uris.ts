/** Citation URIs are the only address form an analyst may emit for frozen evidence. */

export function traceSpanUri(traceId: string, spanId: string): string {
  return `trace://${encodeURIComponent(traceId)}/span/${encodeURIComponent(spanId)}`
}

export function eventUri(sourceId: string, eventId: string): string {
  return `event://${encodeURIComponent(sourceId)}/${encodeURIComponent(eventId)}`
}

export function metricUri(sourceId: string, name: string): string {
  return `metric://${encodeURIComponent(sourceId)}/${encodeURIComponent(name)}`
}

export function artifactUri(sourceId: string, path: string): string {
  return `artifact://${encodeURIComponent(sourceId)}/${encodeURIComponent(path)}`
}

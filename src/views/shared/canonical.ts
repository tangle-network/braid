export { canonicalJson } from '../../domain/canonical-json.js'
import { canonicalJson } from '../../domain/canonical-json.js'

/**
 * The identity of one protocol request, for recognizing a request identifier
 * that arrives a second time carrying different input.
 *
 * This is the request's canonical text, not a digest of it. Two requests are
 * the same request when their canonical texts are equal, and comparing the
 * text needs no hash — which matters here, because the view layer may not
 * import `node:crypto`. Anything that needs a fixed-width value should take
 * `canonicalDigest` from the domain layer instead.
 */
export function canonicalRequestIdentity(value: unknown): string {
  return canonicalJson(value)
}

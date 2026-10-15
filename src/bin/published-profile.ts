import type { ProfileSourceSpec } from '../app/profile-types.js'
import { importProfileValue } from '../app/profiles.js'
// Published from discovery-lab@de068d196aed580c05fe985f105768f61daa61e1.
// The private source remains the owner; this package carries its immutable release snapshot.
import discoveryOperator from '../profiles/discovery-operator.json' with { type: 'json' }

const catalog: Readonly<Record<string, unknown>> = { 'discovery-operator': discoveryOperator }

/** Resolve bundled bytes through the existing immutable package source, without filesystem writes. */
export function publishedProfileSource(
  reference: string | undefined,
): ProfileSourceSpec | undefined {
  if (reference === undefined || !Object.hasOwn(catalog, reference)) return undefined
  const imported = importProfileValue(catalog[reference])
  return {
    kind: 'package',
    reference: `@tangle-network/braid/profiles/${reference}`,
    label: reference,
    revision: imported.digest,
    writable: false,
    trusted: true,
    resolve: async () => ({ profile: imported.profile, revision: imported.digest }),
  }
}

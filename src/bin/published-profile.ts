import { join } from 'node:path'
import { ensurePrivateDirectory } from '../adapters/persistence/safe-file.js'
import { importProfileValue, saveProfileFile } from '../app/profile-persistence.js'
// Published from discovery-lab@4494ab671d556bcb414025bc8766915c89345647.
// The private source remains the owner; this package carries its immutable release snapshot.
import discoveryOperator from '../profiles/discovery-operator.json' with { type: 'json' }
import { defaultBraidDataDirectory } from './state-path.js'

const catalog: Readonly<Record<string, unknown>> = { 'discovery-operator': discoveryOperator }

export function resolvePublishedProfile(
  reference: string | undefined,
  options: { readonly dataDirectory?: string } = {},
): string | undefined {
  if (reference === undefined || !Object.hasOwn(catalog, reference)) return reference
  const imported = importProfileValue(catalog[reference])
  const directory = join(options.dataDirectory ?? defaultBraidDataDirectory(), 'profiles')
  ensurePrivateDirectory(directory)
  const path = join(directory, `${reference}-${imported.digest.slice('sha256:'.length)}.json`)
  saveProfileFile(path, imported.profile, { trusted: true })
  return path
}

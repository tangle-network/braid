import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { ensurePrivateDirectory } from '../adapters/persistence/safe-file.js'
import { importProfileJson, saveProfileFile } from '../app/profile-persistence.js'
import { defaultBraidDataDirectory } from './state-path.js'

/** Published names resolve to immutable owner revisions, never the workspace or a moving branch. */
const catalog: Readonly<Record<string, { readonly url: string; readonly sha256: string }>> = {
  'discovery-operator': {
    url: 'https://raw.githubusercontent.com/tangle-network/discovery-lab/4494ab671d556bcb414025bc8766915c89345647/profiles/operators/discovery-operator.json',
    sha256: 'ff5aed2a3667c83507d5a160b25453e956e8bd57e21334a2dc8ad3fd6b7ebb72',
  },
}

export async function resolvePublishedProfile(
  reference: string | undefined,
  options: {
    readonly fetch?: typeof globalThis.fetch
    readonly dataDirectory?: string
  } = {},
): Promise<string | undefined> {
  const entry =
    reference === undefined || !Object.hasOwn(catalog, reference) ? undefined : catalog[reference]
  if (entry === undefined) return reference
  const response = await (options.fetch ?? globalThis.fetch)(entry.url, {
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  if (!response.ok || response.body === null) {
    throw new Error(
      'Published profile unavailable. Retry when GitHub is reachable or select a local profile file.',
    )
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) throw new Error('Published profile exceeds its download limit')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = Buffer.concat(chunks)
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error('Published profile digest does not match the catalog revision')
  }
  const imported = importProfileJson(bytes.toString('utf8'))
  const directory = join(options.dataDirectory ?? defaultBraidDataDirectory(), 'profiles')
  ensurePrivateDirectory(directory)
  const path = join(directory, `${reference}-${entry.sha256}.json`)
  saveProfileFile(path, imported.profile, { trusted: true })
  return path
}

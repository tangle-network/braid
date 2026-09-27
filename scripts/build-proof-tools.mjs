import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const repository = fileURLToPath(new URL('../', import.meta.url))
const outputRoot = join(repository, '.script-dist')
const execute = promisify(execFile)
const schema = 'braid.proof-tools.v1'
const requiredInputs = [
  'scripts/proof-tools.ts',
  'scripts/protected-work.ts',
  'scripts/proof-tools.mjs',
  'scripts/build-proof-tools.mjs',
  'src/domain/secret-sanitizer.ts',
  'src/domain/terminal-sanitizer.ts',
  'src/adapters/connections/cli-bridge-model-route.ts',
  'src/adapters/agent-interface/harness-runtime.ts',
  'src/adapters/agent-interface/module-url.ts',
  'package.json',
  'pnpm-lock.yaml',
]

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function contained(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path))
    throw new Error('Invalid proof-tool artifact path')
  const absolute = resolve(root, path)
  const child = relative(root, absolute)
  if (child === '' || child === '..' || child.startsWith('../') || child.startsWith('..\\'))
    throw new Error('Proof-tool artifact escapes its directory')
  return absolute
}

async function regularBytes(path) {
  const metadata = await lstat(path)
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error('Proof-tool artifact must be a regular file')
  return readFile(path)
}

async function directory(path) {
  const metadata = await lstat(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error('Proof-tool output must be a real directory')
}

async function sourceCommit() {
  const supplied =
    process.env.BRAID_PACKAGE_PROOF_ISOLATED === '1'
      ? process.env.BRAID_PACKAGE_PROOF_COMMIT
      : undefined
  const commit =
    supplied ?? (await execute('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim()
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('Proof-tool source commit is invalid')
  return commit
}

async function inputRecord(path) {
  const bytes = await regularBytes(contained(repository, path))
  return { path, size: bytes.length, sha256: digest(bytes) }
}

function validRecord(record) {
  return (
    record &&
    typeof record.path === 'string' &&
    Number.isSafeInteger(record.size) &&
    record.size >= 0 &&
    /^[0-9a-f]{64}$/u.test(record.sha256)
  )
}

async function verifyManifest(manifest, generation, commit) {
  if (
    manifest?.schema !== schema ||
    manifest.sourceCommit !== commit ||
    manifest.entry !== 'proof-tools.mjs' ||
    !Array.isArray(manifest.inputs) ||
    !Array.isArray(manifest.outputs) ||
    manifest.outputs.length === 0
  )
    throw new Error('Proof-tool sidecar identity does not match the source checkout')
  const names = new Set()
  for (const record of manifest.inputs) {
    if (!validRecord(record) || names.has(record.path)) throw new Error('Invalid proof-tool inputs')
    names.add(record.path)
    const current = await inputRecord(record.path)
    if (current.size !== record.size || current.sha256 !== record.sha256)
      throw new Error('Proof-tool sidecar source digest does not match the checkout')
  }
  if (requiredInputs.some((path) => !names.has(path)))
    throw new Error('Proof-tool sidecar omits a required source input')
  names.clear()
  await directory(generation)
  for (const record of manifest.outputs) {
    if (!validRecord(record) || names.has(record.path))
      throw new Error('Invalid proof-tool outputs')
    names.add(record.path)
    const path = contained(generation, record.path)
    await directory(dirname(path))
    const bytes = await regularBytes(path)
    if (bytes.length !== record.size || digest(bytes) !== record.sha256)
      throw new Error('Proof-tool sidecar output digest does not match its manifest')
  }
  if (!names.has(manifest.entry)) throw new Error('Proof-tool sidecar entry is missing')
  return pathToFileURL(contained(generation, manifest.entry)).href
}

async function restored(commit) {
  await directory(outputRoot)
  const pointer = JSON.parse(await regularBytes(join(outputRoot, 'current.json')))
  const generation = contained(outputRoot, pointer.generation)
  const manifestBytes = await regularBytes(join(generation, 'manifest.json'))
  if (digest(manifestBytes) !== pointer.manifestSha256)
    throw new Error('Proof-tool sidecar manifest digest is invalid')
  return verifyManifest(JSON.parse(manifestBytes), generation, commit)
}

async function compile(commit) {
  let build
  try {
    ;({ build } = await import('esbuild'))
  } catch (cause) {
    throw new Error(
      'Build proof tools after installing source dependencies, or restore the exact candidate proof-tools sidecar',
      { cause },
    )
  }
  const virtualOutput = join(outputRoot, 'compiled')
  const result = await build({
    absWorkingDir: repository,
    entryPoints: ['scripts/proof-tools.ts'],
    outdir: virtualOutput,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22.19',
    packages: 'external',
    entryNames: 'proof-tools',
    chunkNames: 'chunks/[name]-[hash]',
    outExtension: { '.js': '.mjs' },
    sourcemap: false,
    legalComments: 'eof',
    metafile: true,
    write: false,
  })
  const inputPaths = [
    ...new Set([...requiredInputs, ...Object.keys(result.metafile.inputs)]),
  ].sort()
  const inputs = await Promise.all(inputPaths.map(inputRecord))
  const outputs = result.outputFiles
    .map((file) => ({
      path: relative(virtualOutput, file.path).replaceAll('\\', '/'),
      size: file.contents.length,
      sha256: digest(file.contents),
    }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const manifestBytes = Buffer.from(
    `${JSON.stringify({ schema, sourceCommit: commit, entry: 'proof-tools.mjs', inputs, outputs })}\n`,
  )
  const generationName = digest(manifestBytes)
  await mkdir(outputRoot, { recursive: true, mode: 0o700 })
  await directory(outputRoot)
  const temporary = join(outputRoot, `build-${randomUUID()}`)
  const generation = join(outputRoot, generationName)
  await mkdir(temporary, { mode: 0o700 })
  try {
    for (const file of result.outputFiles) {
      const path = contained(temporary, relative(virtualOutput, file.path))
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, file.contents, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(temporary, 'manifest.json'), manifestBytes, { flag: 'wx', mode: 0o600 })
    try {
      await rename(temporary, generation)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
      await verifyManifest(JSON.parse(manifestBytes), generation, commit)
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
  const pointer = join(outputRoot, `current-${randomUUID()}.json`)
  await writeFile(
    pointer,
    `${JSON.stringify({ generation: generationName, manifestSha256: digest(manifestBytes) })}\n`,
    { flag: 'wx', mode: 0o600 },
  )
  await rename(pointer, join(outputRoot, 'current.json'))
  return restored(commit)
}

let preparation
export function prepareProofTools({ force = false } = {}) {
  preparation ??= (async () => {
    const commit = await sourceCommit()
    if (!force) {
      try {
        return await restored(commit)
      } catch (error) {
        // Rebuild from current source; never import an unusable cached generation.
        if (error?.code !== 'ENOENT') {
          const entry = await compile(commit)
          return entry
        }
      }
    }
    return compile(commit)
  })()
  return preparation
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareProofTools({ force: true })

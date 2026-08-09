import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { REQUIREMENT_PATTERN } from '../release-check-catalog.mjs'
import { canonicalJson } from '../release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from '../release-files.mjs'
import {
  assertPackageFileManifestMatches,
  packageFileBytesFromTarball,
  packageFileManifestFromTarball,
  readPackageProof,
  sourceDigest,
} from './package-archive.mjs'

const INTEGRITY_PATTERN = /sha512-(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/u
const GIT_TREE_ALGORITHM = 'git-tree-object-sha1'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function git(repository, ...args) {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
}

function sourceTreeChanges(repository) {
  const changed = new Set()
  for (const path of git(repository, 'diff', '--name-only', 'HEAD').split('\n')) {
    if (path) changed.add(path)
  }
  for (const path of git(repository, 'ls-files', '--others', '--exclude-standard').split('\n')) {
    if (path) changed.add(path)
  }
  return [...changed].sort()
}

async function filesBelow(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await filesBelow(path)))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function lockfileIntegrity(lockText, name, version) {
  const candidates = [`  '${name}@`, `  ${name}@`]
  const lines = lockText.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!candidates.some((prefix) => line.startsWith(prefix)) || !line.endsWith(':')) continue
    if (!line.includes(`@${version}`)) continue
    for (let next = index + 1; next < Math.min(lines.length, index + 12); next += 1) {
      if (/^ {2}\S.*:$/.test(lines[next]) && !lines[next].startsWith('    ')) break
      const match = lines[next].match(/integrity:\s*(sha512-[A-Za-z0-9+/=]+)/u)
      if (match?.[1] && INTEGRITY_PATTERN.test(match[1])) return match[1]
    }
  }
  throw new Error(`pnpm-lock.yaml has no integrity for ${name}@${version}`)
}

export async function readDependencyRecords({ repository, packageJson, lockfileText } = {}) {
  const root = resolve(repository)
  const packageValue =
    packageJson ??
    JSON.parse((await readRegularFileNoFollow(join(root, 'package.json'))).toString('utf8'))
  const lockText =
    lockfileText ?? (await readRegularFileNoFollow(join(root, 'pnpm-lock.yaml'))).toString('utf8')
  const records = []
  for (const [name, version] of Object.entries(packageValue.dependencies ?? {})) {
    assert(
      typeof version === 'string' && version.length > 0,
      `Dependency ${name} has no exact version`,
    )
    records.push({ name, version, integrity: lockfileIntegrity(lockText, name, version) })
  }
  return records.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
}

export async function readRequirementIds(repository) {
  const root = resolve(repository)
  const docsRoot = join(root, 'docs')
  const occurrences = new Map()
  const definitions = new Map()
  for (const path of (await filesBelow(docsRoot)).filter((candidate) =>
    candidate.endsWith('.md'),
  )) {
    const text = (await readRegularFileNoFollow(path)).toString('utf8')
    for (const match of text.matchAll(REQUIREMENT_PATTERN)) {
      const id = match[0]
      const list = occurrences.get(id) ?? []
      list.push({ path: relative(root, path), offset: match.index ?? 0 })
      occurrences.set(id, list)
    }
    let section = ''
    for (const [lineNumber, line] of text.split('\n').entries()) {
      const heading = line.match(/^#{1,6}\s+(.+)$/u)
      if (heading) section = heading[1].replace(/[`*_]/gu, '').trim().toLowerCase()
      const definition = line.match(/^\s*\|\s*`?([A-Z]{2,4}-[0-9]{2})`?\s*\|/u)
      if (!definition || !isRequirementDefinitionSection(section)) continue
      const id = definition[1]
      const list = definitions.get(id) ?? []
      list.push({ path: relative(root, path), line: lineNumber + 1 })
      definitions.set(id, list)
    }
  }
  const duplicates = [...definitions.entries()].filter(([, locations]) => locations.length > 1)
  assert(
    duplicates.length === 0,
    `Duplicate requirement definitions in specifications: ${duplicates
      .map(
        ([id, locations]) =>
          `${id} (${locations.map(({ path, line }) => `${path}:${line}`).join(', ')})`,
      )
      .join('; ')}`,
  )
  assert(occurrences.size > 0, 'No release requirement identifiers found in docs')
  return [...occurrences.keys()].sort()
}

function isRequirementDefinitionSection(section) {
  if (/mapping|ownership|admissible evidence|requirement range/iu.test(section)) return false
  return /acceptance|completion checks|vertical-slice checks|required live matrix|performance targets|semantic release cases/iu.test(
    section,
  )
}

export function dependencyDigest(dependencies) {
  return sha256(Buffer.from(canonicalJson(dependencies)))
}

export function identityDigest(identity) {
  return sha256(
    Buffer.from(
      canonicalJson({
        braidVersion: identity.braidVersion,
        gitCommit: identity.gitCommit,
        gitTree: identity.gitTree,
        treeSha256: identity.treeSha256,
        tarballSha256: identity.tarballSha256,
        packageIntegrity: identity.packageIntegrity,
        packageFileManifestDigest: identity.packageFileManifestDigest,
        dependencyDigest: identity.dependencyDigest,
        dependencies: identity.dependencies,
        requirementIds: identity.requirementIds,
      }),
    ),
  )
}

export function bindingForCheck(identity, requirementIds) {
  assert(Array.isArray(requirementIds), 'Check requirement identifiers must be an array')
  assert(requirementIds.length > 0, 'A check must bind to at least one requirement')
  assert(
    new Set(requirementIds).size === requirementIds.length,
    'Check requirement identifiers are duplicated',
  )
  assert(Array.isArray(identity.requirementIds), 'Build identity has no requirement identifiers')
  assert(
    new Set(identity.requirementIds).size === identity.requirementIds.length,
    'Build identity requirement identifiers are duplicated',
  )
  const ids = [...requirementIds].sort()
  for (const id of ids)
    assert(identity.requirementIds.includes(id), `Unknown requirement identifier: ${id}`)
  return {
    schemaVersion: 1,
    tarballSha256: identity.tarballSha256,
    gitCommit: identity.gitCommit,
    gitTree: identity.gitTree,
    dependencyDigest: identity.dependencyDigest,
    packageFileManifestDigest: identity.packageFileManifestDigest,
    dependencies: identity.dependencies.map(({ name, version, integrity }) => ({
      name,
      version,
      integrity,
    })),
    requirementIds: ids,
  }
}

function packageManifestFromProof(proof) {
  const candidates = [proof.packageFileManifest, proof.fileManifest].filter(
    (value) => value !== undefined,
  )
  assert(candidates.length === 1, 'Package proof must contain exactly one package file manifest')
  return candidates[0]
}

function sourceManifestAsPackedByPnpm(packageJson) {
  const packed = { ...packageJson }
  delete packed.packageManager
  return packed
}

export async function readBuildIdentity({
  repository,
  artifactRoot,
  tarballPath,
  packageProofPath,
  packageProof,
  requirementIds,
} = {}) {
  const root = resolve(repository)
  const evidenceRoot = resolve(artifactRoot)
  assert(
    typeof tarballPath === 'string' && tarballPath.length > 0,
    'Packed tarball path is required',
  )
  const requestedTarball = resolve(tarballPath)
  const tarballRelative = relative(evidenceRoot, requestedTarball)
  assert(
    tarballRelative !== '' &&
      !isAbsolute(tarballRelative) &&
      tarballRelative !== '..' &&
      !tarballRelative.startsWith(`..${sep}`),
    'Packed tarball must be inside BRAID_RELEASE_ARTIFACT_ROOT',
  )
  const tarball = await containedArtifactPath(evidenceRoot, tarballRelative)
  const tarballBytes = await readRegularFileNoFollow(tarball)
  const packageJson = JSON.parse(
    (await readRegularFileNoFollow(join(root, 'package.json'))).toString('utf8'),
  )
  const proof = await readPackageProof({
    repository: root,
    packageProofRoot: evidenceRoot,
    packageProofPath,
    packageProof,
  })
  const dependencies = await readDependencyRecords({ repository: root, packageJson })
  const ids = requirementIds ?? (await readRequirementIds(root))
  assert(Array.isArray(ids), 'Requirement identifiers are not an array')
  assert(new Set(ids).size === ids.length, 'Requirement identifiers are duplicated')
  const sourceChanges = sourceTreeChanges(root)
  assert(
    sourceChanges.length === 0,
    `Source tree is not clean; cannot bind tarball to HEAD: ${sourceChanges.join(', ')}`,
  )
  const gitCommit = git(root, 'rev-parse', 'HEAD')
  const treeSha256 = git(root, 'rev-parse', 'HEAD^{tree}')
  assert(/^[a-f0-9]{40}$/u.test(gitCommit), 'Git commit is not a full SHA')
  assert(/^[a-f0-9]{40}$/u.test(treeSha256), 'Git tree is not a full SHA')
  const gitTree = { algorithm: GIT_TREE_ALGORITHM, value: treeSha256 }
  const tarballSha256 = sha256(tarballBytes)
  const packageIntegrity = `sha512-${createHash('sha512').update(tarballBytes).digest('base64')}`
  const cleanSourceDigest = await sourceDigest(root)
  assert(
    proof && typeof proof === 'object' && !Array.isArray(proof),
    'Package proof is not an object',
  )
  assert(proof.isolatedBuild === true, 'Package proof was not created in an isolated build')
  assert(
    proof.sourceCheckout === 'isolated-copy-of-worktree',
    'Package proof source checkout is not isolated',
  )
  assert(proof.gitCommit === gitCommit, 'Package proof was built from another Git commit')
  assert(proof.treeSha256 === treeSha256, 'Package proof was built from another Git tree')
  assert(proof.sha256 === tarballSha256, 'Package proof tarball digest differs')
  assert(proof.version === packageJson.version, 'Package proof version differs from package.json')
  assert(
    proof.sourceDigest === cleanSourceDigest,
    'Package proof source digest differs from the clean tree',
  )
  if (typeof proof.tarball === 'string')
    assert(basename(tarball) === proof.tarball, 'Tarball filename differs from package proof')
  const actualManifest = packageFileManifestFromTarball(tarballBytes)
  const packageFileManifest = assertPackageFileManifestMatches(
    packageManifestFromProof(proof),
    actualManifest,
  )
  const packedPackageJson = JSON.parse(
    packageFileBytesFromTarball(tarballBytes, 'package/package.json').toString('utf8'),
  )
  assert(
    canonicalJson(packedPackageJson) === canonicalJson(sourceManifestAsPackedByPnpm(packageJson)),
    'Packed package.json differs from HEAD',
  )
  return {
    braidVersion: packageJson.version,
    gitCommit,
    gitTree,
    treeSha256,
    clean: true,
    tarballSha256,
    packageIntegrity,
    dependencies,
    dependencyDigest: dependencyDigest(dependencies),
    packageFileManifest,
    packageFileManifestDigest: packageFileManifest.digest,
    requirementIds: [...ids].sort(),
    tarballPath: tarballRelative,
  }
}

import {
  appendFile,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, canonicalJson } from './release-evidence.mjs'
import {
  containedArtifactPath,
  containedOutputPath,
  readRegularFileNoFollow,
  writeExclusiveAtomic,
} from './release-files.mjs'
import { assertSafeJsonValue, parseJson } from './release-json.mjs'
import { readSpecifications } from './release-specification.mjs'

async function expectReject(action, label, pattern = /./u) {
  try {
    await action()
  } catch (error) {
    assert(pattern.test(String(error)), `${label} failed with an unrelated error`)
    return
  }
  throw new Error(`${label} was accepted`)
}

export async function runPathMutations() {
  const root = await mkdtemp(join(tmpdir(), 'braid-release-path-mutation-'))
  try {
    const safe = join(root, 'safe.txt')
    await writeFile(safe, 'safe')
    await expectReject(
      () => containedArtifactPath(root, '../outside.txt'),
      'path traversal',
      /traversal|leaves (?:repository|release root)/iu,
    )
    await expectReject(
      () => containedArtifactPath(root, 'a'.repeat(4097)),
      'oversized path',
      /canonical|length|size/iu,
    )
    const symlinkPath = join(root, 'symlink.txt')
    await symlink(safe, symlinkPath)
    await expectReject(
      () => containedArtifactPath(root, 'symlink.txt'),
      'symlink artifact',
      /symlink/iu,
    )
    await expectReject(() => readRegularFileNoFollow(symlinkPath), 'symlink read', /non-symlink/iu)
    const hardlinkPath = join(root, 'hardlink.txt')
    await link(safe, hardlinkPath)
    await expectReject(
      () => readRegularFileNoFollow(hardlinkPath),
      'hardlink artifact',
      /hard-linked/iu,
    )
    const directory = join(root, 'directory')
    await mkdir(directory)
    await expectReject(
      () => readRegularFileNoFollow(directory),
      'non-regular artifact',
      /regular/iu,
    )
    const output = join(root, 'output.json')
    await writeFile(output, 'original')
    await expectReject(
      () => writeExclusiveAtomic(output, 'replacement'),
      'output overwrite',
      /EEXIST|exist/iu,
    )
    assert(
      (await readFile(output)).toString() === 'original',
      'Output overwrite changed the original file',
    )
    const realParent = join(root, 'real-parent')
    const replacedParent = join(root, 'replaced-parent')
    await mkdir(realParent)
    await symlink(realParent, replacedParent)
    await expectReject(
      () => containedOutputPath(root, 'replaced-parent/result.json'),
      'replacement race through output parent',
      /symlink/iu,
    )
    await expectReject(
      () => writeExclusiveAtomic(join(replacedParent, 'result.json'), 'replacement'),
      'replacement race write',
      /symlink/iu,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function runJsonMutations() {
  await expectReject(
    () => parseJson('{"a":1,"a":2}', 'duplicate JSON keys'),
    'duplicate JSON keys',
    /duplicate key/iu,
  )
  await expectReject(
    () => parseJson('{"__proto__":1}', 'prototype JSON key'),
    'prototype JSON key',
    /prototype/iu,
  )
  await expectReject(
    () => parseJson('{"constructor":1}', 'constructor JSON key'),
    'constructor JSON key',
    /prototype/iu,
  )
  const nested = `${'{"x":'.repeat(66)}0${'}'.repeat(66)}`
  await expectReject(() => parseJson(nested, 'deep JSON'), 'JSON depth abuse', /depth/iu)
  await expectReject(
    () => parseJson(JSON.stringify('x'.repeat(4 * 1024 * 1024 + 1)), 'large JSON string'),
    'JSON size abuse',
    /string|size|byte/iu,
  )
  await expectReject(
    () => parseJson(JSON.stringify(Array.from({ length: 100_001 }, () => 0)), 'large JSON array'),
    'JSON node abuse',
    /node|large/iu,
  )
  const getter = {}
  Object.defineProperty(getter, 'value', { enumerable: true, get: () => 1 })
  await expectReject(
    () => assertSafeJsonValue(getter, 'getter object'),
    'getter JSON value',
    /accessor|data property/iu,
  )
  const hostilePrototype = Object.create({ inherited: true })
  hostilePrototype.value = 1
  await expectReject(
    () => assertSafeJsonValue(hostilePrototype, 'prototype object'),
    'prototype JSON value',
    /prototype/iu,
  )
  const cycle = {}
  cycle.self = cycle
  await expectReject(() => canonicalJson(cycle), 'cyclic JSON value', /cycle|repeated/iu)
  await expectReject(
    () => assertSafeJsonValue(Number.NaN, 'non-finite JSON value'),
    'non-finite JSON value',
    /finite/iu,
  )
  await expectReject(
    () => assertSafeJsonValue(undefined, 'undefined JSON value'),
    'undefined JSON value',
    /JSON value/iu,
  )
  const hidden = {}
  Object.defineProperty(hidden, 'hidden', { value: true, enumerable: false })
  await expectReject(
    () => assertSafeJsonValue(hidden, 'hidden JSON property'),
    'hidden JSON property',
    /enumerable/iu,
  )
}

async function specificationReject(fixture, label, edit, pattern) {
  const root = await mkdtemp(join(tmpdir(), 'braid-release-spec-mutation-'))
  try {
    const docs = join(root, 'docs')
    await cp(join(fixture.root, 'docs'), docs, { recursive: true })
    await edit(docs)
    await expectReject(() => readSpecifications(docs, root), label, pattern)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

export async function runSpecificationMutations(fixture) {
  await specificationReject(
    fixture,
    'duplicate specification definition',
    async (docs) => {
      await appendFile(join(docs, '01-product-contract.md'), '\n| PR-01 | duplicate definition |\n')
    },
    /Duplicate requirement definition/iu,
  )
  await specificationReject(
    fixture,
    'malformed ownership range',
    async (docs) => {
      const path = join(docs, '09-delivery-plan.md')
      const text = (await readFile(path)).toString().replace('`PR-01`–`PR-03`', '`PR-03`–`PR-01`')
      await writeFile(path, text)
    },
    /reversed/iu,
  )
  await specificationReject(
    fixture,
    'specification drift',
    async (docs) => {
      await appendFile(join(docs, '01-product-contract.md'), '\nThis text references PR-99.\n')
    },
    /undefined/iu,
  )
}

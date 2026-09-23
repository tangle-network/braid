import { REFERENCE_SIZES, SHA256_PATTERN } from './release-catalog.mjs'
import { assert, assertExactKeys, safeIdentifier } from './release-evidence.mjs'
import { readRegularFileNoFollow } from './release-files.mjs'
import { parseJson } from './release-json.mjs'
import { validateVisualProof } from './release-visual-proof.mjs'

function readJson(path, label, maxBytes) {
  return readRegularFileNoFollow(path, maxBytes).then((bytes) =>
    parseJson(bytes.toString('utf8'), label, maxBytes),
  )
}

function validatePackageProof(packageProof) {
  assertExactKeys(
    packageProof,
    [
      'tarball',
      'sha256',
      'version',
      'gitCommit',
      'treeSha256',
      'sourceDigest',
      'isolatedBuild',
      'sourceCheckout',
      'rpcRecords',
      'referenceSizes',
      'alternateScreenRestored',
      'sigintRestored',
      'stateWriteSymlinkSafe',
      'inlineStayedInMainScreen',
      'keyboardMatchesRpc',
      'eventLedgerMatchesRpc',
      'flowParity',
      'plainRecordState',
    ],
    [],
    'Package proof',
  )
  assert(SHA256_PATTERN.test(packageProof.sha256), 'Package proof has no valid tarball SHA-256')
  assert(SHA256_PATTERN.test(packageProof.sourceDigest), 'Package proof has no exact source digest')
  safeIdentifier(packageProof.tarball, 'Package proof tarball')
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(packageProof.version),
    'Package proof version is unsafe',
  )
  assert(/^[a-f0-9]{40}$/u.test(packageProof.gitCommit), 'Package proof commit is not a full SHA')
  assert(/^[a-f0-9]{40}$/u.test(packageProof.treeSha256), 'Package proof tree is not a full SHA')
  assert(
    Number.isInteger(packageProof.rpcRecords) && packageProof.rpcRecords > 0,
    'Package proof has no RPC records',
  )
  assert(Array.isArray(packageProof.referenceSizes), 'Package proof has no reference sizes')
  assert(
    packageProof.referenceSizes.length === REFERENCE_SIZES.length,
    'Package proof reference sizes are incomplete',
  )
  const referenceSizeKeys = new Set()
  for (const size of packageProof.referenceSizes) {
    assertExactKeys(size, ['columns', 'rows', 'events'], [], 'Package proof reference size')
    assert(
      Number.isInteger(size.columns) &&
        Number.isInteger(size.rows) &&
        Number.isInteger(size.events) &&
        size.columns > 0 &&
        size.rows > 0 &&
        size.events > 0,
      'Package proof reference size is malformed',
    )
    const key = `${size.columns}x${size.rows}`
    assert(!referenceSizeKeys.has(key), `Package proof repeats reference size ${key}`)
    referenceSizeKeys.add(key)
  }
  for (const [columns, rows] of REFERENCE_SIZES)
    assert(
      referenceSizeKeys.has(`${columns}x${rows}`),
      `Package proof is missing ${columns}x${rows}`,
    )
  assertExactKeys(
    packageProof.flowParity,
    ['rpc', 'terminal', 'plain', 'allFlowsMatch'],
    [],
    'Package proof flow parity',
  )
  for (const flow of ['rpc', 'terminal', 'plain']) {
    assert(
      Array.isArray(packageProof.flowParity[flow]),
      `Package proof ${flow} flow is not an array`,
    )
    assert(packageProof.flowParity[flow].length > 0, `Package proof ${flow} flow is empty`)
  }
  assert(packageProof.flowParity.allFlowsMatch === true, 'Package proof flow parity failed')
  for (const field of [
    'isolatedBuild',
    'alternateScreenRestored',
    'sigintRestored',
    'stateWriteSymlinkSafe',
    'inlineStayedInMainScreen',
    'keyboardMatchesRpc',
    'eventLedgerMatchesRpc',
    'plainRecordState',
  ])
    assert(packageProof[field] === true, `Package proof ${field} is not proven`)
}

export async function readAndValidateProofs({ packageProofPath, visualProofPath, artifactRoot }) {
  const packageProof = await readJson(packageProofPath, 'Package proof', 4 * 1024 * 1024)
  const visualProof = await readJson(visualProofPath, 'Visual proof', 8 * 1024 * 1024)
  validatePackageProof(packageProof)
  assert(packageProof.isolatedBuild === true, 'Package proof was not built in isolation')
  assert(
    packageProof.sourceCheckout === 'isolated-copy-of-worktree',
    'Package proof does not identify its isolated source checkout',
  )
  assert(visualProof.tarball === packageProof.tarball, 'Visual proof names another tarball')
  assert(visualProof.tarballSha256 === packageProof.sha256, 'Visual proof used another tarball')
  await validateVisualProof(visualProof, artifactRoot)
  return { packageProof, visualProof }
}

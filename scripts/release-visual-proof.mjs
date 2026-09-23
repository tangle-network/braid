import { join } from 'node:path'
import { REFERENCE_SIZES, REQUIRED_VISUAL_STATES, SHA256_PATTERN } from './release-catalog.mjs'
import { assert, assertExactKeys, safeIdentifier, strictIsoTimestamp } from './release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from './release-files.mjs'
import { canonicalJson, parseJson } from './release-json.mjs'
import { sha256 } from './release-specification.mjs'

const VISUAL_KINDS = new Set([
  'terminal-frame',
  'plain-frame',
  'png',
  'semantic-state',
  'asciicast',
  'ansi',
  'flow',
])

function readJson(path, label, maxBytes) {
  return readRegularFileNoFollow(path, maxBytes).then((bytes) =>
    parseJson(bytes.toString('utf8'), label, maxBytes),
  )
}

function validateVisualArtifact(artifact, artifacts) {
  assertExactKeys(
    artifact,
    ['path', 'sha256', 'kind', 'columns', 'rows'],
    ['state'],
    'Visual artifact',
  )
  assert(
    typeof artifact.path === 'string' && artifact.path.length > 0,
    'Visual artifact has no path',
  )
  assert(!artifacts.has(artifact.path), 'Visual proof repeats an artifact path')
  assert(SHA256_PATTERN.test(artifact.sha256), 'Visual artifact has no SHA-256')
  assert(
    Number.isInteger(artifact.columns) &&
      Number.isInteger(artifact.rows) &&
      artifact.columns > 0 &&
      artifact.rows > 0,
    'Visual artifact has invalid dimensions',
  )
  assert(VISUAL_KINDS.has(artifact.kind), 'Visual artifact has an invalid kind')
  if ('state' in artifact) safeIdentifier(artifact.state, 'Visual artifact state')
  if (
    artifact.kind === 'semantic-state' ||
    artifact.kind === 'asciicast' ||
    artifact.kind === 'ansi'
  )
    assert('state' in artifact, 'State visual artifact has no state')
  artifacts.set(artifact.path, artifact)
}

function requiredReferenceArtifacts(artifacts, referencedPaths) {
  for (const [columns, rows] of REFERENCE_SIZES) {
    for (const [suffix, kind] of [
      ['.txt', 'terminal-frame'],
      ['-plain.txt', 'plain-frame'],
      ['.png', 'png'],
    ]) {
      const path = `${columns}x${rows}${suffix}`
      const artifact = artifacts.get(path)
      referencedPaths.add(path)
      assert(
        artifact &&
          artifact.kind === kind &&
          artifact.columns === columns &&
          artifact.rows === rows,
        `Visual proof is missing ${path}`,
      )
    }
  }
  const flow = artifacts.get('80x24-flow.gif')
  referencedPaths.add('80x24-flow.gif')
  assert(
    flow && flow.kind === 'flow' && flow.columns === 80 && flow.rows === 24,
    'Visual proof is missing 80x24-flow.gif',
  )
}

async function validateVisualStates(visualProof, artifactRoot, artifacts, referencedPaths) {
  assert(Array.isArray(visualProof.states), 'Visual proof has no required state matrix')
  const visualStates = new Map(visualProof.states.map((state) => [state.name, state]))
  assert(visualStates.size === visualProof.states.length, 'Visual proof repeats a required state')
  assert(visualStates.size === REQUIRED_VISUAL_STATES.length, 'Visual proof has an extra state')
  for (const name of REQUIRED_VISUAL_STATES) {
    const state = visualStates.get(name)
    assert(state, `Visual proof is missing ${name} state`)
    assertExactKeys(state, ['name', 'columns', 'rows', 'artifacts'], [], `Visual state ${name}`)
    assert(
      Number.isInteger(state.columns) && Number.isInteger(state.rows),
      `${name} has no dimensions`,
    )
    assert(
      state.artifacts && typeof state.artifacts === 'object' && !Array.isArray(state.artifacts),
      `${name} has no artifact map`,
    )
    assertExactKeys(
      state.artifacts,
      ['semantic-state', 'plain-frame', 'asciicast', 'ansi', 'png'],
      [],
      `${name} artifact map`,
    )
    for (const kind of ['semantic-state', 'plain-frame', 'asciicast', 'ansi', 'png']) {
      const path = state.artifacts[kind]
      assert(typeof path === 'string' && path.length > 0, `${name} is missing ${kind}`)
      referencedPaths.add(path)
      const artifact = artifacts.get(path)
      assert(artifact, `${name} names an unknown ${kind} artifact`)
      assert(artifact.kind === kind, `${name} ${kind} artifact kind differs`)
      assert(artifact.state === name, `${name} ${kind} state differs`)
      assert(
        artifact.columns === state.columns && artifact.rows === state.rows,
        `${name} ${kind} dimensions differ`,
      )
    }
    const semanticPath = await containedArtifactPath(
      join(artifactRoot, 'w6'),
      state.artifacts['semantic-state'],
    )
    const semantic = await readJson(semanticPath, `${name} semantic state`, 4 * 1024 * 1024)
    assert(semantic.schemaVersion === 2, `${name} semantic state schema differs`)
    assert(semantic.capturePhase === 'atomic-signal-frame', `${name} capture phase differs`)
    assert(
      semantic.captureRevision === semantic.packedState?.view?.revision,
      `${name} frame revision differs`,
    )
    assert(
      semantic.packedState?.capturePhase === 'atomic-signal-frame',
      `${name} packed state phase differs`,
    )
    assert(
      semantic.packedState?.state?.revision === semantic.packedState?.view?.revision,
      `${name} packed state revision differs`,
    )
    assert(
      semantic.source?.binarySha256 === visualProof.binarySha256,
      `${name} binary provenance differs`,
    )
    assert(
      canonicalJson(semantic.provenance) === canonicalJson(visualProof.provenance),
      `${name} renderer provenance differs`,
    )
    if (name === 'interaction') {
      assert(semantic.packedState?.view?.interactions?.length === 1, 'Interaction state is empty')
      assert(
        semantic.packedState.view.interactions[0].answerSpec?.kind === 'boolean',
        'Interaction answer spec is not real',
      )
    }
    if (name === 'fork-preview') {
      assert(semantic.packedState?.view?.forkPreview?.allowed === true, 'Fork state is unavailable')
      assert(
        typeof semantic.packedState.view.forkPreview.destination === 'string',
        'Fork destination is missing',
      )
    }
  }
}

export async function validateVisualProof(visualProof, artifactRoot) {
  assertExactKeys(
    visualProof,
    [
      'schemaVersion',
      'generatedAt',
      'command',
      'binary',
      'binarySha256',
      'tarball',
      'tarballSha256',
      'fixture',
      'terminal',
      'node',
      'provenance',
      'states',
      'artifacts',
    ],
    [],
    'Visual proof',
  )
  assert(visualProof.schemaVersion === 3, 'Visual proof schema differs')
  strictIsoTimestamp(visualProof.generatedAt, 'Visual proof generation')
  for (const field of ['command', 'binary', 'fixture', 'terminal', 'node'])
    assert(
      typeof visualProof[field] === 'string' && visualProof[field].length > 0,
      `Visual proof has no ${field}`,
    )
  assert(SHA256_PATTERN.test(visualProof.binarySha256), 'Visual proof has no binary SHA-256')
  assert(SHA256_PATTERN.test(visualProof.tarballSha256), 'Visual proof has no tarball SHA-256')
  safeIdentifier(visualProof.tarball, 'Visual proof tarball')
  assert(
    visualProof.binary === 'clean npm install from generated tarball',
    'Visual proof is not packed',
  )
  assert(
    visualProof.provenance?.renderer?.package === '@earendil-works/pi-tui@0.83.0',
    'Visual proof renderer package is not pinned',
  )
  assert(
    typeof visualProof.provenance?.renderer?.pty === 'string',
    'Visual proof has no PTY provenance',
  )
  assert(
    typeof visualProof.provenance?.renderer?.emulator === 'string',
    'Visual proof has no terminal emulator provenance',
  )
  assert(
    typeof visualProof.provenance?.renderer?.node === 'string',
    'Visual proof has no Node provenance',
  )
  assert(
    visualProof.provenance?.raster?.colorMode === 'sRGB 8-bit',
    'Visual proof color mode is not pinned',
  )
  assert(
    visualProof.provenance?.raster?.fontFamily === 'DejaVu Sans Mono',
    'Visual proof font family is not pinned',
  )
  assert(
    typeof visualProof.provenance?.raster?.font === 'string',
    'Visual proof has no font provenance',
  )
  assert(
    typeof visualProof.provenance?.raster?.agg === 'string',
    'Visual proof has no agg provenance',
  )
  assert(
    typeof visualProof.provenance?.raster?.imagemagick === 'string',
    'Visual proof has no ImageMagick provenance',
  )
  assertExactKeys(visualProof.provenance, ['renderer', 'raster'], [], 'Visual proof provenance')
  assertExactKeys(
    visualProof.provenance.renderer,
    ['package', 'pty', 'emulator', 'node', 'terminal'],
    [],
    'Visual renderer provenance',
  )
  assertExactKeys(
    visualProof.provenance.raster,
    ['agg', 'imagemagick', 'fontFamily', 'font', 'colorMode'],
    [],
    'Visual raster provenance',
  )
  assert(Array.isArray(visualProof.artifacts), 'Visual proof has no artifacts')
  const artifacts = new Map()
  for (const artifact of visualProof.artifacts) validateVisualArtifact(artifact, artifacts)
  const referencedPaths = new Set()
  requiredReferenceArtifacts(artifacts, referencedPaths)
  await validateVisualStates(visualProof, artifactRoot, artifacts, referencedPaths)
  assert(
    referencedPaths.size === artifacts.size &&
      [...artifacts.keys()].every((path) => referencedPaths.has(path)),
    'Visual proof contains an unreferenced artifact',
  )
  for (const artifact of artifacts.values()) {
    const path = await containedArtifactPath(join(artifactRoot, 'w6'), artifact.path)
    assert((await sha256(path)) === artifact.sha256, 'Visual artifact hash changed')
  }
}

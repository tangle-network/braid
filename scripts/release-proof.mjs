import { join } from 'node:path'
import { assert } from './release-evidence.mjs'
import { REFERENCE_SIZES, REQUIRED_VISUAL_STATES, SHA256_PATTERN } from './release-catalog.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from './release-files.mjs'
import { sha256 } from './release-specification.mjs'

export async function readAndValidateProofs({ packageProofPath, visualProofPath, artifactRoot }) {
  const packageProof = JSON.parse(
    (await readRegularFileNoFollow(packageProofPath)).toString('utf8'),
  )
  const visualProof = JSON.parse((await readRegularFileNoFollow(visualProofPath)).toString('utf8'))
  assert(SHA256_PATTERN.test(packageProof.sha256), 'Package proof has no valid tarball SHA-256')
  assert(SHA256_PATTERN.test(packageProof.sourceDigest), 'Package proof has no exact source digest')
  assert(packageProof.isolatedBuild === true, 'Package proof was not built in isolation')
  assert(
    packageProof.sourceCheckout === 'isolated-copy-of-worktree',
    'Package proof does not identify its isolated source checkout',
  )
  assert(visualProof.tarballSha256 === packageProof.sha256, 'Visual proof used another tarball')
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

  for (const [columns, rows] of REFERENCE_SIZES) {
    for (const suffix of ['.txt', '-plain.txt', '.png']) {
      assert(
        visualProof.artifacts.some(
          (artifact) =>
            artifact.columns === columns &&
            artifact.rows === rows &&
            artifact.path === `${columns}x${rows}${suffix}`,
        ),
        `Visual proof is missing ${columns}x${rows}${suffix}`,
      )
    }
  }
  assert(
    visualProof.artifacts.some((artifact) => artifact.path === '80x24-flow.gif'),
    'Visual proof is missing 80x24-flow.gif',
  )
  assert(Array.isArray(visualProof.states), 'Visual proof has no required state matrix')
  const visualStates = new Map(visualProof.states.map((state) => [state.name, state]))
  assert(visualStates.size === visualProof.states.length, 'Visual proof repeats a required state')
  for (const name of REQUIRED_VISUAL_STATES) {
    const state = visualStates.get(name)
    assert(state, `Visual proof is missing ${name} state`)
    assert(
      Number.isInteger(state.columns) && Number.isInteger(state.rows),
      `${name} has no dimensions`,
    )
    assert(
      state.artifacts && typeof state.artifacts === 'object' && !Array.isArray(state.artifacts),
      `${name} has no artifact map`,
    )
    for (const kind of ['semantic-state', 'plain-frame', 'asciicast', 'ansi', 'png']) {
      const path = state.artifacts[kind]
      assert(typeof path === 'string' && path.length > 0, `${name} is missing ${kind}`)
      const artifact = visualProof.artifacts.find((candidate) => candidate.path === path)
      assert(artifact, `${name} names an unknown ${kind} artifact`)
      assert(artifact.kind === kind, `${name} ${kind} artifact kind differs`)
      assert(
        artifact.columns === state.columns && artifact.rows === state.rows,
        `${name} ${kind} dimensions differ`,
      )
    }
    const semanticPath = await containedArtifactPath(
      join(artifactRoot, 'w6'),
      state.artifacts['semantic-state'],
    )
    const semantic = JSON.parse((await readRegularFileNoFollow(semanticPath)).toString('utf8'))
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
      JSON.stringify(semantic.provenance) === JSON.stringify(visualProof.provenance),
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
  for (const artifact of visualProof.artifacts) {
    const path = await containedArtifactPath(join(artifactRoot, 'w6'), artifact.path)
    assert(
      (await sha256(path)) === artifact.sha256,
      `Visual artifact hash changed: ${artifact.path}`,
    )
  }
  return { packageProof, visualProof }
}

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { assert } from './release-evidence.mjs'
import { containedArtifactPath, readRegularFileNoFollow } from './release-files.mjs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/u

async function sha256(path) {
  return createHash('sha256')
    .update(await readRegularFileNoFollow(path))
    .digest('hex')
}

export async function validateVisualProof({ packageProof, visualProof, artifactRoot }) {
  const packageJson = JSON.parse(
    (await readRegularFileNoFollow(join(artifactRoot, '..', '..', 'package.json'))).toString(
      'utf8',
    ),
  )
  const expectedRenderer = {
    package: `@earendil-works/pi-tui@${packageJson.dependencies?.['@earendil-works/pi-tui'] ?? ''}`,
    pty: `node-pty@${packageJson.devDependencies?.['node-pty'] ?? ''}`,
    emulator: `@xterm/headless@${packageJson.devDependencies?.['@xterm/headless'] ?? ''}`,
  }
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
  assert(visualProof.schemaVersion === 3, 'Visual proof schema is not current')
  assert(SHA256_PATTERN.test(visualProof.binarySha256), 'Visual proof has no binary SHA-256')
  assert(Array.isArray(visualProof.artifacts), 'Visual proof has no artifact list')
  assert(
    visualProof.provenance?.renderer?.package === expectedRenderer.package,
    'Visual proof renderer package differs from package.json',
  )
  assert(
    visualProof.provenance?.renderer?.pty === expectedRenderer.pty,
    'Visual proof PTY differs from package.json',
  )
  assert(
    visualProof.provenance?.renderer?.emulator === expectedRenderer.emulator,
    'Visual proof emulator differs from package.json',
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
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ]) {
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
  assert(
    visualProof.artifacts.some(
      (artifact) =>
        artifact.path === 'raw/transcript-keyboard.cast' && artifact.kind === 'keyboard-asciicast',
    ),
    'Visual proof is missing the transcript keyboard asciicast',
  )
  assert(
    visualProof.artifacts.some(
      (artifact) =>
        artifact.path === '80x24-transcript-keyboard.gif' && artifact.kind === 'keyboard-flow',
    ),
    'Visual proof is missing the transcript keyboard GIF',
  )
  assert(
    JSON.stringify(visualProof.keyboardFlow?.steps) ===
      JSON.stringify(['8 completed turns', 'Page Up', 'Alt+Home', 'Page Down', 'Alt+End']),
    'Visual proof transcript keyboard steps differ',
  )
  const artifactPaths = new Set()
  for (const artifact of visualProof.artifacts) {
    assert(
      typeof artifact.path === 'string' && artifact.path.length > 0,
      'Visual artifact has no path',
    )
    assert(!artifactPaths.has(artifact.path), `Visual proof repeats ${artifact.path}`)
    artifactPaths.add(artifact.path)
  }
  const requiredVisualStates = [
    'empty',
    'active-streaming',
    'interaction',
    'fork-preview',
    'graph-or-analysis',
    'narrow',
    'failure-or-reconnect',
  ]
  assert(Array.isArray(visualProof.states), 'Visual proof has no required state matrix')
  const visualStates = new Map(visualProof.states.map((state) => [state.name, state]))
  assert(visualStates.size === visualProof.states.length, 'Visual proof repeats a required state')
  for (const name of requiredVisualStates) {
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
}

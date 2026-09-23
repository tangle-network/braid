import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function bytesHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function addArtifact(
  root,
  artifacts,
  id,
  path,
  bytes,
  mediaType = 'application/octet-stream',
) {
  const fullPath = join(root, path)
  await mkdir(join(fullPath, '..'), { recursive: true })
  await writeFile(fullPath, bytes)
  artifacts.push({ id, path, sha256: bytesHash(bytes), mediaType })
}

export async function makeVisualProof(root, generatedAt, tarballSha256, binarySha256, artifacts) {
  const provenance = {
    renderer: {
      package: '@earendil-works/pi-tui@0.83.0',
      pty: 'node-pty@1.1.0',
      emulator: '@xterm/headless@5.5.0',
      node: process.version,
      terminal: 'xterm-256color',
    },
    raster: {
      agg: 'agg fixture',
      imagemagick: 'ImageMagick fixture',
      fontFamily: 'DejaVu Sans Mono',
      font: 'DejaVu Sans Mono fixture',
      colorMode: 'sRGB 8-bit',
    },
  }
  const visualArtifacts = []
  const addVisual = async (path, kind, columns, rows, state, bytes) => {
    const id = `visual-${visualArtifacts.length}`
    await addArtifact(root, artifacts, id, `artifacts/verification/w6/${path}`, bytes)
    visualArtifacts.push({ path, kind, columns, rows, ...(state ? { state } : {}) })
  }
  for (const [columns, rows] of [
    [40, 12],
    [80, 24],
    [120, 40],
    [200, 60],
  ]) {
    await addVisual(
      `${columns}x${rows}.txt`,
      'terminal-frame',
      columns,
      rows,
      undefined,
      Buffer.from(`${columns}x${rows}\n`),
    )
    await addVisual(
      `${columns}x${rows}-plain.txt`,
      'plain-frame',
      columns,
      rows,
      undefined,
      Buffer.from(`${columns}x${rows} plain\n`),
    )
    await addVisual(
      `${columns}x${rows}.png`,
      'png',
      columns,
      rows,
      undefined,
      Buffer.from(`PNG fixture ${columns}x${rows}\n`),
    )
  }
  const states = []
  for (const [name, columns, rows] of [
    ['empty', 80, 24],
    ['active-streaming', 80, 24],
    ['interaction', 80, 24],
    ['fork-preview', 80, 24],
    ['graph-or-analysis', 80, 24],
    ['narrow', 40, 12],
    ['failure-or-reconnect', 80, 24],
  ]) {
    const stateArtifacts = {
      'semantic-state': `states/${name}.json`,
      'plain-frame': `states/${name}.txt`,
      asciicast: `raw/${name}.cast`,
      ansi: `states/${name}.ansi`,
      png: `states/${name}.png`,
    }
    const view = {
      revision: 1,
      interactions: name === 'interaction' ? [{ answerSpec: { kind: 'boolean' } }] : [],
      ...(name === 'fork-preview'
        ? { forkPreview: { allowed: true, destination: 'fixture-destination' } }
        : {}),
    }
    const semantic = {
      schemaVersion: 2,
      capturePhase: 'atomic-signal-frame',
      captureRevision: 1,
      provenance,
      source: { binarySha256 },
      packedState: { capturePhase: 'atomic-signal-frame', state: { revision: 1 }, view },
    }
    await addVisual(
      stateArtifacts['semantic-state'],
      'semantic-state',
      columns,
      rows,
      name,
      Buffer.from(JSON.stringify(semantic)),
    )
    await addVisual(
      stateArtifacts['plain-frame'],
      'plain-frame',
      columns,
      rows,
      name,
      Buffer.from(`${name}\n`),
    )
    await addVisual(
      stateArtifacts.asciicast,
      'asciicast',
      columns,
      rows,
      name,
      Buffer.from(`cast ${name}\n`),
    )
    await addVisual(stateArtifacts.ansi, 'ansi', columns, rows, name, Buffer.from(`ansi ${name}\n`))
    await addVisual(stateArtifacts.png, 'png', columns, rows, name, Buffer.from(`png ${name}\n`))
    states.push({ name, columns, rows, artifacts: stateArtifacts })
  }
  await addVisual('80x24-flow.gif', 'flow', 80, 24, undefined, Buffer.from('gif fixture\n'))
  await writeFile(
    join(root, 'artifacts/verification/w6/capture-manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 3,
        generatedAt,
        command: 'pnpm capture:visual',
        binary: 'clean npm install from generated tarball',
        binarySha256,
        tarball: 'fixture-package.tgz',
        tarballSha256,
        fixture: 'deterministic',
        terminal: 'node-pty/xterm-256color',
        node: process.version,
        provenance,
        states,
        artifacts: visualArtifacts.map((artifact) => ({
          ...artifact,
          sha256: artifacts.find(
            (candidate) => candidate.path === `artifacts/verification/w6/${artifact.path}`,
          ).sha256,
        })),
      },
      null,
      2,
    )}\n`,
  )
}

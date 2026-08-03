import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installPackedBraid } from './packed-binary.mjs'
import {
  artifactFor,
  captureProvenance,
  writeFlow,
  writeRaster,
} from './visual-capture-artifacts.mjs'
import { capturePlainFrame } from './visual-capture-plain.mjs'
import { baselineCapture, STATE_DEFINITIONS } from './visual-capture-scenarios.mjs'
import { castFor, normalized, sha256, spawnTerminal } from './visual-capture-terminal.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const packed = await installPackedBraid(repository)
const binary = packed.binary
const outputRoot = join(repository, 'artifacts', 'verification', 'w6')
const rawRoot = join(outputRoot, 'raw')
const stateRoot = join(outputRoot, 'states')
const sizes = [
  [40, 12],
  [80, 24],
  [120, 40],
  [200, 60],
]
const createTerminal = (name, columns, rows, extraEnvironment = {}, uiFixture) =>
  spawnTerminal({
    name,
    columns,
    rows,
    repository,
    binary,
    rawRoot,
    extraEnvironment,
    uiFixture,
  })

try {
  await mkdir(rawRoot, { recursive: true })
  await mkdir(stateRoot, { recursive: true })
  const artifacts = []
  const plain = await capturePlainFrame({ binary, repository, rawRoot })
  for (const [columns, rows] of sizes) {
    const result = await baselineCapture({ createTerminal, columns, rows })
    const name = `${columns}x${rows}`
    const castPath = join(rawRoot, `${name}.cast`)
    const frameCastPath = join(rawRoot, `${name}-frame.cast`)
    const textPath = join(outputRoot, `${name}.txt`)
    const plainPath = join(outputRoot, `${name}-plain.txt`)
    const gifPath = join(rawRoot, `${name}.gif`)
    const pngPath = join(outputRoot, `${name}.png`)
    await writeFile(castPath, result.cast)
    await writeFile(frameCastPath, result.frameCast)
    await writeFile(textPath, result.finalScreen)
    await writeFile(plainPath, plain)
    await writeRaster(frameCastPath, pngPath, gifPath)
    artifacts.push(
      await artifactFor(textPath, 'terminal-frame', columns, rows, undefined, outputRoot),
    )
    artifacts.push(
      await artifactFor(plainPath, 'plain-frame', columns, rows, undefined, outputRoot),
    )
    artifacts.push(await artifactFor(pngPath, 'png', columns, rows, undefined, outputRoot))
  }

  const stateManifests = []
  for (const definition of STATE_DEFINITIONS) {
    const terminal = await createTerminal(
      `state-${definition.name}`,
      definition.columns,
      definition.rows,
      definition.environment,
      definition.uiFixture,
    )
    try {
      const result = await definition.run(terminal)
      const provenance = await captureProvenance()
      if (definition.name === 'active-streaming') {
        if (result.record.view?.status !== 'running')
          throw new Error('active-streaming frame and semantic state disagree')
        if (!normalized(result.point.screen).includes('streaming'))
          throw new Error('active-streaming frame is not streaming')
      }
      if (
        result.record.capturePhase !== 'atomic-signal-frame' ||
        result.record.state?.revision !== result.record.view?.revision
      )
        throw new Error('frame and semantic state were not captured at one revision')
      if (definition.name === 'interaction') {
        if (result.record.view?.interactions?.length !== 1)
          throw new Error('interaction capture did not contain an interaction fixture')
      }
      if (definition.name === 'fork-preview' && result.record.view?.forkPreview?.allowed !== true)
        throw new Error('fork capture did not contain an allowed fork preview')
      const stateRootName = definition.name.replaceAll('/', '-')
      const semanticPath = join(stateRoot, `${stateRootName}.json`)
      const plainPath = join(stateRoot, `${stateRootName}.txt`)
      const ansiPath = join(stateRoot, `${stateRootName}.ansi`)
      const castPath = join(rawRoot, `${stateRootName}.cast`)
      const frameCastPath = join(rawRoot, `${stateRootName}-frame.cast`)
      const gifPath = join(rawRoot, `${stateRootName}.gif`)
      const pngPath = join(stateRoot, `${stateRootName}.png`)
      const semantic = {
        schemaVersion: 2,
        state: definition.name,
        source: {
          binary: 'packed real binary from clean npm install',
          binarySha256: await sha256(binary),
          tarball: packed.tarballName,
          tarballSha256: packed.tarballSha256,
        },
        dimensions: { columns: definition.columns, rows: definition.rows },
        terminal: 'node-pty/xterm-256color',
        provenance,
        capturePhase: 'atomic-signal-frame',
        captureRevision: result.record.view.revision,
        frame: result.point.screen,
        packedState: result.record,
      }
      const cast = castFor(terminal, terminal.events, `Braid W6 state ${definition.name}`)
      const frameCast = castFor(
        terminal,
        terminal.events.slice(0, result.point.eventCount),
        `Braid W6 state ${definition.name}`,
      )
      await writeFile(semanticPath, `${JSON.stringify(semantic, null, 2)}\n`)
      await writeFile(plainPath, result.point.screen)
      await writeFile(ansiPath, result.point.output)
      await writeFile(castPath, cast)
      await writeFile(frameCastPath, frameCast)
      await writeRaster(frameCastPath, pngPath, gifPath)
      const stateArtifacts = [
        await artifactFor(
          semanticPath,
          'semantic-state',
          definition.columns,
          definition.rows,
          definition.name,
          outputRoot,
        ),
        await artifactFor(
          plainPath,
          'plain-frame',
          definition.columns,
          definition.rows,
          definition.name,
          outputRoot,
        ),
        await artifactFor(
          castPath,
          'asciicast',
          definition.columns,
          definition.rows,
          definition.name,
          outputRoot,
        ),
        await artifactFor(
          ansiPath,
          'ansi',
          definition.columns,
          definition.rows,
          definition.name,
          outputRoot,
        ),
        await artifactFor(
          pngPath,
          'png',
          definition.columns,
          definition.rows,
          definition.name,
          outputRoot,
        ),
      ]
      artifacts.push(...stateArtifacts)
      stateManifests.push({
        name: definition.name,
        columns: definition.columns,
        rows: definition.rows,
        artifacts: Object.fromEntries(
          stateArtifacts.map((artifact) => [artifact.kind, artifact.path]),
        ),
      })
    } finally {
      await terminal.dispose()
    }
  }

  const flowPath = join(rawRoot, '80x24-frame.cast')
  const flowGif = join(outputRoot, '80x24-flow.gif')
  await writeFlow(flowPath, flowGif)
  artifacts.push(await artifactFor(flowGif, 'flow', 80, 24, undefined, outputRoot))

  const manifestPath = join(outputRoot, 'capture-manifest.json')
  const provenance = await captureProvenance()
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 3,
        generatedAt: new Date().toISOString(),
        command: 'pnpm capture:visual',
        binary: 'clean npm install from generated tarball',
        binarySha256: await sha256(binary),
        tarball: packed.tarballName,
        tarballSha256: packed.tarballSha256,
        fixture: 'deterministic',
        terminal: 'node-pty/xterm-256color',
        node: process.version,
        provenance,
        states: stateManifests,
        artifacts,
      },
      null,
      2,
    )}\n`,
  )
  process.stdout.write(
    `Wrote ${artifacts.length} W6 visual artifacts and ${stateManifests.length} required states to ${outputRoot}\n`,
  )
} finally {
  await packed.cleanup()
}

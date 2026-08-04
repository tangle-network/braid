import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const require = createRequire(import.meta.url)
const MAX_FLOW_FRAME_PEAK_ERROR = 0.03

function packageVersion(name) {
  const packageJson = require(`${name}/package.json`)
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0)
    throw new Error(`Cannot determine installed version for ${name}`)
  return `${name}@${packageJson.version}`
}

export async function writeRaster(frameCastPath, pngPath, gifPath) {
  const fontFamily = 'DejaVu Sans Mono'
  await run('agg', [
    '--quiet',
    '--theme',
    'github-dark',
    '--font-size',
    '16',
    '--idle-time-limit',
    '1',
    '--last-frame-duration',
    '1',
    '--select',
    '100%',
    '--no-loop',
    '--font-family',
    fontFamily,
    frameCastPath,
    gifPath,
  ])
  await run('convert', [`${gifPath}[0]`, '-colorspace', 'sRGB', '-depth', '8', pngPath])
  await rm(gifPath, { force: true })
}

export function assertFlowFrameIntegrity(metric, label) {
  const match = /\(([0-9]+(?:\.[0-9]+)?)\)/u.exec(metric)
  const normalizedPeakError = match ? Number(match[1]) : Number.NaN
  if (!Number.isFinite(normalizedPeakError) || normalizedPeakError > MAX_FLOW_FRAME_PEAK_ERROR) {
    throw new Error(`${label} differs from its source frame: ${metric || 'missing metric'}`)
  }
  return normalizedPeakError
}

async function peakError(expectedPath, actualPath, label) {
  let output = ''
  try {
    const result = await run('compare', ['-metric', 'PAE', expectedPath, actualPath, 'null:'])
    output = `${result.stdout}${result.stderr}`.trim()
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim()
  }
  return assertFlowFrameIntegrity(output, label)
}

export async function writeFlowGif(startPath, endPath, gifPath) {
  const verificationRoot = await mkdtemp(join(tmpdir(), 'braid-flow-'))
  try {
    await run('convert', [
      '-dispose',
      'Background',
      '-delay',
      '5',
      startPath,
      '-dispose',
      'Background',
      '-delay',
      '200',
      endPath,
      '-loop',
      '0',
      gifPath,
    ])
    await run('convert', [gifPath, '-coalesce', join(verificationRoot, 'frame-%02d.png')])
    const frames = (await readdir(verificationRoot)).sort()
    if (frames.length !== 2)
      throw new Error(`flow GIF contains ${frames.length} frames, expected 2`)
    await peakError(startPath, join(verificationRoot, frames[0]), 'flow start')
    await peakError(endPath, join(verificationRoot, frames[1]), 'flow finish')
  } finally {
    await rm(verificationRoot, { force: true, recursive: true })
  }
}

async function toolVersion(command, args) {
  try {
    const result = await run(command, args)
    return (result.stdout || result.stderr || '').trim().split('\n')[0] || 'unknown'
  } catch (error) {
    return `unavailable: ${error.message}`
  }
}

export async function captureProvenance() {
  return {
    renderer: {
      package: packageVersion('@earendil-works/pi-tui'),
      pty: packageVersion('node-pty'),
      emulator: packageVersion('@xterm/headless'),
      node: process.version,
      terminal: 'xterm-256color',
    },
    raster: {
      agg: await toolVersion('agg', ['--version']),
      imagemagick: await toolVersion('convert', ['-version']),
      fontFamily: 'DejaVu Sans Mono',
      font: await toolVersion('fc-match', [
        '--format=%{family} | %{style} | %{file}',
        'DejaVu Sans Mono',
      ]),
      colorMode: 'sRGB 8-bit',
    },
  }
}

export function createArtifactFor(outputRoot, sha256) {
  return async function artifactFor(path, kind, columns, rows, state) {
    return {
      path: relative(outputRoot, path),
      sha256: await sha256(path),
      kind,
      ...(state ? { state } : {}),
      columns,
      rows,
    }
  }
}

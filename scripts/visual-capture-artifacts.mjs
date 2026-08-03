import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from './visual-capture-terminal.mjs'

const run = promisify(execFile)

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
    '--no-loop',
    '--font-family',
    fontFamily,
    frameCastPath,
    gifPath,
  ])
  await run('convert', [
    gifPath,
    '-coalesce',
    '-delete',
    '0--2',
    '-colorspace',
    'sRGB',
    '-depth',
    '8',
    pngPath,
  ])
  await rm(gifPath, { force: true })
}

export async function writeFlow(frameCastPath, gifPath) {
  await run('agg', [
    '--quiet',
    '--theme',
    'github-dark',
    '--font-size',
    '16',
    '--font-family',
    'DejaVu Sans Mono',
    '--speed',
    '2',
    '--idle-time-limit',
    '1',
    '--last-frame-duration',
    '2',
    frameCastPath,
    gifPath,
  ])
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
      package: '@earendil-works/pi-tui@0.83.0',
      pty: 'node-pty@1.1.0',
      emulator: '@xterm/headless@5.5.0',
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

export async function artifactFor(path, kind, columns, rows, state, outputRoot) {
  return {
    path: relative(outputRoot, path),
    sha256: await sha256(path),
    kind,
    ...(state ? { state } : {}),
    columns,
    rows,
  }
}

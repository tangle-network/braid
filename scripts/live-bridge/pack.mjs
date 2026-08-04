import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { runCommand } from './command.mjs'
import { exitCodes } from './constants.mjs'
import { LiveBridgeError } from './errors.mjs'
import { nativeInstallEnvironment } from '../native-install-environment.mjs'

export async function buildPackedBinary(evidence, repository, registerTemp) {
  const packRoot = await mkdtemp(join(tmpdir(), 'braid-live-pack-'))
  registerTemp(packRoot)
  const installRoot = await mkdtemp(join(tmpdir(), 'braid-live-install-'))
  registerTemp(installRoot)
  evidence.temp = { packRoot, installRoot }
  const build = await runCommand('pnpm', ['run', 'build'], { cwd: repository })
  evidence.build = build
  if (build.code !== 0 || build.cleanupOk !== true) {
    throw new LiveBridgeError(
      'PACK_BUILD_FAILED',
      'Braid build failed before the live packed run',
      exitCodes.failed,
      { build },
    )
  }
  const pack = await runCommand('pnpm', ['pack', '--pack-destination', packRoot], {
    cwd: repository,
  })
  evidence.packCommand = pack
  if (pack.code !== 0 || pack.cleanupOk !== true) {
    throw new LiveBridgeError(
      'PACK_FAILED',
      'Braid packaging failed before the live packed run',
      exitCodes.failed,
      { pack },
    )
  }
  const tarballName = (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
  if (!tarballName)
    throw new LiveBridgeError('PACK_MISSING', 'pnpm pack produced no tarball', exitCodes.failed)
  const tarball = join(packRoot, tarballName)
  await writeFile(
    join(installRoot, 'package.json'),
    '{"name":"braid-live-install","private":true}\n',
    { mode: 0o600 },
  )
  const installArgs = [
    'install',
    ...(process.env.BRAID_LIVE_BRIDGE_OFFLINE === '1' ? ['--offline'] : []),
    '--no-audit',
    '--no-fund',
    tarball,
  ]
  const install = await runCommand('npm', installArgs, {
    cwd: installRoot,
    env: nativeInstallEnvironment(),
  })
  evidence.install = install
  if (install.code !== 0 || install.cleanupOk !== true) {
    throw new LiveBridgeError(
      'PACK_INSTALL_FAILED',
      'The packed Braid artifact could not be installed in isolation',
      exitCodes.failed,
      { install },
    )
  }
  const binary = join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'braid.cmd' : 'braid',
  )
  const version = await runCommand(process.execPath, [binary, '--version'], { cwd: installRoot })
  evidence.version = version
  if (version.code !== 0 || version.cleanupOk !== true)
    throw new LiveBridgeError(
      'PACK_BINARY_FAILED',
      'The packed Braid binary did not start',
      exitCodes.failed,
      { version },
    )
  evidence.artifact = {
    tarball: tarballName,
    sha256: createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex'),
    binary: relative(installRoot, binary),
  }
  return { packRoot, installRoot, binary }
}

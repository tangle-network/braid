import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { nativeInstallEnvironment } from './native-install-environment.mjs'

const run = promisify(execFile)

export async function installPackedBraid(repository, options = {}) {
  const suppliedTarball = options.tarballPath ?? process.env.BRAID_RELEASE_TARBALL
  const packRoot = suppliedTarball ? undefined : await mkdtemp(join(tmpdir(), 'braid-pack-'))
  const installRoot = await mkdtemp(join(tmpdir(), 'braid-install-'))
  const cleanup = async () => {
    await Promise.all([
      packRoot ? rm(packRoot, { force: true, recursive: true }) : Promise.resolve(),
      rm(installRoot, { force: true, recursive: true }),
    ])
  }
  try {
    if (packRoot) await run('pnpm', ['pack', '--pack-destination', packRoot], { cwd: repository })
    const tarballName = packRoot
      ? (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
      : basename(suppliedTarball)
    if (!tarballName) throw new Error('pnpm pack did not produce a tarball')
    const tarball = packRoot ? join(packRoot, tarballName) : resolve(suppliedTarball)
    const tarballInfo = await lstat(tarball)
    if (!tarballInfo.isFile() || tarballInfo.isSymbolicLink())
      throw new Error('packed Braid tarball must be a regular non-symlink file')
    await writeFile(
      join(installRoot, 'package.json'),
      `${JSON.stringify({ name: 'braid-packed-binary-proof', private: true })}\n`,
    )
    await run('npm', ['install', '--no-audit', '--no-fund', '--package-lock=false', tarball], {
      cwd: installRoot,
      env: nativeInstallEnvironment(),
    })
    const binary = join(
      installRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'braid.cmd' : 'braid',
    )
    return {
      binary,
      installRoot,
      tarball,
      tarballName,
      tarballSha256: createHash('sha256')
        .update(await readFile(tarball))
        .digest('hex'),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

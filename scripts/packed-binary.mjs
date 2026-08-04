import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { nativeInstallEnvironment } from './native-install-environment.mjs'

const run = promisify(execFile)

export async function installPackedBraid(repository) {
  const packRoot = await mkdtemp(join(tmpdir(), 'braid-pack-'))
  const installRoot = await mkdtemp(join(tmpdir(), 'braid-install-'))
  const cleanup = async () => {
    await Promise.all([
      rm(packRoot, { force: true, recursive: true }),
      rm(installRoot, { force: true, recursive: true }),
    ])
  }
  try {
    await run('pnpm', ['pack', '--pack-destination', packRoot], { cwd: repository })
    const tarballName = (await readdir(packRoot)).find((name) => name.endsWith('.tgz'))
    if (!tarballName) throw new Error('pnpm pack did not produce a tarball')
    const tarball = join(packRoot, tarballName)
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

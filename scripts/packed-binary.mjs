import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
    await run(
      'npm',
      ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
      {
        cwd: installRoot,
      },
    )
    const binary = join(
      installRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'braid.cmd' : 'braid',
    )
    return {
      binary,
      installRoot,
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

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertRegistryVersionAvailable } from './check-registry-collision.mjs'

function result(exitCode, stdout = '', stderr = '', cleanupConfirmed = true) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    spawnError: null,
    cleanupConfirmed,
    stdout: { bytes: Buffer.from(stdout) },
    stderr: { bytes: Buffer.from(stderr) },
  }
}

test('a registry 404 is the only lookup failure accepted as an available version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-registry-available-'))
  try {
    await writeFile(join(root, 'candidate.tgz'), 'candidate bytes')
    const outcome = await assertRegistryVersionAvailable({
      packageSpec: '@tangle-network/braid@1.0.0',
      tarballPath: join(root, 'candidate.tgz'),
      workingDirectory: root,
      runCommand: async () => result(1, '', 'npm ERR! code E404\nnpm ERR! 404 Not Found'),
    })
    assert.deepEqual(outcome, {
      packageSpec: '@tangle-network/braid@1.0.0',
      status: 'available',
    })

    await assert.rejects(
      assertRegistryVersionAvailable({
        packageSpec: '@tangle-network/braid@1.0.0',
        tarballPath: join(root, 'candidate.tgz'),
        workingDirectory: root,
        runCommand: async () => result(1, '', 'npm ERR! code EAI_AGAIN'),
      }),
      /Registry lookup failed/u,
    )
    await assert.rejects(
      assertRegistryVersionAvailable({
        packageSpec: '@tangle-network/braid@1.0.0',
        tarballPath: join(root, 'candidate.tgz'),
        workingDirectory: root,
        runCommand: async () => result(1, '', 'npm ERR! code E404\nnpm ERR! 404 Not Found', false),
      }),
      /did not confirm process cleanup/u,
    )
    await assert.rejects(
      assertRegistryVersionAvailable({
        packageSpec: '@tangle-network/braid@1.0.0',
        tarballPath: join(root, 'candidate.tgz'),
        workingDirectory: root,
        runCommand: async () => result(null, '', 'npm ERR! code E404\nnpm ERR! 404 Not Found'),
      }),
      /did not return an exit code/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a different existing tarball fails closed before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-registry-different-'))
  const candidatePath = join(root, 'candidate.tgz')
  const filename = 'example-braid-1.0.0.tgz'
  try {
    await writeFile(candidatePath, 'candidate bytes')
    await assert.rejects(
      assertRegistryVersionAvailable({
        packageSpec: '@tangle-network/braid@1.0.0',
        tarballPath: candidatePath,
        workingDirectory: root,
        runCommand: async ({ args, cwd }) => {
          if (args[0] === 'view') return result(0, '1.0.0\n')
          await writeFile(join(cwd, filename), 'different registry bytes')
          return result(0, filename)
        },
      }),
      /exists with a different tarball/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an identical existing tarball is accepted as an idempotent publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'braid-registry-identical-'))
  const candidatePath = join(root, 'candidate.tgz')
  const filename = 'example-braid-1.0.0.tgz'
  try {
    const bytes = Buffer.from('candidate bytes')
    await writeFile(candidatePath, bytes)
    const outcome = await assertRegistryVersionAvailable({
      packageSpec: '@tangle-network/braid@1.0.0',
      tarballPath: candidatePath,
      workingDirectory: root,
      runCommand: async ({ args, cwd }) => {
        if (args[0] === 'view') return result(0, '1.0.0\n')
        await writeFile(join(cwd, filename), bytes)
        return result(0, filename)
      },
    })
    assert.equal(outcome.status, 'already-published')
    assert.equal(outcome.sha256.length, 64)
    assert.deepEqual(await readFile(join(root, filename)), bytes)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('registry options and other package names are rejected before npm runs', async () => {
  let calls = 0
  for (const packageSpec of ['--registry=https://attacker.invalid', '@example/braid@1.0.0']) {
    await assert.rejects(
      assertRegistryVersionAvailable({
        packageSpec,
        tarballPath: 'unused.tgz',
        runCommand: async () => {
          calls += 1
          return result(0)
        },
      }),
      /must be @tangle-network\/braid/u,
    )
  }
  assert.equal(calls, 0)
})

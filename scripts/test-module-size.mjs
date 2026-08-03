import { deepEqual, equal, match } from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countLines, findModuleSizeViolations, formatModuleSizeFailure } from './module-size.mjs'

equal(countLines(''), 0)
equal(countLines('one line'), 1)
equal(countLines('one line\n'), 1)
equal(countLines('one\r\ntwo\r\n'), 2)

const repository = await mkdtemp(join(tmpdir(), 'braid-module-size-test-'))
try {
  await mkdir(join(repository, 'src'))
  await mkdir(join(repository, 'scripts'))
  await writeFile(join(repository, 'src', 'oversized.ts'), `${'line\n'.repeat(500)}last`)
  await writeFile(join(repository, 'src', 'ignored.mjs'), `${'line\n'.repeat(501)}last`)
  await writeFile(join(repository, 'scripts', 'oversized.mjs'), `${'line\n'.repeat(501)}last`)
  await writeFile(join(repository, 'scripts', 'ignored.ts'), `${'line\n'.repeat(501)}last`)

  const violations = await findModuleSizeViolations({ repository })
  deepEqual(
    violations.map(({ path, lines }) => [path, lines]),
    [
      ['src/oversized.ts', 501],
      ['scripts/oversized.mjs', 502],
    ],
  )
  match(formatModuleSizeFailure(violations), /src\/oversized\.ts: 501 lines \(limit 500\)/u)
  match(formatModuleSizeFailure(violations), /scripts\/oversized\.mjs: 502 lines \(limit 500\)/u)
} finally {
  await rm(repository, { recursive: true, force: true })
}

process.stdout.write('Module-size checker tests passed.\n')

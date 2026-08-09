import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const releaseCatalog = await import('../scripts/release-check-catalog.mjs')
const {
  CHECK_CATEGORIES,
  releaseCheckEntry,
  RELEASE_COMMANDS,
  REQUIRED_CHECKS,
  requiredEvidenceCheckIds,
} = releaseCatalog
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { canonicalJson } = await import('../scripts/release-evidence.mjs')
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const visualCaptureSupport = await import('../scripts/capture-visual-support.mjs')
const { assertFlowFrameIntegrity, captureProvenance } = visualCaptureSupport
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { assertAccessibleTerminalOutput } = await import('../scripts/accessibility-output.mjs')
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { nativeInstallEnvironment } = await import('../scripts/native-install-environment.mjs')
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { prepareEvalCandidate } = await import('../scripts/eval/candidate.mjs')
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const publicationProofSupport = await import('../scripts/release/publication-proof.mjs')
const { applyPublicationProof, createPublicationProof, REQUIRED_RELEASE_TARGETS } =
  publicationProofSupport

const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
)

test('W5 exposes stable checks for every requested release surface', () => {
  const required = [
    'test:unit',
    'test:contract',
    'test:coordination',
    'test:rpc',
    'test:virtual-terminal',
    'test:pty',
    'test:storage',
    'test:crash',
    'test:security',
    'test:performance',
    'test:live',
    'test:install',
    'test:capture',
    'check:release',
  ]
  for (const script of required) assert.equal(typeof packageJson.scripts[script], 'string', script)
})

test('the scoped test runner rejects an unregistered scope instead of silently running the wrong suite', async () => {
  const source = await readFile(new URL('../../scripts/run-tests.mjs', import.meta.url), 'utf8')
  assert.match(source, /No compiled tests registered for scope/u)
  assert.match(source, /scopeFiles/u)
})

test('compiled tests receive the JavaScript helpers imported from scripts', async () => {
  const source = await readFile(new URL('../../scripts/clean-tests.mjs', import.meta.url), 'utf8')
  assert.match(source, /\.test-dist\/scripts/u)
  assert.match(source, /entry\.name\.endsWith\('\.mjs'\)/u)
})

test('clean package installs cannot inherit disabled native dependency builds', () => {
  const environment = nativeInstallEnvironment({
    NPM_CONFIG_IGNORE_SCRIPTS: 'true',
    npm_config_ignore_scripts: 'true',
    KEEP_ME: 'yes',
  })
  assert.equal(environment.npm_config_ignore_scripts, 'false')
  assert.equal(environment.NPM_CONFIG_IGNORE_SCRIPTS, undefined)
  assert.equal(environment.KEEP_ME, 'yes')
})

test('every scoped package alias forwards its declared file set', () => {
  assert.equal(packageJson.scripts.test, 'node scripts/test.mjs')
  const aliases = {
    'test:unit': [
      'application.test.js',
      'cli-startup.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'domain-ids.test.js',
      'domain-invariants.test.js',
      'domain-reducer.test.js',
      'domain-text.test.js',
      'eval.test.js',
      'reducer.test.js',
      'sanitize.test.js',
      'scripts.test.js',
      'w6-ui.test.js',
    ],
    'test:contract': [
      'application.test.js',
      'cli-bridge-profile-contract.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'domain-invariants.test.js',
      'domain-reducer.test.js',
      'reducer.test.js',
      'scripts.test.js',
      'w6-contract.test.js',
    ],
    'test:coordination': [
      'analysis-durable.test.js',
      'coordination.test.js',
      'effect-admission.test.js',
      'run-admission-architecture.test.js',
    ],
    'test:rpc': ['profile-connection-actions.test.js', 'rpc.test.js', 'w6-contract.test.js'],
    'test:virtual-terminal': [
      'configuration-product-flow.test.js',
      'keyboard.test.js',
      'terminal-responsive.test.js',
      'tui-autocomplete.test.js',
      'tui-conversations.test.js',
      'tui-core-workflows.test.js',
      'tui.test.js',
      'w6-ui.test.js',
    ],
    'test:storage': [
      'conversation-storage.test.js',
      'coordination.test.js',
      'domain-reducer.test.js',
      'effect-admission.test.js',
      'storage-crash.test.js',
      'storage-snapshots.test.js',
      'storage.test.js',
    ],
    'test:crash': [
      'conversation-storage.test.js',
      'profile-save-recovery.test.js',
      'storage-crash.test.js',
      'storage.test.js',
    ],
    'test:security': [
      'cli-startup.test.js',
      'configuration-product-flow.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'profile-connection-actions.test.js',
      'profile-save-recovery.test.js',
      'sanitize.test.js',
      'security.test.js',
      'storage-snapshots.test.js',
      'storage.test.js',
      'tui-core-workflows.test.js',
      'w6-contract.test.js',
    ],
    'test:performance': [
      'coordination.test.js',
      'performance.test.js',
      'reducer.test.js',
      'storage-performance.test.js',
    ],
  }
  const criticalRegressionFiles = [
    'analysis-durable.test.js',
    'cli-bridge-profile-contract.test.js',
    'cli-startup.test.js',
    'configuration-product-flow.test.js',
    'profile-connection-actions.test.js',
    'profile-save-recovery.test.js',
    'run-admission-architecture.test.js',
    'storage-snapshots.test.js',
    'terminal-responsive.test.js',
    'tui-autocomplete.test.js',
    'tui-conversations.test.js',
    'tui-core-workflows.test.js',
  ]
  for (const [alias, expected] of Object.entries(aliases)) {
    assert.deepEqual(expected, [...expected].sort(), `${alias} must stay sorted`)
    assert.equal(new Set(expected).size, expected.length, `${alias} must not contain duplicates`)
  }
  const registeredCriticalFiles = new Set(Object.values(aliases).flat())
  for (const file of criticalRegressionFiles) {
    assert.equal(
      registeredCriticalFiles.has(file),
      true,
      `${file} is missing from every stable scope`,
    )
  }
  for (const [alias, expected] of Object.entries(aliases)) {
    const scope = packageJson.scripts[alias].match(/--scope\s+([a-z-]+)/u)?.[1]
    assert.equal(scope, alias.slice('test:'.length), alias)
    const output = execFileSync(
      process.execPath,
      ['scripts/test.mjs', '--scope', scope, '--list'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.deepEqual(JSON.parse(output), [...expected].sort(), alias)
  }
})

test('the release catalog exactly covers every stable verification command', async () => {
  const verification = await readFile(
    new URL('../../docs/08-verification.md', import.meta.url),
    'utf8',
  )
  const documented = new Map(
    [...verification.matchAll(/^\| `([^`]+)` \| `(pnpm [^`]+)` \|/gmu)].map((match) => [
      match[1],
      match[2],
    ]),
  )
  const catalog = new Map([...RELEASE_COMMANDS].map(([id, value]) => [id, value.command]))
  assert.deepEqual([...catalog], [...documented])
  for (const [id, value] of RELEASE_COMMANDS) {
    assert(CHECK_CATEGORIES.has(value.category), `${id} has an unregistered category`)
    assert(value.command.startsWith('pnpm '), `${id} is not a pnpm command`)
    const script = value.command.slice('pnpm '.length)
    assert.equal(typeof packageJson.scripts[script], 'string', `${id} exposes no ${script}`)
  }
  assert.equal(REQUIRED_CHECKS.has('verify:release'), false)
  assert.equal(releaseCheckEntry('UP-01')?.command, 'pnpm test:contract')
  assert.equal(releaseCheckEntry('UP-08')?.command, 'pnpm test:live:bridge')
  assert.equal(releaseCheckEntry('LIVE-06')?.command, 'pnpm test:live:tangle')
  assert.equal(releaseCheckEntry('PERF-10')?.command, 'pnpm test:performance')
  assert.equal(releaseCheckEntry('EVAL-06')?.command, 'pnpm test:eval')
  const evidenceIds = requiredEvidenceCheckIds(['PR-01', 'UP-01', 'LIVE-06', 'PERF-10', 'EVAL-06'])
  assert.equal(evidenceIds.length, REQUIRED_CHECKS.size + 4)
  assert.equal(evidenceIds.includes('verify:release'), false)
})

test('release signatures use locale-independent canonical key ordering', () => {
  assert.equal(canonicalJson({ z: 1, a: 2, A: 3, aa: 4 }), '{"A":3,"a":2,"aa":4,"z":1}')
  const source = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { canonicalJson } from './scripts/release-evidence.mjs'; process.stdout.write(canonicalJson({z:1,a:2,A:3,aa:4}))",
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  )
  assert.equal(source, '{"A":3,"a":2,"aa":4,"z":1}')
})

test('packed-process proof includes all reference sizes, accessibility flags, and cleanup assertions', async () => {
  const source = await readFile(
    new URL('../../scripts/verify-package.mjs', import.meta.url),
    'utf8',
  )
  for (const dimensions of ['40', '80', '120', '200'])
    assert.match(source, new RegExp(`columns: ${dimensions}`, 'u'))
  assert.match(source, /highContrast: true/u)
  assert.match(source, /reducedMotion: true/u)
  assert.match(source, /packed package contains unexpected/u)
  assert.match(source, /packed binary is not executable/u)
  const rpcPacked = await readFile(
    new URL('../../scripts/test-rpc-packed.mjs', import.meta.url),
    'utf8',
  )
  const deterministicRpc = await readFile(
    new URL('../../scripts/packed-rpc/deterministic.mjs', import.meta.url),
    'utf8',
  )
  assert.match(rpcPacked, /await packed\.cleanup\(\)/u)
  assert.match(deterministicRpc, /await rm\(journalPath/u)
})

test('accessibility proof rejects terminal metadata instead of allowlisting it', () => {
  const proofSource = readFile(new URL('../../scripts/verify-package.mjs', import.meta.url), 'utf8')
  assert.doesNotThrow(() => assertAccessibleTerminalOutput('plain accessibility frame'))
  for (const metadata of [
    '\u001b]0;Braid — /workspace\u0007',
    '\u001b]8;;https://example.com/docs\u001b\\docs\u001b]8;;\u001b\\',
    '\u009d0;Braid — /workspace\u0007',
  ]) {
    assert.throws(() => assertAccessibleTerminalOutput(metadata), /terminal metadata/u)
  }
  return proofSource.then((source) => {
    assert.match(source, /assertAccessibleTerminalOutput\(accessibility\.output\)/u)
    assert.doesNotMatch(source, /OSC_SEQUENCE/u)
  })
})

test('visual capture provenance reports installed renderer versions instead of stale constants', async () => {
  const provenance = await captureProvenance()
  const dependencies = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  )
  assert.equal(
    provenance.renderer.package,
    `@earendil-works/pi-tui@${dependencies.dependencies['@earendil-works/pi-tui']}`,
  )
  assert.equal(provenance.renderer.pty, `node-pty@${dependencies.devDependencies['node-pty']}`)
  assert.equal(
    provenance.renderer.emulator,
    `@xterm/headless@${dependencies.devDependencies['@xterm/headless']}`,
  )
})

test('visual flow integrity rejects the measured corrupted-frame error', () => {
  assert.equal(assertFlowFrameIntegrity('1542 (0.0235294)', 'clean frame'), 0.0235294)
  assert.throws(
    () => assertFlowFrameIntegrity('2827 (0.0431373)', 'corrupted frame'),
    /corrupted frame differs from its source frame/u,
  )
  assert.throws(() => assertFlowFrameIntegrity('', 'missing frame'), /missing metric/u)
})

test('semantic evaluation preserves an explicitly pinned installed candidate', async () => {
  const environment = {
    BRAID_EVAL_PACKAGE_ROOT: '/candidate/package',
    BRAID_EVAL_TARBALL_PATH: '/candidate/braid.tgz',
  }
  const candidate = await prepareEvalCandidate('/repository-not-used', environment)
  assert.equal(candidate.generated, false)
  assert.equal(candidate.environment, environment)
  await candidate.cleanup()
})

test('protected live and semantic checks stay unavailable instead of becoming local passes', () => {
  for (const scope of [
    'live-bridge',
    'live-tangle',
    'live-supervisor',
    'live-analysis',
    'semantic-eval',
  ]) {
    let output = ''
    try {
      execFileSync(process.execPath, ['scripts/live-required.mjs', scope], {
        cwd: process.cwd(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      assert.fail(`${scope} unexpectedly succeeded without protected credentials`)
    } catch (error) {
      const result = error as {
        readonly stdout?: string
        readonly stderr?: string
        readonly status?: number
      }
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      assert.equal(result.status, 2, `${scope} returned an untyped failure`)
    }
    assert.match(output, /requires protected live-provider credentials/u)
    assert.doesNotMatch(output, /pass(?:ed)?|success/iu)
  }
})

test('the final release proof requires matching candidate and registry smokes on every platform', async () => {
  const artifactRoot = await mkdtemp(join(tmpdir(), 'braid-publication-proof-'))
  const packageProof = {
    version: '0.1.0',
    gitCommit: 'a'.repeat(40),
    tarball: 'tangle-network-braid-0.1.0.tgz',
    sha256: 'b'.repeat(64),
  }
  const completedAt = '2026-08-09T01:00:00.000Z'
  try {
    for (const phase of ['candidate', 'registry']) {
      const directory = join(artifactRoot, 'publication', phase)
      await mkdir(directory, { recursive: true })
      for (const target of REQUIRED_RELEASE_TARGETS) {
        const record = {
          schema: 'braid.package-smoke.v1',
          platform: target.platform,
          architecture: target.architecture,
          node: 'v22.19.0',
          package: '@tangle-network/braid@0.1.0',
          tarball: packageProof.tarball,
          tarballSha256: packageProof.sha256,
          source: phase,
          installationRoot: '<temporary>/install/node_modules/@tangle-network',
          plainFlow: true,
          encryptedStorage: true,
          temporaryStateRemoved: true,
          completedAt: '2026-08-09T00:30:00.000Z',
        }
        await writeFile(join(directory, `${target.id}.json`), `${JSON.stringify(record)}\n`)
      }
    }
    const proof = await createPublicationProof({ artifactRoot, packageProof, completedAt })
    await writeFile(
      join(artifactRoot, 'publication', 'proof.json'),
      `${JSON.stringify(proof, null, 2)}\n`,
    )
    const evidence = {
      schemaVersion: 1,
      braidVersion: packageProof.version,
      gitCommit: packageProof.gitCommit,
      packageIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      startedAt: '2026-08-09T00:00:00.000Z',
      finishedAt: '2026-08-09T00:20:00.000Z',
      sourceState: {
        clean: true,
        commit: packageProof.gitCommit,
        treeSha256: 'c'.repeat(40),
        tarballSha256: packageProof.sha256,
        tarballArtifactId: 'package-tarball',
      },
      dependencies: [],
      environments: [],
      checks: [],
      requirements: {
        'VR-10': { checks: ['install'], artifacts: ['package-tarball'] },
      },
      artifacts: [
        {
          id: 'package-tarball',
          path: `candidate/${packageProof.tarball}`,
          sha256: packageProof.sha256,
          mediaType: 'application/gzip',
        },
      ],
      liveResources: [],
      cleanup: [],
      signatures: [],
    }
    const augmented = await applyPublicationProof({ evidence, artifactRoot, packageProof })
    assert.equal(augmented.evidence.finishedAt, completedAt)
    assert.equal(augmented.evidence.requirements['VR-10'].artifacts.length, 8)
    assert.equal(augmented.evidence.artifacts.length, 8)

    const registryPath = join(artifactRoot, 'publication', 'registry', 'linux-x64.json')
    const mismatched = JSON.parse(await readFile(registryPath, 'utf8'))
    mismatched.tarballSha256 = 'd'.repeat(64)
    await writeFile(registryPath, `${JSON.stringify(mismatched)}\n`)
    await assert.rejects(
      createPublicationProof({ artifactRoot, packageProof, completedAt }),
      /archive digest differs/u,
    )
  } finally {
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

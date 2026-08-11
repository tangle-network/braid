import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const releaseCatalog = await import('../scripts/release-check-catalog.mjs')
const {
  CHECK_CATEGORIES,
  LIVE_BRIDGE_RELEASE_PROOFS,
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
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { validateIndependentReview } = await import('../scripts/release/independent-review.mjs')
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const platformSupport = await import('../scripts/release/platform.mjs')
const { npmInvocation, pnpmInvocation, portableEvidencePath } = platformSupport
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const upstreamSupport = await import('../scripts/release/upstream-evidence.mjs')
const { evaluateUpstreamRequirementChecks, UPSTREAM_REQUIREMENT_OWNERS } = upstreamSupport
// @ts-expect-error The release scripts are intentionally JavaScript entry points.
const { renderVerificationReport } = await import('../scripts/release/verification-report.mjs')

const packageJson = JSON.parse(
  await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
)
const requirementBindings = JSON.parse(
  await readFile(new URL('../../release/requirement-bindings.json', import.meta.url), 'utf8'),
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
    'test:independent-review',
    'check:release',
  ]
  for (const script of required) assert.equal(typeof packageJson.scripts[script], 'string', script)
})

test('the scoped test runner rejects an unregistered scope instead of silently running the wrong suite', async () => {
  const source = await readFile(new URL('../../scripts/run-tests.mjs', import.meta.url), 'utf8')
  assert.match(source, /No compiled tests registered for scope/u)
  assert.match(source, /scopeFiles/u)
  assert.match(
    source,
    /isolatedPerformanceFiles = new Set\(\['performance\.test\.js', 'storage-performance\.test\.js'\]\)/u,
  )
  assert.match(source, /runTestBatch\(\[path\]\)/u)
})

test('compiled tests receive the JavaScript helpers imported from scripts', async () => {
  const source = await readFile(new URL('../../scripts/clean-tests.mjs', import.meta.url), 'utf8')
  assert.match(source, /configuredTestDist/u)
  assert.match(source, /join\(testDist, 'scripts'\)/u)
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
      'agent-interface-runtime-parity.test.js',
      'analysis-model-call-observability.test.js',
      'analysis-model-call-roundtrip.test.js',
      'application.test.js',
      'cli-startup.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'domain-ids.test.js',
      'domain-invariants.test.js',
      'domain-reducer.test.js',
      'domain-text.test.js',
      'eval.test.js',
      'observability.test.js',
      'plain-accessibility.test.js',
      'property.test.js',
      'reducer.test.js',
      'sanitize.test.js',
      'scripts.test.js',
      'terminal-usage-status.test.js',
      'usage-projection.test.js',
      'w6-ui.test.js',
    ],
    'test:contract': [
      'agent-interface-runtime-parity.test.js',
      'analysis-model-call-observability.test.js',
      'analysis-model-call-roundtrip.test.js',
      'application.test.js',
      'cli-bridge-profile-contract.test.js',
      'cli-bridge-retained-restart.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'domain-invariants.test.js',
      'domain-reducer.test.js',
      'observability.test.js',
      'reducer.test.js',
      'scripts.test.js',
      'usage-projection.test.js',
      'w6-contract.test.js',
    ],
    'test:coordination': [
      'analysis-durable.test.js',
      'cli-bridge-retained-restart.test.js',
      'coordination.test.js',
      'effect-admission.test.js',
      'run-admission-architecture.test.js',
    ],
    'test:rpc': [
      'automation-interaction-commands.test.js',
      'profile-connection-actions.test.js',
      'rpc.test.js',
      'w6-contract.test.js',
    ],
    'test:virtual-terminal': [
      'activity-document.test.js',
      'configuration-product-flow.test.js',
      'intelligence-dispatch.test.js',
      'keyboard.test.js',
      'terminal-responsive.test.js',
      'terminal-usage-status.test.js',
      'tui-autocomplete.test.js',
      'tui-conversations.test.js',
      'tui-core-workflows.test.js',
      'tui-interaction-security.test.js',
      'tui-refresh-lifecycle.test.js',
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
      'cli-bridge-retained-restart.test.js',
      'conversation-storage.test.js',
      'profile-save-recovery.test.js',
      'storage-crash.test.js',
      'storage.test.js',
    ],
    'test:security': [
      'analysis-model-call-observability.test.js',
      'analysis-model-call-roundtrip.test.js',
      'cli-startup.test.js',
      'configuration-product-flow.test.js',
      'conversations.test.js',
      'coordination.test.js',
      'observability.test.js',
      'plain-accessibility.test.js',
      'profile-connection-actions.test.js',
      'profile-save-recovery.test.js',
      'sanitize.test.js',
      'security.test.js',
      'storage-snapshots.test.js',
      'storage.test.js',
      'tui-core-workflows.test.js',
      'tui-interaction-security.test.js',
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
    'agent-interface-runtime-parity.test.js',
    'analysis-durable.test.js',
    'analysis-model-call-observability.test.js',
    'analysis-model-call-roundtrip.test.js',
    'automation-interaction-commands.test.js',
    'cli-bridge-profile-contract.test.js',
    'cli-bridge-retained-restart.test.js',
    'cli-startup.test.js',
    'configuration-product-flow.test.js',
    'observability.test.js',
    'plain-accessibility.test.js',
    'profile-connection-actions.test.js',
    'profile-save-recovery.test.js',
    'run-admission-architecture.test.js',
    'storage-snapshots.test.js',
    'terminal-responsive.test.js',
    'terminal-usage-status.test.js',
    'tui-autocomplete.test.js',
    'tui-conversations.test.js',
    'tui-core-workflows.test.js',
    'tui-interaction-security.test.js',
    'usage-projection.test.js',
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
  assert.equal(releaseCheckEntry('UP-01')?.command, 'pnpm test:upstream')
  assert.equal(releaseCheckEntry('UP-08')?.command, 'pnpm test:upstream')
  assert.equal(releaseCheckEntry('LIVE-06')?.command, 'pnpm test:live:tangle')
  assert.equal(releaseCheckEntry('PERF-10')?.command, 'pnpm test:performance')
  assert.equal(releaseCheckEntry('EVAL-06')?.command, 'pnpm test:eval')
  assert.equal(releaseCheckEntry('VR-03')?.command, 'pnpm test:property:soak')
  const evidenceIds = requiredEvidenceCheckIds([
    'PR-01',
    'UP-01',
    'LIVE-06',
    'PERF-10',
    'EVAL-06',
    'VR-03',
  ])
  assert.equal(evidenceIds.length, REQUIRED_CHECKS.size + 5)
  assert.equal(evidenceIds.includes('verify:release'), false)
})

test('LIVE-01 through LIVE-05 retain distinct strict proof bindings', () => {
  const ids = ['LIVE-01', 'LIVE-02', 'LIVE-03', 'LIVE-04', 'LIVE-05']
  const proofs = ids.map((id) => LIVE_BRIDGE_RELEASE_PROOFS[id])
  assert(proofs.every((proof) => proof !== undefined))
  assert.equal(new Set(proofs.map((proof) => proof.operation)).size, ids.length)
  assert.deepEqual(
    proofs.map((proof) => proof.target.mode),
    [
      'harness',
      'harness',
      'one-advertised-runner',
      'one-advertised-runner',
      'all-advertised-runners',
    ],
  )
  for (const id of ids) {
    assert.equal(releaseCheckEntry(id)?.command, 'pnpm test:live:bridge:release')
    assert.deepEqual(requirementBindings[id]?.checks, [id])
  }
})

test('release subprocesses and recorded paths are portable to Windows', async () => {
  assert.deepEqual(npmInvocation(['install'], { platform: 'linux' }), {
    file: 'npm',
    args: ['install'],
  })
  assert.deepEqual(
    npmInvocation(['install'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
    }),
    {
      file: 'C:\\node\\node.exe',
      args: ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'install'],
    },
  )
  assert.deepEqual(
    pnpmInvocation(['pack'], {
      platform: 'win32',
      execPath: 'C:\\node\\node.exe',
      environment: { npm_execpath: 'C:\\pnpm\\pnpm.mjs' },
    }),
    {
      file: 'C:\\node\\node.exe',
      args: ['C:\\pnpm\\pnpm.mjs', 'pack'],
    },
  )
  assert.throws(
    () =>
      pnpmInvocation(['pack'], {
        platform: 'win32',
        execPath: 'C:\\node\\node.exe',
        environment: {},
      }),
    /pnpm JavaScript entry point/u,
  )
  assert.equal(
    portableEvidencePath('<temporary>\\install\\node_modules\\@tangle-network'),
    '<temporary>/install/node_modules/@tangle-network',
  )
  const candidatePreparation = await readFile(
    new URL('../../scripts/release/prepare-candidate.mjs', import.meta.url),
    'utf8',
  )
  assert.match(candidatePreparation, /pnpmInvocation\(\['run', 'build'\]\)/u)
  assert.doesNotMatch(candidatePreparation, /run\('pnpm'/u)
})

test('upstream requirements require successful owning-repository checks', () => {
  type Owner = { readonly package: string; readonly check: string }
  type Artifact = {
    readonly name: string
    readonly digest: string
    readonly expired: boolean
    readonly archiveDownloadUrl: string
  }
  type Check = {
    readonly name: string
    readonly headSha: string
    readonly status: string
    readonly conclusion: string
    readonly app: string
    readonly detailsUrl: string
    readonly completedAt: string
    readonly artifacts: readonly Artifact[]
  }
  type PackageRecord = {
    readonly package: string
    readonly version: string
    readonly repository: string
    readonly tag: string
    readonly gitCommit: string
    checks: Check[]
  }
  const owners = UPSTREAM_REQUIREMENT_OWNERS as Readonly<Record<string, readonly Owner[]>>
  const repositories: Readonly<Record<string, string>> = {
    '@tangle-network/agent-interface': 'tangle-network/agent-sdk',
    '@tangle-network/agent-runtime': 'tangle-network/agent-runtime',
    '@tangle-network/agent-provider-cli-bridge': 'tangle-network/agent-sdk',
    '@tangle-network/agent-provider-tangle': 'tangle-network/agent-sdk',
  }
  const commit = 'a'.repeat(40)
  const packages = Object.fromEntries(
    [
      ...new Set(
        Object.values(owners)
          .flat()
          .map((owner) => owner.package),
      ),
    ].map((name) => {
      const repository = repositories[name] ?? assert.fail(`Missing repository for ${name}`)
      const requirementIds = Object.entries(owners)
        .filter(([, requirementOwners]) =>
          requirementOwners.some((owner) => owner.package === name),
        )
        .map(([requirementId]) => requirementId)
      return [
        name,
        {
          package: name,
          version: '1.2.3',
          repository,
          tag: `${name}@1.2.3`,
          gitCommit: commit,
          checks: requirementIds.map((requirementId, index) => ({
            name: requirementId,
            headSha: commit,
            status: 'completed',
            conclusion: 'success',
            app: 'github-actions',
            detailsUrl: `https://github.com/${repository}/actions/runs/${index + 1}/job/1`,
            completedAt: `2026-08-09T00:00:${String(index).padStart(2, '0')}.000Z`,
            artifacts: [
              {
                name: `upstream-attestation-${requirementId}`,
                digest: `sha256:${'b'.repeat(64)}`,
                expired: false,
                archiveDownloadUrl: `${'https://api.github.com/repos'}/${repository}/actions/artifacts/${index + 1}/zip`,
              },
            ],
          })),
        },
      ]
    }),
  ) as Record<string, PackageRecord>
  const complete = evaluateUpstreamRequirementChecks(packages)
  assert.equal(complete.failures.length, 0)
  assert.deepEqual(
    complete.measurements.map(({ name }: { readonly name: string }) => name),
    Object.keys(owners),
  )

  const tanglePackage = packages['@tangle-network/agent-provider-tangle']
  assert(tanglePackage)
  tanglePackage.checks = tanglePackage.checks.filter(({ name }: Check) => name !== 'UP-09')
  const missing = evaluateUpstreamRequirementChecks(packages)
  assert(missing.failures.some((failure: string) => /UP-09.*UP-09/u.test(failure)))
  assert.equal(missing.measurements.length, 0)
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

test('release report counts each real result instead of treating captured rows as passed', () => {
  const checks = ['passed', 'failed', 'unavailable', 'uncaptured', 'future-result'].map(
    (result, index) => ({
      id: `check-${index + 1}`,
      result,
      category: 'unit',
      command: 'pnpm test:unit',
      environment: 'linux-x64',
      durationMs: index + 1,
    }),
  )
  const report = renderVerificationReport({
    braidVersion: '0.1.0',
    gitCommit: 'a'.repeat(40),
    packageIntegrity: 'sha512-example',
    checks,
    requirements: {
      'PR-01': { checks: ['check-1'], artifacts: ['artifact-1'] },
      'PR-02': { checks: [], artifacts: [] },
      'PR-03': { checks: ['check-2'], artifacts: ['artifact-1'] },
    },
    artifacts: [{ id: 'artifact-1' }],
  })
  assert.match(
    report,
    /Checks: 1\/5 passed; 1 failed; 1 unavailable; 1 uncaptured; 1 unrecognized\./u,
  )
  assert.match(report, /Requirements: 1\/3 backed by passed checks and present artifacts\./u)
  assert.match(report, /\| `check-2` \| failed \| unit \|/u)
  assert.doesNotMatch(report, /Checks: 5\/5 passed/u)
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

test('package parity normalizes generated identity but rejects changed references', () => {
  const output = execFileSync(
    process.execPath,
    ['scripts/verify-package.mjs', '--parity-self-test'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  )
  assert.match(output, /package parity self-test passed/u)
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
    assert.match(output, /requires protected live-provider credentials|live check requires/u)
    assert.doesNotMatch(output, /pass(?:ed)?|success/iu)
  }
})

test('release keys stay isolated and provider credentials are step-scoped', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8')
  const candidate = workflow.slice(
    workflow.indexOf('  candidate:'),
    workflow.indexOf('  endorse-candidate:'),
  )
  assert.doesNotMatch(candidate, /BRAID_RELEASE_SIGNING_KEY/u)
  const releaseCheckMarker = '      - name: Run the complete release checks'
  const releaseCheckStart = candidate.indexOf(releaseCheckMarker)
  assert.notEqual(releaseCheckStart, -1)
  const releaseCheckEnd = candidate.indexOf(
    '\n      - name:',
    releaseCheckStart + releaseCheckMarker.length,
  )
  assert.notEqual(releaseCheckEnd, -1)
  const releaseCheckStep = candidate.slice(releaseCheckStart, releaseCheckEnd)
  const otherCandidateSteps = `${candidate.slice(0, releaseCheckStart)}${candidate.slice(releaseCheckEnd)}`
  for (const [start, end] of [
    ['  endorse-candidate:', '  platform-smoke:'],
    ['  endorse-final:', '  tag-and-report:'],
  ] as const) {
    const job = workflow.slice(workflow.indexOf(start), workflow.indexOf(end))
    assert.match(job, /BRAID_RELEASE_SIGNING_KEY_BASE64/u)
    assert.doesNotMatch(job, /actions\/checkout|\b(?:node|npm|pnpm)\b|scripts\//u)
  }
  assert.equal(workflow.match(/BRAID_RELEASE_SIGNING_KEY_BASE64/gu)?.length, 2)
  for (const name of [
    'BRAID_CLI_BRIDGE_BEARER',
    'BRAID_CLI_BRIDGE_URL',
    'BRAID_EVAL_API_KEY',
    'BRAID_EVAL_BASE_URL',
    'BRAID_EVAL_MODEL',
    'BRAID_TANGLE_API_KEY',
    'BRAID_TANGLE_ENDPOINT',
    'BRAID_TANGLE_MODEL',
    'BRAID_TANGLE_PROVIDER',
    'BRAID_TANGLE_RUNNER',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_TANGLE_SANDBOX_ENDPOINT',
    'BRAID_TANGLE_SANDBOX_MODEL',
    'BRAID_TANGLE_SANDBOX_PROVIDER',
    'BRAID_TANGLE_SANDBOX_RUNNER',
    'BRAID_ANALYSIS_API_KEY',
    'BRAID_ANALYSIS_ENDPOINT',
    'BRAID_ANALYSIS_MODEL',
    'BRAID_ANALYSIS_PROVIDER',
    'BRAID_ANALYSIS_RUNNER',
    'BRAID_SUPERVISOR_ID',
    'BRAID_SUPERVISOR_MESSAGE',
    'BRAID_SUPERVISOR_ROOT',
    'BRAID_SUPERVISOR_WORKER',
  ]) {
    const declaration = new RegExp(`^\\s+${name}:`, 'gmu')
    assert.equal(releaseCheckStep.match(declaration)?.length, 1, name)
    assert.doesNotMatch(otherCandidateSteps, declaration, name)
  }
  for (const name of [
    'BRAID_TANGLE_API_KEY',
    'BRAID_TANGLE_SANDBOX_API_KEY',
    'BRAID_ANALYSIS_API_KEY',
  ]) {
    assert.ok(releaseCheckStep.includes(`${name}: ${'$'}{{ secrets.${name} }}`))
  }
})

test('independent review approval is signed and bound to the exact candidate', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const packageProof = {
    gitCommit: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    packageFileManifest: { digest: 'c'.repeat(64) },
  }
  const unsigned = {
    schema: 'braid.independent-review.v1',
    reviewer: { id: 'reviewer-1', system: 'independent-review-system' },
    candidate: {
      gitCommit: packageProof.gitCommit,
      tarballSha256: packageProof.sha256,
      packageFileManifestDigest: packageProof.packageFileManifest.digest,
    },
    verdict: 'approved',
    reviewedAt: '2026-08-09T01:00:00.000Z',
    threatFixturesReproduced: true,
    architectureOwnershipConfirmed: true,
    findings: [],
  }
  const attestation = {
    ...unsigned,
    signature: {
      algorithm: 'ed25519',
      value: sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString('base64'),
    },
  }
  assert.deepEqual(validateIndependentReview(attestation, { packageProof, publicKey }), unsigned)
  assert.throws(
    () =>
      validateIndependentReview(
        { ...attestation, candidate: { ...attestation.candidate, tarballSha256: 'd'.repeat(64) } },
        { packageProof, publicKey },
      ),
    /archive differs/u,
  )
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
    const candidateDirectory = join(artifactRoot, 'candidate')
    const candidateBytes = Buffer.from('candidate archive bytes')
    await mkdir(candidateDirectory, { recursive: true })
    await writeFile(join(candidateDirectory, packageProof.tarball), candidateBytes)
    const provenancePayload = {
      subject: [
        {
          name: 'pkg:npm/%40tangle-network/braid@0.1.0',
          digest: { sha512: createHash('sha512').update(candidateBytes).digest('hex') },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              ref: 'refs/heads/main',
              repository: 'https://github.com/tangle-network/braid',
              path: '.github/workflows/release.yml',
            },
          },
          resolvedDependencies: [
            {
              uri: 'git+https://github.com/tangle-network/braid@refs/heads/main',
              digest: { gitCommit: packageProof.gitCommit },
            },
          ],
        },
        runDetails: {
          builder: { id: 'https://github.com/actions/runner/github-hosted' },
          metadata: {
            invocationId: 'https://github.com/tangle-network/braid/actions/runs/123/attempts/1',
          },
        },
      },
    }
    await mkdir(join(artifactRoot, 'publication'), { recursive: true })
    await writeFile(
      join(artifactRoot, 'publication', 'npm-audit-signatures.json'),
      `${JSON.stringify({
        invalid: [],
        missing: [],
        verified: [
          {
            name: '@tangle-network/braid',
            version: packageProof.version,
            attestations: { provenance: { predicateType: provenancePayload.predicateType } },
            attestationBundles: [
              {
                predicateType: provenancePayload.predicateType,
                bundle: {
                  dsseEnvelope: {
                    payload: Buffer.from(JSON.stringify(provenancePayload)).toString('base64'),
                  },
                },
              },
            ],
          },
        ],
      })}\n`,
    )
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
    assert.equal(augmented.evidence.requirements['VR-10'].artifacts.length, 9)
    assert.equal(augmented.evidence.artifacts.length, 9)

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

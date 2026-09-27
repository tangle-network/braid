import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP_COMMIT = 'b5cb7bc0ba7ec213c0666cef826d5a797701e5d9'
const APP_RUN = '36294457062'
const APP_SHA256 = '476307aaf09ecca00eb9b8a7e21ccff5b1129bb807b0f3fb0c155d46d7ba096d'
const VERSION = '0.3.2'
const PUBLIC_URL = 'https://registry.npmjs.org/@tangle-network/braid/-/braid-0.3.2.tgz'
const CHECKS = ['live-tangle', 'LIVE-06', 'LIVE-07', 'LIVE-08', 'LIVE-09', 'LIVE-10']
const CONFIGURATION = Object.freeze({
  BRAID_TANGLE_ENDPOINT: 'https://router.tangle.tools/v1',
  BRAID_TANGLE_MODEL: 'glm-5.3',
  BRAID_TANGLE_SANDBOX_ENDPOINT: 'https://sandbox.tangle.tools',
  BRAID_TANGLE_SANDBOX_MODEL: 'tangle-router/glm-5.3',
  BRAID_TANGLE_SANDBOX_RUNNER: 'opencode',
})
const WIRING = new Set([
  'scripts/protected-work.ts',
  'scripts/live-required.mjs',
  'scripts/release/collect-speed-evidence.mjs',
  ...[
    'tangle',
    'tangle-sandbox-braid-soak',
    'tangle-sandbox-braid-stress',
    'tangle-sandbox-braid-multirun',
    'tangle-sandbox-braid-interactive',
    'tangle-sandbox-braid-cloud-interaction',
    'tangle-workspace-proof',
  ].map((name) => `scripts/live-required/${name}.mjs`),
])
const FROZEN_FUNCTIONS = new Set([
  'proofPrompts',
  'promptFor',
  'interactiveProofCommandSequence',
  'proofPrompt',
  'sendSource',
  'sourcePrompt',
  'sandboxConfiguration',
  'configurationEnvironment',
  'workspaceRequestFor',
  'proofFailures',
  'proofPassed',
  'finish',
  'resourceCensusComparison',
  'confidentialRefusalChecks',
  'confidentialNegativeChecks',
  'parseConfidentialTrustPolicy',
])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (repository, ...args) =>
  execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim()
const moduleAt = (repository, path) => import(pathToFileURL(join(repository, path)).href)

function inside(root, path) {
  const child = relative(root, path)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

async function regular(path) {
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink(), `Not a regular file: ${path}`)
  return readFile(path)
}

async function files(root, prefix = '') {
  const records = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    assert(!entry.isSymbolicLink(), 'Signed input contains a symbolic link')
    if (entry.isDirectory()) records.push(...(await files(root, path)))
    else {
      assert(entry.isFile(), 'Signed input contains a non-file entry')
      records.push(path)
    }
  }
  return records.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
}

/** Verify the existing Release endorsement before importing candidate-dependent helpers. */
export async function verifySignedCandidate({
  repository,
  artifactRoot,
  commit,
  version = VERSION,
}) {
  assert(/^[a-f0-9]{40}$/u.test(commit), 'Candidate commit must be a full SHA')
  const root = resolve(artifactRoot)
  assert(!inside(resolve(repository), root), 'Signed inputs must be outside the checkout')
  assert((await realpath(root)) === root, 'Signed input root resolves indirectly')
  const endorsement = join(root, 'endorsement/candidate')
  const key = await regular(join(repository, 'release/endorsement-public-key.pem'))
  assert(key.equals(await regular(join(endorsement, 'public-key.pem'))), 'Endorsement key differs')
  execFileSync('openssl', [
    'pkeyutl',
    '-verify',
    '-rawin',
    '-pubin',
    '-inkey',
    join(repository, 'release/endorsement-public-key.pem'),
    '-in',
    join(endorsement, 'statement.txt'),
    '-sigfile',
    join(endorsement, 'signature.bin'),
  ])
  const names = (await files(root)).filter((path) => !path.startsWith('endorsement/candidate/'))
  const index = Buffer.from(
    (
      await Promise.all(
        names.map(async (path) => `${sha256(await regular(join(root, path)))}  ${path}\n`),
      )
    ).join(''),
  )
  assert(
    index.equals(await regular(join(endorsement, 'files.sha256'))),
    'Signed file index differs',
  )
  const statement = Buffer.from(
    [
      'schema=braid.release-endorsement.v1',
      'phase=candidate',
      'repository=tangle-network/braid',
      `commit=${commit}`,
      `version=${version}`,
      `index_sha256=${sha256(index)}`,
      '',
    ].join('\n'),
  )
  assert(
    statement.equals(await regular(join(endorsement, 'statement.txt'))),
    'Endorsement statement differs',
  )
  return {
    commit,
    indexSha256: sha256(index),
    statementSha256: sha256(statement),
    files: names.length,
  }
}

/** Bind both the compiled private inputs and their actual restored outputs. */
export async function verifyProofSidecar({ repository, artifactRoot, commit }) {
  const root = join(artifactRoot, 'proof-tools')
  const pointer = JSON.parse(await regular(join(root, 'current.json')))
  assert(/^[a-f0-9]{64}$/u.test(pointer.generation), 'Invalid sidecar generation')
  const generation = join(root, pointer.generation)
  const bytes = await regular(join(generation, 'manifest.json'))
  assert(sha256(bytes) === pointer.manifestSha256, 'Sidecar manifest digest differs')
  const manifest = JSON.parse(bytes)
  assert(
    manifest.schema === 'braid.proof-tools.v1' && manifest.sourceCommit === commit,
    'Sidecar source differs',
  )
  assert(manifest.entry === 'proof-tools.mjs', 'Sidecar entry differs')
  for (const [records, base] of [
    [manifest.inputs, repository],
    [manifest.outputs, generation],
  ]) {
    assert(Array.isArray(records) && records.length > 0, 'Sidecar records are missing')
    const names = new Set()
    for (const record of records) {
      assert(typeof record.path === 'string' && !names.has(record.path), 'Duplicate sidecar path')
      names.add(record.path)
      const path = resolve(base, record.path)
      assert(
        record.path && !isAbsolute(record.path) && inside(base, path) && path !== base,
        'Sidecar path escapes',
      )
      const value = await regular(path)
      assert(
        value.length === record.size && sha256(value) === record.sha256,
        'Sidecar source/output digest differs',
      )
    }
  }
  const restored = join(repository, '.script-dist')
  if (await lstat(restored).catch(() => undefined)) {
    assert((await realpath(restored)) === restored, 'Restored sidecar resolves indirectly')
    assert.deepEqual(
      await files(restored),
      await files(root),
      'Restored sidecar file inventory differs',
    )
    for (const path of await files(root))
      assert(
        (await regular(join(root, path))).equals(await regular(join(restored, path))),
        'Restored sidecar differs',
      )
  } else await cp(root, restored, { recursive: true, errorOnExist: true, force: false })
  const { prepareProofTools } = await moduleAt(repository, 'scripts/build-proof-tools.mjs')
  const entry = fileURLToPath(await prepareProofTools())
  assert(inside(join(restored, pointer.generation), entry), 'Loader did not use the signed sidecar')
  return {
    sourceCommit: commit,
    manifestSha256: sha256(bytes),
    inputs: manifest.inputs,
    outputs: manifest.outputs,
  }
}

function assertionName(node) {
  const name = node.expression.getText()
  return /^(?:assert(?:\.|[A-Z])|requiredMeasurement|proofFailures|releaseOutcome)/u.test(name)
}

export async function frozenSemantics(app, harness) {
  const require = createRequire(join(harness, 'package.json'))
  const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href)
  const ts = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href)
  const api = new API({ cwd: harness })
  const parsed = new Map()
  const sourceFor = (repository, path) => {
    const file = join(repository, path)
    if (!parsed.has(file)) {
      const snapshot = api.updateSnapshot({ openFiles: [file] })
      const project = snapshot.getDefaultProjectForFile(file)
      assert(project, `Compiler did not load private input: ${path}`)
      const source = project.program.getSourceFile(file)
      assert(
        source && project.program.getSyntacticDiagnostics(file).length === 0,
        `Invalid private input: ${path}`,
      )
      parsed.set(file, { source, project })
    }
    return parsed.get(file)
  }
  try {
    const closure = async (repository) => {
      const paths = new Set()
      const visit = async (path) => {
        if (paths.has(path)) return
        paths.add(path)
        const { source } = sourceFor(repository, path)
        const imports = []
        const scan = (node) => {
          const value =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
                ? node.arguments[0]
                : undefined
          if (value && ts.isStringLiteral(value) && value.text.startsWith('.')) {
            const child = relative(repository, resolve(dirname(join(repository, path)), value.text))
            if (child.startsWith('scripts/') || child.startsWith('src/')) imports.push(child)
          }
          node.forEachChild(scan)
        }
        scan(source)
        for (let child of imports) {
          if (
            child.endsWith('.js') &&
            !(await lstat(join(repository, child)).catch(() => undefined))
          )
            child = child.replace(/\.js$/u, '.ts')
          await visit(child)
        }
      }
      for (const path of [
        'scripts/live-required.mjs',
        'scripts/release/command-runner.mjs',
        'scripts/proof-tools.ts',
        'scripts/build-proof-tools.mjs',
        'release/requirement-bindings.json',
        'package.json',
        'pnpm-lock.yaml',
      ]) {
        if (/\.(?:mjs|ts)$/u.test(path)) await visit(path)
        else paths.add(path)
      }
      return paths
    }
    const tracked = new Set([...(await closure(app)), ...(await closure(harness))])
    const records = []
    for (const path of [...tracked].sort()) {
      if (WIRING.has(path)) continue
      const before = await regular(join(app, path))
      const after = await regular(join(harness, path))
      if (path === 'package.json') {
        const original = JSON.parse(before)
        const current = JSON.parse(after)
        current.version = original.version
        assert.deepEqual(current, original, 'Frozen package manifest differs beyond version')
      } else assert(before.equals(after), `Frozen non-wiring input differs: ${path}`)
      records.push({ path, sha256: sha256(before) })
    }
    for (const path of WIRING) {
      if (!path.startsWith('scripts/live-required/')) continue
      const parse = async (repository) => {
        const { source, project } = sourceFor(repository, path)
        const selected = new Map()
        const calls = []
        const text = (node) => project.emitter.printNode(node, { preserveSourceNewlines: false })
        for (const node of source.statements) {
          if (
            ts.isFunctionDeclaration(node) &&
            node.name &&
            (FROZEN_FUNCTIONS.has(node.name.text) || /^assert/u.test(node.name.text))
          )
            selected.set(node.name.text, text(node))
          if (ts.isVariableStatement(node))
            for (const declaration of node.declarationList.declarations) {
              const name = declaration.name.getText(source)
              if (
                /^(?:DEFAULT_|MAX_|MIN_|.*_CHECKS$|.*_FIELDS$|.*_STATUSES$)/u.test(name) &&
                !/REPOSITORY$/u.test(name)
              )
                selected.set(name, text(declaration))
            }
        }
        const visit = (node) => {
          if (ts.isCallExpression(node) && assertionName(node)) calls.push(text(node))
          if (
            ts.isVariableDeclaration(node) &&
            /^(?:passed|complete)$/u.test(node.name.getText(source))
          )
            calls.push(text(node))
          if (
            ts.isPropertyAssignment(node) &&
            /^(?:passed|exact)$/u.test(node.name.getText(source))
          )
            calls.push(text(node))
          if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            /(?:cleanup\.)?(?:exact|passed)$/u.test(node.left.getText(source))
          )
            calls.push(text(node))
          node.forEachChild(visit)
        }
        visit(source)
        return { selected, calls }
      }
      const [before, after] = await Promise.all([parse(app), parse(harness)])
      for (const [name, text] of before.selected) {
        assert(
          after.selected.get(name) === text,
          `Frozen prompt/config/validator differs: ${path}:${name}`,
        )
        records.push({ path, symbol: name, sha256: sha256(text) })
      }
      const remaining = [...after.calls]
      for (const call of before.calls) {
        const index = remaining.indexOf(call)
        assert(
          index !== -1,
          `Frozen validation call removed or changed: ${path}: ${call.slice(0, 160)}`,
        )
        remaining.splice(index, 1)
        records.push({ path, validationCallSha256: sha256(call) })
      }
    }
    const { canonicalJson } = await moduleAt(app, 'scripts/release-evidence.mjs')
    return {
      sha256: sha256(canonicalJson(records)),
      count: records.length,
      inputs: records,
      limit:
        'Source-input, validator and call-site equality does not prove control-flow reachability; independent scheduling review and the original canonical row verifier remain required.',
    }
  } finally {
    api.close()
  }
}

function option(name) {
  const index = process.argv.indexOf(name)
  assert(index !== -1 && process.argv[index + 1], `${name} is required`)
  return resolve(process.argv[index + 1])
}

export async function restoreFrozenApplication({ app, harness, tarball, identity }) {
  // The canonical archive reader has already rejected links and unsafe paths.
  if (!(await lstat(join(app, 'dist')).catch(() => undefined)))
    execFileSync('tar', ['-xzf', tarball, '--strip-components=1', '-C', app, 'package/dist'])
  const distEntries = identity.packageFileManifest.entries.filter(({ path }) =>
    path.startsWith('package/dist/'),
  )
  assert(
    (await files(join(app, 'dist'))).length === distEntries.length,
    'Restored public dist inventory differs',
  )
  for (const entry of distEntries)
    assert(
      sha256(await regular(join(app, entry.path.slice('package/'.length)))) === entry.sha256,
      'Restored public dist differs',
    )
  if (!(await lstat(join(app, 'node_modules')).catch(() => undefined)))
    await symlink(join(harness, 'node_modules'), join(app, 'node_modules'), 'dir')
  assert(
    (await realpath(join(app, 'node_modules'))) === (await realpath(join(harness, 'node_modules'))),
    'Frozen source dependency installation differs',
  )
  return {
    restoredDistFiles: distEntries.length,
    rebuilt: false,
    dependencyRoot: await realpath(join(app, 'node_modules')),
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const app = option('--app-checkout')
  const harness = option('--harness-checkout')
  const appRoot = option('--app-candidate')
  const harnessRoot = option('--harness-candidate')
  const output = option('--artifact-root')
  const harnessCommit = git(harness, 'rev-parse', 'HEAD')
  assert(
    process.env.GITHUB_SHA === harnessCommit,
    'Harness HEAD differs from the actual workflow SHA',
  )
  assert(
    process.env.GITHUB_ACTIONS === 'true' && /^\d+$/u.test(process.env.GITHUB_RUN_ID ?? ''),
    'Protected speed collection requires a real GitHub Actions run',
  )
  assert(
    /^\d+$/u.test(process.env.BRAID_SPEED_HARNESS_RUN_ID ?? ''),
    'Signed harness candidate workflow ID is required',
  )
  assert(git(app, 'rev-parse', 'HEAD') === APP_COMMIT, 'Frozen app commit differs')
  assert(
    fileURLToPath(import.meta.url) === join(harness, 'scripts/release/collect-speed-evidence.mjs'),
    'Wrapper is outside the verified harness',
  )
  for (const repository of [app, harness]) {
    assert(
      git(repository, 'status', '--porcelain=v1', '--untracked-files=all') === '',
      'Speed source checkout is not clean',
    )
    assert(
      !inside(repository, output) &&
        !inside(repository, appRoot) &&
        !inside(repository, harnessRoot),
      'Artifact roots must be outside both checkouts',
    )
  }
  assert(
    appRoot !== harnessRoot && output !== appRoot && output !== harnessRoot,
    'Artifact identities must use distinct roots',
  )
  for (const left of [appRoot, harnessRoot, output])
    for (const right of [appRoot, harnessRoot, output])
      if (left !== right) assert(!inside(left, right), 'Artifact roots overlap')
  const appSignature = await verifySignedCandidate({
    repository: app,
    artifactRoot: appRoot,
    commit: APP_COMMIT,
  })
  const harnessVersion = JSON.parse(await regular(join(harness, 'package.json'))).version
  const harnessSignature = await verifySignedCandidate({
    repository: harness,
    artifactRoot: harnessRoot,
    commit: harnessCommit,
    version: harnessVersion,
  })
  const { readCandidateIdentity } = await moduleAt(app, 'scripts/release/build-identity.mjs')
  const application = await readCandidateIdentity({
    repository: app,
    artifactRoot: appRoot,
    expectedCommit: APP_COMMIT,
    expectedVersion: VERSION,
  })
  const execution = await readCandidateIdentity({
    repository: harness,
    artifactRoot: harnessRoot,
    expectedCommit: harnessCommit,
    expectedVersion: harnessVersion,
  })
  assert(
    application.identity.tarballSha256 === APP_SHA256,
    'Field archive differs from frozen public bytes',
  )
  assert(
    (await regular(join(app, 'pnpm-lock.yaml'))).equals(
      await regular(join(harness, 'pnpm-lock.yaml')),
    ),
    'Frozen dependency lockfile differs',
  )
  const semantics = await frozenSemantics(app, harness)
  const appSidecar = await verifyProofSidecar({
    repository: app,
    artifactRoot: appRoot,
    commit: APP_COMMIT,
  })
  const harnessSidecar = await verifyProofSidecar({
    repository: harness,
    artifactRoot: harnessRoot,
    commit: harnessCommit,
  })
  const response = await fetch(PUBLIC_URL, { signal: AbortSignal.timeout(30_000) })
  assert(response.status === 200, 'Frozen public archive is unavailable')
  const publicBytes = Buffer.from(await response.arrayBuffer())
  assert(sha256(publicBytes) === APP_SHA256, 'Public archive differs from the signed app candidate')
  const tarball = join(appRoot, application.identity.tarballPath)
  assert(publicBytes.equals(await regular(tarball)), 'Public and signed archive bytes differ')
  const restoredApplication = await restoreFrozenApplication({
    app,
    harness,
    tarball,
    identity: application.identity,
  })
  if (!(await lstat(output).catch(() => undefined))) {
    await mkdir(output, { recursive: false })
    await cp(appRoot, output, { recursive: true, errorOnExist: true, force: false })
  }
  const restoredIdentity = await readCandidateIdentity({
    repository: app,
    artifactRoot: output,
    expectedCommit: APP_COMMIT,
    expectedVersion: VERSION,
  })
  assert(restoredIdentity.identity.tarballSha256 === APP_SHA256, 'Collection app archive differs')
  const receipt = {
    schema: 'braid.protected-speed-identity.v1',
    startedAt,
    workflowRunId: process.env.GITHUB_RUN_ID,
    workflowSha: process.env.GITHUB_SHA,
    app: {
      commit: APP_COMMIT,
      version: VERSION,
      candidateRunId: APP_RUN,
      publicUrl: PUBLIC_URL,
      identity: application.identity,
      signature: appSignature,
      sidecar: appSidecar,
    },
    harness: {
      commit: harnessCommit,
      version: harnessVersion,
      candidateRunId: process.env.BRAID_SPEED_HARNESS_RUN_ID,
      identity: execution.identity,
      sourceDigest: execution.packageProof.sourceDigest,
      signature: harnessSignature,
      sidecar: harnessSidecar,
    },
    frozenSemantics: semantics,
    restoredApplication,
    applicationArchiveUsedForField: APP_SHA256,
    harnessApplicationArchiveUsedForField: false,
    sourceOverlayUsed: false,
    actualCommandCheckout: harness,
    trustedApplicationCheckout: app,
    flag: process.env.BRAID_PROTECTED_OVERLAP ?? 'off',
    rollout: process.env.BRAID_PROTECTED_ROLLOUT ?? 'internal',
    result: 'identity-preflight-passed',
  }
  await mkdir(join(output, 'speed'), { recursive: true })
  await writeFile(join(output, 'speed/identity.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  if (process.argv.includes('--preflight')) {
    process.stdout.write(
      `Dual identity preflight passed: app ${APP_COMMIT} ${APP_SHA256}; harness ${harnessCommit}.\n`,
    )
    return
  }
  let protectedEnvironment
  try {
    protectedEnvironment = JSON.parse(process.env.BRAID_LIVE_TANGLE_ENV_JSON ?? 'null')
  } catch {
    throw new Error('Protected live environment is not valid JSON')
  }
  assert(
    protectedEnvironment &&
      typeof protectedEnvironment === 'object' &&
      !Array.isArray(protectedEnvironment),
    'Protected live environment must be an object',
  )
  for (const [name, value] of Object.entries(protectedEnvironment)) {
    assert(
      /^[A-Z][A-Z0-9_]*$/u.test(name) && typeof value === 'string',
      'Invalid protected environment field',
    )
    assert(
      !/^(?:BASH_ENV|ENV|LD_PRELOAD|NODE_OPTIONS|NODE_PATH|GITHUB_.*|BRAID_RELEASE_.*|BRAID_LIVE_(?:BINARY|PACKAGE_ROOT|TARBALL_SHA256))$/u.test(
        name,
      ),
      'Protected environment cannot override execution identity',
    )
  }
  const environment = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !/^(?:BRAID_(?:LIVE_)?TANGLE|TANGLE_)/u.test(name),
      ),
    ),
    ...protectedEnvironment,
    BRAID_RELEASE_CHECKOUT: app,
    BRAID_PROTECTED_OVERLAP: receipt.flag,
    BRAID_PROTECTED_ROLLOUT: receipt.rollout,
    BRAID_PROTECTED_COUNTERS: '1',
  }
  for (const [name, value] of Object.entries(CONFIGURATION))
    assert(protectedEnvironment[name] === value, `Frozen effective configuration differs: ${name}`)
  for (const name of Object.keys(protectedEnvironment))
    assert(
      name in CONFIGURATION ||
        /^BRAID_TANGLE(?:_SANDBOX)?_(?:CREDENTIAL_REF|AUTH|API_KEY|BEARER)$/u.test(name),
      'Protected environment includes an unfrozen override',
    )
  receipt.effectiveConfiguration = CONFIGURATION
  receipt.requiredDefaults = {
    stressRuns: 3,
    stressConcurrency: 2,
    multiRunHoldSeconds: 180,
    stressHoldMs: 30_000,
    caseSandboxCapacity: 4,
    workspaceGitRef: 'main',
    workspaceCommitPinned: false,
  }
  delete environment.BRAID_LIVE_TANGLE_ENV_JSON
  const { collectReleaseEvidence } = await moduleAt(app, 'scripts/release/collector.mjs')
  const { executeCatalogCheck } = await moduleAt(harness, 'scripts/release/command-runner.mjs')
  const bindings = JSON.parse(await regular(join(app, 'release/requirement-bindings.json')))
  for (const path of [
    'release/checks.json',
    'release/checks.partial.json',
    'release/collection-manifest.json',
  ])
    assert(
      !(await lstat(join(output, path)).catch(() => undefined)),
      'Speed wall requires a fresh complete collection, not resume',
    )
  let result
  try {
    result = await collectReleaseEvidence({
      repository: app,
      artifactRoot: output,
      tarballPath: join(output, application.identity.tarballPath),
      packageProofPath: 'w6/package-proof.json',
      requirementBindings: bindings,
      checkIds: CHECKS,
      environment,
      runCheck: (options) => {
        assert(options.checkId === 'live-tangle', 'Unexpected field command')
        return executeCatalogCheck({ ...options, cwd: harness })
      },
    })
    // Run the ORIGINAL application's canonical verifier, without altering GITHUB_SHA.
    execFileSync(process.execPath, [join(app, 'scripts/release/verify-publish-gate.mjs')], {
      cwd: app,
      stdio: 'inherit',
      env: {
        ...process.env,
        BRAID_RELEASE_CHECKOUT: app,
        BRAID_RELEASE_CANDIDATE_ROOT: appRoot,
        BRAID_RELEASE_LIVE_EVIDENCE_ROOT: output,
        BRAID_RELEASE_EXPECT_COMMIT: APP_COMMIT,
        BRAID_RELEASE_EXPECT_VERSION: VERSION,
      },
    })
    receipt.result = result.result
    assert(
      result.result === 'passed' && result.envelope.checks.length === CHECKS.length,
      'Fixed six-row speed gate did not pass',
    )
  } catch (error) {
    receipt.result = 'failed'
    throw error
  } finally {
    receipt.finishedAt = new Date().toISOString()
    receipt.checks =
      result?.envelope.checks.map(({ id, result: status }) => ({ id, result: status })) ?? []
    await writeFile(join(output, 'speed/identity.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    const index = (await files(output)).filter((path) => path !== 'speed/files.sha256')
    await writeFile(
      join(output, 'speed/files.sha256'),
      (
        await Promise.all(
          index.map(async (path) => `${sha256(await regular(join(output, path)))}  ${path}\n`),
        )
      ).join(''),
    )
  }
  process.stdout.write(
    `Frozen app six-row gate passed; separately verified harness ${harnessCommit}; ${Date.now() - Date.parse(startedAt)}ms wrapper wall.\n`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()

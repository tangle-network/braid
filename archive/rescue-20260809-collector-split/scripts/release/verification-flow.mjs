import { validatePerformanceMatrix } from '../release-evidence.mjs'
import { dependencyDigest } from './build-identity.mjs'
import { applyPublicationProof } from './publication-proof.mjs'
import { validateReleaseArtifacts } from './verification-artifacts.mjs'
import { validateReleaseChecks } from './verification-checks.mjs'
import { validateLiveResources, validateRequirementMappings } from './verification-mappings.mjs'
import { readVerificationOptions } from './verification-options.mjs'
import { buildDocumentationPlan, buildEvidencePlan } from './verification-plan.mjs'
import { writeVerificationOutputs } from './verification-report.mjs'
import { assertIsolatedCheckout, loadReleaseSource } from './verification-source.mjs'
import { createGit } from './verification-support.mjs'

export async function verifyRelease(
  options = readVerificationOptions(),
  { publicationRequired = true, writeOutputs = true } = {},
) {
  const documentation = await buildDocumentationPlan(options)
  const git = createGit(options.repository)
  assertIsolatedCheckout({ options, git })
  const loadedSource = await loadReleaseSource({ options, git })
  const publication = publicationRequired
    ? await applyPublicationProof({
        evidence: loadedSource.evidence,
        artifactRoot: options.artifactRoot,
        packageProof: loadedSource.packageProof,
      })
    : undefined
  const source = publication
    ? {
        ...loadedSource,
        evidence: publication.evidence,
        releaseWindow: publication.releaseWindow,
        publicationProof: publication.publicationProof,
      }
    : loadedSource
  const plan = buildEvidencePlan(source.evidence, documentation.requirements)
  const artifactResult = await validateReleaseArtifacts({
    evidence: source.evidence,
    artifactRoot: options.artifactRoot,
    packageProof: source.packageProof,
    packageJson: source.packageJson,
  })
  const environments = new Map(
    source.evidence.environments.map((environment) => [environment.id, environment]),
  )
  const performanceMeasurements = validateReleaseChecks({
    checks: plan.checks,
    artifacts: artifactResult.artifacts,
    mappings: plan.mappings,
    environments,
    allowedCheckIds: plan.allowedCheckIds,
    allowedCommands: plan.allowedCommands,
    packageProof: source.packageProof,
    evidence: source.evidence,
    sourceTree: source.sourceTree,
    releaseWindow: source.releaseWindow,
    dependencyDigest: dependencyDigest(source.evidence.dependencies),
    packageFileManifestDigest: artifactResult.packageFileManifestDigest,
  })
  validatePerformanceMatrix(performanceMeasurements, 'Release performance matrix')
  validateRequirementMappings({
    requirements: documentation.requirements,
    mappings: plan.mappings,
    checks: plan.checks,
    artifacts: artifactResult.artifacts,
    tarballArtifactId: source.evidence.sourceState.tarballArtifactId,
  })
  validateLiveResources({
    evidence: source.evidence,
    environments,
    checks: plan.checks,
    packageJson: source.packageJson,
    dependencies: source.evidence.dependencies,
    releaseWindow: source.releaseWindow,
  })
  const output = writeOutputs
    ? await writeVerificationOutputs({
        options,
        evidence: source.evidence,
        specificationDigests: documentation.specificationDigests,
      })
    : {}
  process.stdout.write(
    publicationRequired
      ? `Validated ${documentation.requirements.size} requirements, ${plan.checks.size} recorded checks, and ${artifactResult.artifacts.size} artifacts for @tangle-network/braid@${source.evidence.braidVersion}\n`
      : `Validated the pre-publication candidate; VR-10 remains pending until three registry package smokes pass.\n`,
  )
  return { ...source, ...artifactResult, ...output }
}

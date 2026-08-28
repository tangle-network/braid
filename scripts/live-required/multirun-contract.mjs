const REQUIRED_PHASES = Object.freeze([
  'account.before',
  'binary.resolve',
  'workspace.prepare',
  'terminal.start',
  'branch-a.send',
  'branch-a.stream',
  'conversation-b.create',
  'branch-b.send',
  'concurrent.stream',
  'focus-a',
  'focus-b',
  'cancel-b',
  'branch-a.complete',
  'remote.status',
  'terminal.first.close',
  'terminal.restart',
  'replay.restart',
  'terminal.restart.close',
  'provider.observe',
])

export const MULTIRUN_PROOF_SCHEMA = 'braid.live-required.multirun.v1'
export { REQUIRED_PHASES as MULTIRUN_REQUIRED_PHASES }
const PROVIDER_IDENTIFIER_KINDS = Object.freeze([
  'provider-environment',
  'provider-session',
  'provider-execution',
  'provider-run',
])

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' && value.length > 0
}

function assertRun(run, index) {
  assert(object(run), `multirun proof run ${index} is missing`)
  assert(text(run.runId), `multirun proof run ${index} has no run id`)
  assert(text(run.conversationId), `multirun proof run ${index} has no conversation id`)
  assert(text(run.branchId), `multirun proof run ${index} has no branch id`)
  assert(
    Number.isInteger(run.eventCount) && run.eventCount > 0,
    `multirun proof run ${index} has no streamed events`,
  )
  assert(run.eventIdsUnique === true, `multirun proof run ${index} has duplicate event identities`)
  assert(text(run.environmentId), `multirun proof run ${index} has no environment id`)
  assert(
    Array.isArray(run.identifiers) &&
      run.identifiers.length === PROVIDER_IDENTIFIER_KINDS.length &&
      run.identifiers.every(
        (identifier, identifierIndex) =>
          object(identifier) &&
          identifier.kind === PROVIDER_IDENTIFIER_KINDS[identifierIndex] &&
          text(identifier.id),
      ),
    `multirun proof run ${index} has incomplete provider identity`,
  )
  assert(
    run.identifiers[0].id === run.environmentId,
    `multirun proof run ${index} has a mismatched environment identity`,
  )
  assert(
    run.identifiers[3].id === run.runId,
    `multirun proof run ${index} has a mismatched run identity`,
  )
}

/** Validates the complete two-conversation proof used by LIVE-07. */
export function assertMultirunProof(proof) {
  assert(object(proof), 'LIVE-07 multirun evidence is missing')
  assert(
    proof.schemaVersion === MULTIRUN_PROOF_SCHEMA,
    'LIVE-07 multirun evidence has an unsupported schema',
  )
  assert(proof.status === 'passed', 'LIVE-07 multirun evidence did not pass')
  assert(object(proof.provider), 'LIVE-07 multirun evidence has no provider receipt')
  assert(proof.provider.lifecycle === 'retained', 'LIVE-07 multirun proof is not retained')
  assert(proof.provider.runner === 'opencode', 'LIVE-07 multirun proof used an unproven runner')
  assert(text(proof.provider.endpoint), 'LIVE-07 multirun proof has no endpoint')
  assert(text(proof.provider.model), 'LIVE-07 multirun proof has no model')
  assert(
    proof.provider.credentialConfigured === true,
    'LIVE-07 multirun proof did not confirm configured credentials',
  )
  assert(proof.error === null, 'LIVE-07 multirun proof retained an execution error')

  assert(object(proof.conversations?.first), 'LIVE-07 multirun proof has no first conversation')
  assert(object(proof.conversations?.second), 'LIVE-07 multirun proof has no second conversation')
  assert(
    text(proof.conversations.first.conversationId),
    'LIVE-07 first conversation identity is missing',
  )
  assert(
    text(proof.conversations.second.conversationId),
    'LIVE-07 second conversation identity is missing',
  )
  assert(
    proof.conversations.first.conversationId !== proof.conversations.second.conversationId,
    'LIVE-07 multirun proof reused the conversation identity',
  )
  assert(text(proof.conversations.first.branchId), 'LIVE-07 first branch identity is missing')
  assert(text(proof.conversations.second.branchId), 'LIVE-07 second branch identity is missing')
  assert(
    proof.conversations.first.branchId !== proof.conversations.second.branchId,
    'LIVE-07 multirun proof reused the branch identity',
  )

  assert(
    Array.isArray(proof.runs) && proof.runs.length === 2,
    'LIVE-07 multirun proof requires exactly two runs',
  )
  assert(
    new Set(proof.runs.map((run) => run?.runId)).size === 2,
    'LIVE-07 multirun proof reused a run identity',
  )
  proof.runs.forEach(assertRun)
  assert(
    new Set(proof.runs.map((run) => run.conversationId)).size === 2,
    'LIVE-07 runs are not on independent conversations',
  )
  assert(
    new Set(proof.runs.map((run) => run.branchId)).size === 2,
    'LIVE-07 runs are not on independent branches',
  )
  const conversations = new Map([
    [proof.conversations.first.conversationId, proof.conversations.first.branchId],
    [proof.conversations.second.conversationId, proof.conversations.second.branchId],
  ])
  assert(
    proof.runs.every((run) => conversations.get(run.conversationId) === run.branchId),
    'LIVE-07 runs do not bind to the recorded conversations and branches',
  )
  const providerIdentifiers = proof.runs.flatMap((run) => run.identifiers.map(({ id }) => id))
  assert(
    new Set(providerIdentifiers).size === providerIdentifiers.length,
    'LIVE-07 multirun proof reused a provider identity',
  )

  assert(object(proof.overlap), 'LIVE-07 multirun overlap evidence is missing')
  assert(
    proof.overlap.activeRunCount === 2,
    'LIVE-07 multirun proof did not overlap two active runs',
  )
  assert(
    proof.overlap.independentConversations === true,
    'LIVE-07 multirun proof did not keep conversations independent',
  )
  assert(
    Number.isInteger(proof.overlap.workStripCount) && proof.overlap.workStripCount >= 2,
    'LIVE-07 multirun proof did not expose both runs in the work strip',
  )
  assert(
    Array.isArray(proof.overlap.streamEventCounts) && proof.overlap.streamEventCounts.length === 2,
    'LIVE-07 multirun stream evidence is incomplete',
  )
  assert(
    proof.overlap.streamEventCounts.every(
      (entry) =>
        object(entry) && text(entry.runId) && Number.isInteger(entry.count) && entry.count > 0,
    ),
    'LIVE-07 multirun stream evidence has no events for every run',
  )
  const runIds = new Set(proof.runs.map((run) => run.runId))
  assert(
    new Set(proof.overlap.streamEventCounts.map((entry) => entry.runId)).size === 2 &&
      proof.overlap.streamEventCounts.every((entry) => runIds.has(entry.runId)),
    'LIVE-07 multirun stream evidence does not map to both runs',
  )

  assert(object(proof.focus), 'LIVE-07 focus evidence is missing')
  const [firstRun, secondRun] = proof.runs
  assert(firstRun.status === 'completed', 'LIVE-07 first run did not complete')
  assert(
    ['aborted', 'cancelled'].includes(secondRun.status),
    'LIVE-07 second run was not cancelled',
  )
  assert(
    proof.focus.beforeRunId === secondRun.runId,
    'LIVE-07 focus did not foreground the newly admitted run',
  )
  assert(
    proof.focus.firstSwitchRunId === firstRun.runId,
    'LIVE-07 focus did not switch to the first run',
  )
  assert(
    proof.focus.secondSwitchRunId === secondRun.runId,
    'LIVE-07 focus did not switch back to the second run',
  )
  assert(
    proof.focus.firstSwitchPreservedStatuses === true,
    'LIVE-07 focus switch did not preserve both run statuses',
  )
  assert(
    proof.focus.secondSwitchPreservedStatuses === true,
    'LIVE-07 focus return did not preserve both run statuses',
  )

  assert(object(proof.cancellation), 'LIVE-07 cancellation evidence is missing')
  assert(proof.cancellation.targetRunId === secondRun.runId, 'LIVE-07 cancelled the wrong run')
  assert(
    ['aborted', 'cancelled'].includes(proof.cancellation.targetStatus),
    'LIVE-07 cancellation did not reach a terminal status',
  )
  assert(
    proof.cancellation.unaffectedRunId === firstRun.runId,
    'LIVE-07 cancellation has no unaffected run',
  )
  assert(
    proof.cancellation.unaffectedStatusAtAck !== null,
    'LIVE-07 cancellation omitted the unaffected status',
  )
  assert(
    proof.cancellation.unaffectedFinalStatus === 'completed',
    'LIVE-07 cancellation stopped the unaffected run',
  )

  assert(object(proof.replay), 'LIVE-07 restart replay evidence is missing')
  assert(proof.replay.restartedRunCount === 2, 'LIVE-07 restart did not restore both runs')
  assert(
    proof.replay.noDuplicateEventIds === true,
    'LIVE-07 restart replay duplicated provider events',
  )
  assert(
    proof.replay.eventSetsStable === true,
    'LIVE-07 restart replay changed provider event identities',
  )

  assert(object(proof.cleanup), 'LIVE-07 multirun cleanup evidence is missing')
  assert(proof.cleanup.exact === true, 'LIVE-07 multirun cleanup was not exact')
  assert(
    Array.isArray(proof.cleanup.errors) && proof.cleanup.errors.length === 0,
    'LIVE-07 multirun cleanup has unresolved errors',
  )
  assert(
    Array.isArray(proof.cleanup.resources) && proof.cleanup.resources.length === 2,
    'LIVE-07 multirun cleanup did not account for both resources',
  )
  assert(
    proof.cleanup.resources.every(
      (resource) =>
        object(resource) &&
        text(resource.runId) &&
        text(resource.environmentId) &&
        text(resource.id) &&
        resource.confirmed === true,
    ),
    'LIVE-07 multirun cleanup did not confirm every resource',
  )
  const runsById = new Map(proof.runs.map((run) => [run.runId, run]))
  assert(
    proof.cleanup.resources.every(
      (resource) => resource.environmentId === runsById.get(resource.runId)?.environmentId,
    ),
    'LIVE-07 multirun cleanup did not bind provider environments to runs',
  )
  assert(
    new Set(proof.cleanup.resources.map((resource) => resource.runId)).size === 2 &&
      proof.cleanup.resources.every((resource) => runIds.has(resource.runId)),
    'LIVE-07 multirun cleanup did not bind both run identities',
  )
  assert(
    proof.cleanup.activeResourceDelta === 0,
    'LIVE-07 multirun cleanup changed active resource count',
  )
  assert(proof.cleanup.accountStable === true, 'LIVE-07 multirun cleanup changed account identity')
  assert(
    proof.cleanup.workspace?.protectedStoreClean === true,
    'LIVE-07 multirun cleanup retained protected workspace state',
  )
  assert(
    proof.cleanup.workspace?.temporaryRootRemoved === true,
    'LIVE-07 multirun cleanup retained its temporary workspace',
  )

  assert(object(proof.phases), 'LIVE-07 multirun phase evidence is missing')
  for (const phase of REQUIRED_PHASES)
    assert(proof.phases[phase]?.status === 'passed', `LIVE-07 multirun phase ${phase} did not pass`)
  return proof
}

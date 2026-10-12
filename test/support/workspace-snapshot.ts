import type { AgentWorkspaceSnapshotRef } from '@tangle-network/agent-interface'

export function workspaceSnapshotRef(): AgentWorkspaceSnapshotRef {
  const hash = (fill: string) => `sha256:${fill.repeat(64)}` as const
  const ref = (fill: string) => ({ locator: { kind: 'private-cas' as const, namespace: 'transfer-operation', digest: hash(fill) }, sha256: hash(fill), byteLength: 128 })
  return { kind: 'agent-candidate-workspace-snapshot', digest: hash('a'), manifest: ref('a'), archive: ref('b'), source: { leaseId: 'lease-source', leaseRecordDigest: hash('c'), workspace: { provider: 'local', root: '/workspace/source', identityDigest: hash('d') }, sourceSnapshotDigest: hash('e'), sourceSnapshotPolicy: { kind: 'provider-declared', name: 'git-working-tree', version: 1, digest: hash('f') } } }
}

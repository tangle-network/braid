import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { defineAgentProfile } from '@tangle-network/agent-interface'
import { createApplicationUiController } from '../src/adapters/tui/application-ui-controller.js'
import { createBraidApplication } from '../src/app/composition.js'
import { MemoryJournal } from '../src/app/journal.js'
import { FixedClock } from '../src/ports/clock.js'

const phases = [
  'pending-committed',
  'temporary-written',
  'temporary-fsynced',
  'renamed',
  'directory-fsynced',
  'acknowledgment',
] as const

test('profile save recovery acknowledges or retries every atomic-write stop without guessing', async () => {
  for (const phase of phases) {
    const root = await mkdtemp(join(tmpdir(), `braid-profile-recovery-${phase}-`))
    const path = join(root, 'profile.json')
    const secretProfile = defineAgentProfile({
      name: `recovery-${phase}`,
      harness: 'pi',
      model: { default: 'fixture/recovery' },
      prompt: { instructions: ['token=PROFILE-SAVE-SECRET-CANARY'] },
    })
    const operationId = `op-profile-recovery-${phase}`
    const journal = new MemoryJournal(new FixedClock())
    const first = createBraidApplication({
      fixture: 'deterministic',
      journal,
      effectStorage: journal,
    })
    const firstController = createApplicationUiController(first, {}, undefined, {
      onProfileSavePhase: (current) => {
        if (current === phase) throw new Error(`forced stop at ${phase}`)
      },
    })
    try {
      const initialized = await firstController.initialize('/workspace')
      assert.equal(initialized.kind, 'accepted')
      const failed = await firstController.dispatch({
        type: 'headless-command',
        command: 'save_profile',
        operationId,
        params: { ref: path, profile: secretProfile },
      })
      assert.equal(failed.kind, 'error', phase)
      assert.equal(
        first.state().operations.find((operation) => operation.id === operationId)?.status,
        'pending',
      )

      const restarted = createBraidApplication({
        fixture: 'deterministic',
        journal,
        effectStorage: journal,
      })
      const restartedController = createApplicationUiController(restarted)
      const recovered = await restartedController.dispatch({
        type: 'headless-command',
        command: 'save_profile',
        operationId,
        params: { ref: path, profile: secretProfile },
      })
      assert.equal(recovered.kind, 'accepted', phase)
      assert.equal(recovered.replayed, true, phase)
      const bytes = await readFile(path, 'utf8')
      assert.match(bytes, new RegExp(`"name":"recovery-${phase}"`, 'u'))
      assert.equal(JSON.stringify(restarted.events()).includes('PROFILE-SAVE-SECRET-CANARY'), false)
      assert.equal(
        restarted.state().operations.find((operation) => operation.id === operationId)?.status,
        'acknowledged',
      )

      const exactReplay = await restartedController.dispatch({
        type: 'headless-command',
        command: 'save_profile',
        operationId,
        params: { ref: path, profile: secretProfile },
      })
      assert.deepEqual(exactReplay, recovered, phase)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

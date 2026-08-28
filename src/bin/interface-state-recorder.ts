import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  assertNoSymlinkPath,
  replacePrivateFile,
  writePrivateFile,
} from '../adapters/persistence/safe-file.js'
import type { BraidUiController } from '../views/shared/intents.js'

export async function recordInterfaceState(
  path: string,
  controller: BraidUiController,
  capturePhase: 'final' | 'atomic-signal-frame' = 'final',
): Promise<void> {
  const target = resolve(path)
  const directory = dirname(target)
  const payload = `${JSON.stringify(
    {
      schemaVersion: 2,
      capturePhase,
      state: controller.state(),
      view: controller.view(),
      events: controller.events(),
    },
    null,
    2,
  )}\n`
  assertNoSymlinkPath(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinkPath(directory)
  if (capturePhase === 'atomic-signal-frame') {
    replacePrivateFile(target, payload, { overwrite: true })
  } else writePrivateFile(target, payload)
}

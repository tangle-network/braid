import { cp, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { configuredTestDist, resetTestDist } from './test-dist.mjs'

const testDist = configuredTestDist()
await resetTestDist(testDist)
const sourceScripts = new URL('../scripts/', import.meta.url)
const testScripts = join(testDist, 'scripts')

async function copyModuleScripts(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await copyModuleScripts(new URL(`${entry.name}/`, source), join(target, entry.name))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    await cp(new URL(entry.name, source), join(target, entry.name))
  }
}

await copyModuleScripts(sourceScripts, testScripts)

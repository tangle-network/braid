import { cp, mkdir, readdir, rm } from 'node:fs/promises'

await rm(new URL('../.test-dist', import.meta.url), { force: true, recursive: true })

const sourceScripts = new URL('../scripts/', import.meta.url)
const testScripts = new URL('../.test-dist/scripts/', import.meta.url)

async function copyModuleScripts(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await copyModuleScripts(new URL(`${entry.name}/`, source), new URL(`${entry.name}/`, target))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    await cp(new URL(entry.name, source), new URL(entry.name, target))
  }
}

await copyModuleScripts(sourceScripts, testScripts)

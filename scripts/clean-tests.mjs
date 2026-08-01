import { rm } from 'node:fs/promises'

await rm(new URL('../.test-dist', import.meta.url), { force: true, recursive: true })

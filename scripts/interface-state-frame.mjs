import { readFile, stat } from 'node:fs/promises'

export async function stateFrameVersion(path) {
  try {
    const value = await stat(path, { bigint: true })
    return `${value.dev}:${value.ino}:${value.mtimeNs}:${value.size}`
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

// Readers leave the published file in place. Removing it can race the recorder's
// post-publication verification; the atomic replacement itself identifies the next frame.
export async function readFreshStateFrame(path, previousVersion) {
  try {
    const version = await stateFrameVersion(path)
    if (version === undefined || version === previousVersion) return undefined
    const frame = JSON.parse(await readFile(path, 'utf8'))
    return (await stateFrameVersion(path)) === version ? frame : undefined
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

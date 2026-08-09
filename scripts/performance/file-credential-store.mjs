import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function credentialPath(root, ref) {
  return join(root, createHash('sha256').update(String(ref)).digest('hex'))
}

function missingCredential(ref, cause) {
  const error = new Error(`Credential ${ref} was not found`, { cause })
  error.code = 'CREDENTIAL_NOT_FOUND'
  return error
}

class FileSecretHandle {
  constructor(ref, value) {
    this.ref = ref
    this.value = Buffer.from(value)
  }

  read() {
    if (!this.value) throw new Error('Secret handle is closed')
    return Buffer.from(this.value)
  }

  dispose() {
    this.value?.fill(0)
    this.value = undefined
  }
}

export class FileCredentialStore {
  constructor(root) {
    this.root = root
  }

  async store(input) {
    const ref = input.ref ?? `cred:v1:performance-file-${randomUUID()}`
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = credentialPath(this.root, ref)
    await writeFile(target, Buffer.from(input.value), { mode: 0o600 })
    return ref
  }

  async resolve(ref) {
    try {
      return new FileSecretHandle(ref, await readFile(credentialPath(this.root, ref)))
    } catch (error) {
      throw missingCredential(ref, error)
    }
  }

  async remove(ref) {
    await rm(credentialPath(this.root, ref), { force: true })
  }

  async available() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    return true
  }
}

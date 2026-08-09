export class StorageError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'StorageError'
    this.code = code
  }
}

export class InteractionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'InteractionError'
    this.code = code
  }
}

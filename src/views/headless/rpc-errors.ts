export class RpcParseError extends Error {
  readonly code: string
  readonly choices?: readonly string[]

  constructor(code: string, message: string, choices?: readonly string[]) {
    super(message)
    this.name = 'RpcParseError'
    this.code = code
    if (choices) this.choices = choices
  }
}

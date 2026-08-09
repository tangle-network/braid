export class LiveBridgeError extends Error {
  constructor(code, message, exitCode, details = {}) {
    super(message)
    this.name = 'LiveBridgeError'
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

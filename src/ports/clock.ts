export interface Clock {
  now(): string
}

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString()
  }
}

export class FixedClock implements Clock {
  readonly #value: string

  constructor(value = '2026-08-01T00:00:00.000Z') {
    this.#value = value
  }

  now(): string {
    return this.#value
  }
}

export class SerializedActionQueue {
  #tail: Promise<void> = Promise.resolve()

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(action)
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

export class KeyedActionQueue {
  readonly #tails = new Map<string, Promise<void>>()

  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const result = previous.then(action)
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.#tails.set(key, tail)
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    return result
  }

  async whenIdle(): Promise<void> {
    while (this.#tails.size > 0) await Promise.all(this.#tails.values())
  }
}

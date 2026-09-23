export interface Scheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export class SystemScheduler implements Scheduler {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const handle = setTimeout(callback, Math.max(0, delayMs))
    handle.unref?.()
    return handle
  }

  clear(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  }
}

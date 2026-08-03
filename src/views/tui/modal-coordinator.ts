import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui'
import { layoutFor } from './layout.js'

export interface ModalOptions extends OverlayOptions {
  readonly fullScreenBelow?: number
}

export class ModalCoordinator {
  readonly #tui: TUI
  readonly #handles: OverlayHandle[] = []

  constructor(tui: TUI) {
    this.#tui = tui
  }

  open(component: Component, options: ModalOptions = {}, preempt = true): OverlayHandle {
    if (preempt) this.closeTop()
    const fullScreenBelow = options.fullScreenBelow ?? 80
    const layout = layoutFor(this.#tui.terminal.columns, this.#tui.terminal.rows)
    const handle = this.#tui.showOverlay(component, {
      ...options,
      ...(layout.columns < fullScreenBelow
        ? { width: '100%', maxHeight: '100%', anchor: 'top-left' as const, margin: 0 }
        : {}),
    })
    this.#handles.push(handle)
    return handle
  }

  closeTop(): void {
    const handle = this.#handles.pop()
    handle?.hide()
  }

  closeAll(): void {
    while (this.#handles.length > 0) this.#handles.pop()?.hide()
  }

  hasOpen(): boolean {
    return this.#handles.some((handle) => !handle.isHidden())
  }

  focusTop(): void {
    this.#handles.at(-1)?.focus()
  }
}

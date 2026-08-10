import type { Component, OverlayHandle, OverlayOptions, TUI } from '@earendil-works/pi-tui'
import { layoutFor } from './layout.js'

export interface ModalOptions extends OverlayOptions {
  readonly fullScreenBelow?: number
  readonly onClose?: () => void
}

export interface ModalBackTarget {
  /** Returns true when the component consumed the back action. */
  goBack(): boolean
}

interface ModalEntry {
  readonly component: Component
  readonly handle: OverlayHandle
  readonly onClose?: () => void
}

export class ModalCoordinator {
  readonly #tui: TUI
  readonly #entries: ModalEntry[] = []

  constructor(tui: TUI) {
    this.#tui = tui
  }

  open(component: Component, options: ModalOptions = {}, preempt = true): OverlayHandle {
    if (preempt) this.closeTop()
    const { fullScreenBelow = 80, onClose, ...overlayOptions } = options
    const layout = layoutFor(this.#tui.terminal.columns, this.#tui.terminal.rows)
    const handle = this.#tui.showOverlay(component, {
      ...overlayOptions,
      ...(layout.columns < fullScreenBelow
        ? { width: '100%', maxHeight: '100%', anchor: 'top-left' as const, margin: 0 }
        : {}),
    })
    this.#entries.push({ component, handle, ...(onClose === undefined ? {} : { onClose }) })
    return handle
  }

  closeTop(): void {
    const entry = this.#entries.pop()
    if (entry === undefined) return
    entry.handle.hide()
    entry.onClose?.()
  }

  backOrClose(): void {
    const entry = this.#top()
    if (entry !== undefined && isBackTarget(entry.component) && entry.component.goBack()) {
      this.#tui.requestRender()
      return
    }
    this.closeTop()
  }

  closeAll(): void {
    while (this.#entries.length > 0) this.closeTop()
  }

  hasOpen(): boolean {
    this.#removeHiddenTop()
    return this.#entries.length > 0
  }

  focusTop(): void {
    this.#top()?.handle.focus()
  }

  handleInput(data: string): boolean {
    const entry = this.#top()
    if (entry === undefined) return false
    entry.component.handleInput?.(data)
    return true
  }

  #top(): ModalEntry | undefined {
    this.#removeHiddenTop()
    return this.#entries.at(-1)
  }

  #removeHiddenTop(): void {
    while (this.#entries.at(-1)?.handle.isHidden()) this.#entries.pop()?.onClose?.()
  }
}

function isBackTarget(component: Component): component is Component & ModalBackTarget {
  return typeof (component as { readonly goBack?: unknown }).goBack === 'function'
}

import { Container, type Focusable, type SelectItem } from '@earendil-works/pi-tui'
import type { ConnectionSummary } from '../../app/connection-action-types.js'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  actionMessage,
  connectionCompactDetail,
  connectionDetailLines,
  connectionItems,
  connectionSummariesFrom,
  REFRESH_TIMEOUT,
  safe,
  within,
} from './configuration-presenters.js'
import { ResponsiveText } from './configuration-responsive-text.js'
import {
  connectionErrorMessage,
  connectionItemName,
  readConnectionTest,
  selectConnectionIntent,
  testConnectionIntent,
} from './connection-setup-actions.js'
import { connectionSetupChildren } from './connection-setup-rendering.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

interface ConnectionSetupOptions {
  readonly controller?: BraidUiController
  readonly nextOperationId?: () => string
  readonly query?: string
  readonly onCancel?: () => void
  readonly onCreate?: () => void
  readonly onRemove?: (connection: ConnectionSummary) => void
}

const CONNECTION_REFRESH_TIMEOUT_MS = 2_000

export class ConnectionSetupViewPanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController | undefined
  readonly #nextOperationId: (() => string) | undefined
  readonly #onCancel: (() => void) | undefined
  readonly #onCreate: (() => void) | undefined
  readonly #onRemove: ((connection: ConnectionSummary) => void) | undefined
  readonly #status = new ResponsiveText('', 1, 0)
  readonly #detail = new ResponsiveText('', 1, 0)
  #selector: SearchableSelector | undefined
  #connections: readonly ConnectionSummary[] = []
  #focused = false
  #busy = false
  #refreshGeneration = 0
  #activeConnectionId: string | undefined

  constructor(theme: BraidTheme, options: ConnectionSetupOptions = {}) {
    super()
    this.#theme = theme
    this.#controller = options.controller
    this.#nextOperationId = options.nextOperationId
    this.#onCancel = options.onCancel
    this.#onCreate = options.onCreate
    this.#onRemove = options.onRemove
    if (this.#controller !== undefined) {
      this.#buildSelector(options.query ?? '')
      void this.#refresh().catch((error: unknown) => {
        this.#setStatus(
          this.#connections.length > 0
            ? `Refresh unavailable · showing the last connection list · ${connectionErrorMessage(error, 'refresh failed')}`
            : `Connections unavailable · refresh failed · ${connectionErrorMessage(error, 'try again')}`,
        )
      })
    }
  }

  get focused(): boolean {
    return this.#focused
  }

  set focused(value: boolean) {
    this.#focused = value
    if (this.#selector) this.#selector.focused = value
  }

  handleInput(data: string): void {
    this.#selector?.handleInput(data)
  }

  setView(view: BraidViewModel): void {
    if (this.#controller !== undefined) return
    this.clear()
    for (const child of connectionSetupChildren(this.#theme, view)) this.addChild(child)
    this.invalidate()
  }

  #buildSelector(query: string): void {
    if (this.#controller === undefined) return
    this.#selector = new SearchableSelector({
      title: 'connections',
      items: [],
      query,
      maxVisible: 5,
      footer:
        this.#onCreate === undefined
          ? 'enter select · ^T test · esc close'
          : 'enter select · ^N new · ^T test · ^D remove · esc close',
      theme: this.#theme,
      onSelect: (item) => void this.#select(item),
      onAction: (key, item) => {
        if (item !== null && key === 'test' && !this.#busy) void this.#test(item)
        if (key === 'new' && !this.#busy) this.#onCreate?.()
        if (item !== null && key === 'delete' && !this.#busy) {
          const connection = this.#connections.find((candidate) => candidate.id === item.value)
          if (connection !== undefined) this.#onRemove?.(connection)
        }
      },
      onCancel: () => this.#onCancel?.(),
    })
    this.#selector.focused = this.#focused
    this.#renderController('Loading connections…')
  }

  async #refresh(notice?: string, preferredDetail?: ConnectionSummary): Promise<void> {
    const generation = ++this.#refreshGeneration
    const result = await within(
      this.#dispatch({ type: 'headless-command', command: 'list_connections', params: {} }),
      CONNECTION_REFRESH_TIMEOUT_MS,
    )
    if (generation !== this.#refreshGeneration) return
    if (result === REFRESH_TIMEOUT) {
      this.#setStatus(
        this.#connections.length > 0
          ? 'Refresh unavailable · showing the last connection list'
          : 'Connections unavailable · refresh timed out',
      )
      return
    }
    if (result.kind !== 'accepted') {
      this.#setStatus(
        this.#connections.length > 0
          ? `Refresh unavailable · showing the last connection list · ${actionMessage(result, '')}`
          : actionMessage(result, 'Connections unavailable'),
      )
      return
    }
    this.#connections = [...connectionSummariesFrom(result.data)]
    const activeName = this.#controller?.view().connection
    const tracked = this.#connections.find(
      (connection) => connection.id === this.#activeConnectionId,
    )
    const active =
      tracked?.name === activeName
        ? tracked
        : this.#connections.filter((connection) => connection.name === activeName).length === 1
          ? this.#connections.find((connection) => connection.name === activeName)
          : undefined
    this.#activeConnectionId = active?.id
    this.#selector?.setItems(
      connectionItems(this.#connections, activeName, this.#activeConnectionId),
    )
    const detail = preferredDetail ?? active
    this.#setDetail(connectionDetailLines(detail).join('\n'), connectionCompactDetail(detail))
    this.#setStatus(
      notice ??
        (this.#connections.length === 0
          ? 'No connections found'
          : active === undefined
            ? 'Connections ready · choose one'
            : `Active connection · ${safe(active.name)}`),
    )
  }

  async #select(item: SelectItem): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    const name = connectionItemName(item)
    this.#setStatus(`Selecting ${safe(name)}…`)
    try {
      const result = await this.#dispatch(
        selectConnectionIntent(item, this.#operationId(), this.#controller?.view().revision ?? 0),
      )
      if (result.kind === 'accepted') {
        this.#activeConnectionId = item.value
        await this.#refresh(`Selected ${safe(name)} · next runs use it`)
      } else {
        this.#setStatus(actionMessage(result, 'Connection selection failed'))
      }
    } catch (error) {
      this.#setStatus(connectionErrorMessage(error, 'Connection selection failed'))
    } finally {
      this.#busy = false
    }
  }

  async #test(item: SelectItem): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    const name = connectionItemName(item)
    this.#setStatus(`Testing ${safe(name)}…`)
    try {
      const result = await this.#dispatch(testConnectionIntent(item, this.#operationId()))
      if (result.kind !== 'accepted') {
        this.#setStatus(actionMessage(result, 'Connection test failed'))
        return
      }
      const tested = readConnectionTest(result.data)
      const status = tested?.health.status ?? 'unknown'
      const model = tested?.modelVerification?.status ?? 'unverified'
      await this.#refresh(
        `Tested ${safe(name)} · health ${safe(status)} · model ${safe(model)}`,
        tested,
      )
    } catch (error) {
      this.#setStatus(connectionErrorMessage(error, 'Connection test failed'))
    } finally {
      this.#busy = false
    }
  }

  #dispatch(intent: BraidIntent): Promise<UiDispatchResult> {
    if (this.#controller === undefined) {
      return Promise.resolve({
        kind: 'error',
        code: 'UI_NOT_CONNECTED',
        message: 'Connection actions require an application controller',
        retryable: false,
      })
    }
    return this.#controller.dispatch(intent)
  }

  #operationId(): string {
    return this.#nextOperationId?.() ?? `connection-ui-${Date.now()}`
  }

  #renderController(status?: string): void {
    if (status !== undefined) this.#status.setText(sanitizeTerminalText(status))
    this.clear()
    this.addChild(this.#status)
    this.addChild(this.#detail)
    if (this.#selector) this.addChild(this.#selector)
    this.invalidate()
  }

  #setDetail(detail: string, compactDetail = detail): void {
    this.#detail.setText(
      this.#theme.muted(sanitizeTerminalText(detail)),
      this.#theme.muted(sanitizeTerminalText(compactDetail)),
    )
    this.#renderController()
  }

  #setStatus(status: string): void {
    this.#status.setText(sanitizeTerminalText(status))
    this.#renderController()
  }
}

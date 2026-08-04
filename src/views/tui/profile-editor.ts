import { Container, type Focusable, type SelectItem } from '@earendil-works/pi-tui'
import type { ProfileSummary } from '../../app/profiles.js'
import type { BraidIntent, BraidUiController, UiDispatchResult } from '../shared/intents.js'
import type { BraidViewModel } from '../shared/models.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import {
  actionMessage,
  profileCompactDetail,
  profileDetailLines,
  profileItems,
  profileSummariesFrom,
  REFRESH_TIMEOUT,
  safe,
  within,
} from './configuration-presenters.js'
import { ResponsiveText } from './configuration-responsive-text.js'
import {
  profileErrorMessage,
  profileItemName,
  readProfileCompatibility,
  readValidationReport,
  saveProfileIntent,
  selectProfileIntent,
  validateProfileIntent,
} from './profile-editor-actions.js'
import { profileEditorChildren } from './profile-editor-rendering.js'
import { profileCompatibilityTextLines } from './profile-compatibility.js'
import { SearchableSelector } from './selector.js'
import type { BraidTheme } from './theme.js'

interface ProfileEditorOptions {
  readonly controller?: BraidUiController
  readonly nextOperationId?: () => string
  readonly query?: string
  readonly onCancel?: () => void
}

const PROFILE_REFRESH_TIMEOUT_MS = 2_000

export class ProfileEditorViewPanel extends Container implements Focusable {
  readonly #theme: BraidTheme
  readonly #controller: BraidUiController | undefined
  readonly #nextOperationId: (() => string) | undefined
  readonly #onCancel: (() => void) | undefined
  readonly #status = new ResponsiveText('', 1, 0)
  readonly #detail = new ResponsiveText('', 1, 0)
  #selector: SearchableSelector | undefined
  #profiles: readonly ProfileSummary[] = []
  #focused = false
  #busy = false
  #refreshGeneration = 0
  #activeProfileId: string | undefined

  constructor(theme: BraidTheme, options: ProfileEditorOptions = {}) {
    super()
    this.#theme = theme
    this.#controller = options.controller
    this.#nextOperationId = options.nextOperationId
    this.#onCancel = options.onCancel
    if (this.#controller !== undefined) {
      this.#buildSelector(options.query ?? '')
      void this.#refresh().catch((error: unknown) => {
        this.#setStatus(
          this.#profiles.length > 0
            ? `Refresh unavailable · showing the last profile list · ${profileErrorMessage(error, 'refresh failed')}`
            : `Profiles unavailable · refresh failed · ${profileErrorMessage(error, 'try again')}`,
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
    for (const child of profileEditorChildren(this.#theme, view)) this.addChild(child)
    this.invalidate()
  }

  #buildSelector(query: string): void {
    if (this.#controller === undefined) return
    this.#selector = new SearchableSelector({
      title: 'profiles',
      items: [],
      query,
      maxVisible: 5,
      footer: 'enter · ^V valid · ^S save · esc',
      theme: this.#theme,
      onSelect: (item) => void this.#select(item),
      onAction: (key, item) => {
        if (item === null || this.#busy) return
        if (key === 'validate') void this.#validate(item)
        if (key === 'save') void this.#save(item)
      },
      onCancel: () => this.#onCancel?.(),
    })
    this.#selector.focused = this.#focused
    this.#renderController('Loading profiles…')
  }

  async #refresh(notice?: string): Promise<void> {
    const generation = ++this.#refreshGeneration
    const result = await within(
      this.#dispatch({ type: 'headless-command', command: 'list_profiles', params: {} }),
      PROFILE_REFRESH_TIMEOUT_MS,
    )
    if (generation !== this.#refreshGeneration) return
    if (result === REFRESH_TIMEOUT) {
      this.#setStatus(
        this.#profiles.length > 0
          ? 'Refresh unavailable · showing the last profile list'
          : 'Profiles unavailable · refresh timed out',
      )
      return
    }
    if (result.kind !== 'accepted') {
      this.#setStatus(
        this.#profiles.length > 0
          ? `Refresh unavailable · showing the last profile list · ${actionMessage(result, '')}`
          : actionMessage(result, 'Profiles unavailable'),
      )
      return
    }
    this.#profiles = [...profileSummariesFrom(result.data)]
    const activeName = this.#controller?.view().profileName
    const tracked = this.#profiles.find((profile) => profile.id === this.#activeProfileId)
    const active =
      tracked?.name === activeName
        ? tracked
        : this.#profiles.filter((profile) => profile.name === activeName).length === 1
          ? this.#profiles.find((profile) => profile.name === activeName)
          : undefined
    this.#activeProfileId = active?.id
    this.#selector?.setItems(profileItems(this.#profiles, activeName, this.#activeProfileId))
    this.#setDetail(profileDetailLines(active).join('\n'), profileCompactDetail(active))
    this.#setStatus(
      notice ??
        (this.#profiles.length === 0
          ? 'No profiles found'
          : active === undefined
            ? 'Profiles ready · choose one'
            : `Active profile · ${safe(active.name)}`),
    )
  }

  async #select(item: SelectItem): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#setStatus(`Selecting ${safe(profileItemName(item))}…`)
    try {
      const result = await this.#dispatch(
        selectProfileIntent(item, this.#operationId(), this.#controller?.view().revision ?? 0),
      )
      if (result.kind === 'accepted') {
        this.#activeProfileId = item.value
        await this.#refresh(`Selected ${safe(profileItemName(item))} · next runs use it`)
      } else {
        this.#setStatus(actionMessage(result, 'Profile selection failed'))
      }
    } catch (error) {
      this.#setStatus(profileErrorMessage(error, 'Profile selection failed'))
    } finally {
      this.#busy = false
    }
  }

  async #validate(item: SelectItem): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    this.#setStatus(`Validating ${safe(profileItemName(item))}…`)
    try {
      const result = await this.#dispatch(validateProfileIntent(item))
      if (result.kind !== 'accepted') {
        this.#setStatus(actionMessage(result, 'Profile validation failed'))
        return
      }
      const report = readValidationReport(result.data)
      if (report === undefined) {
        this.#setStatus('Profile validation returned no report')
        return
      }
      const issues = report.issues
        .slice(0, 4)
        .map(
          (issue) =>
            `${issue.level} · ${issue.path === undefined ? issue.code : issue.path} · ${issue.message}`,
        )
      const compatibility = readProfileCompatibility(result.data)
      const compatibilityLines = profileCompatibilityTextLines(compatibility, 120)
      const modelUnsupported = compatibility?.compatibility?.modelSupported === false
      this.#setDetail(
        [
          report.ok ? 'valid · this profile can be used' : 'invalid · fix the reported fields',
          ...issues,
          ...compatibilityLines,
        ]
          .map(sanitizeTerminalText)
          .join('\n'),
        report.ok
          ? modelUnsupported
            ? 'valid profile · choose a compatible runner or model'
            : 'valid · this profile can be used'
          : 'invalid · fix the reported fields',
      )
      this.#setStatus(
        report.ok
          ? modelUnsupported
            ? 'Profile valid · runner/model choice required'
            : 'Profile valid'
          : 'Profile needs attention',
      )
    } catch (error) {
      this.#setStatus(profileErrorMessage(error, 'Profile validation failed'))
    } finally {
      this.#busy = false
    }
  }

  async #save(item: SelectItem): Promise<void> {
    if (this.#busy) return
    const profile = this.#profiles.find((candidate) => candidate.id === item.value)
    if (profile === undefined || profile.id !== this.#activeProfileId) {
      this.#setStatus('Select the exact profile before saving it')
      return
    }
    if (!profile.source.writable) {
      this.#setStatus('This profile source is read-only')
      return
    }
    this.#busy = true
    this.#setStatus(`Saving ${safe(profile.name)}…`)
    try {
      const result = await this.#dispatch(saveProfileIntent(item, this.#operationId()))
      this.#setStatus(actionMessage(result, 'Profile saved'))
      if (result.kind === 'accepted')
        await this.#refresh('Profile saved · active selection preserved')
    } catch (error) {
      this.#setStatus(profileErrorMessage(error, 'Profile save failed'))
    } finally {
      this.#busy = false
    }
  }

  #dispatch(intent: BraidIntent): Promise<UiDispatchResult> {
    if (this.#controller === undefined) {
      return Promise.resolve({
        kind: 'error',
        code: 'UI_NOT_CONNECTED',
        message: 'Profile actions require an application controller',
        retryable: false,
      })
    }
    return this.#controller.dispatch(intent)
  }

  #operationId(): string {
    return this.#nextOperationId?.() ?? `profile-ui-${Date.now()}`
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

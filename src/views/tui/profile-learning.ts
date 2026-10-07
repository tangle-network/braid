import { matchesKey } from '@earendil-works/pi-tui'
import type { LearnedProfileDraft } from '../../app/profile-learning.js'
import { sanitizeTerminalText } from '../shared/sanitize.js'
import { EntityBrowser } from './entity-browser.js'
import type { BraidTheme } from './theme.js'

/** Review the exact portable candidate before asking the controller to save it. */
export class ProfileLearningPanel extends EntityBrowser {
  readonly #save: (() => Promise<string>) | undefined
  readonly #notice: (text: string) => void
  #saving = false
  #saved = false

  constructor(
    theme: BraidTheme,
    options: {
      readonly draft: LearnedProfileDraft
      readonly target?: string
      readonly rows: () => number
      readonly onClose: () => void
      readonly requestRender: () => void
      readonly onSave?: () => Promise<string>
    },
  ) {
    const draft = options.draft
    const action =
      options.target === undefined
        ? 'Unmeasured draft. Use /profile learn <new-file> to review and save a portable copy.'
        : `Unmeasured draft. Ctrl+S saves a new profile to ${options.target}. Esc leaves it unsaved.`
    let notice = sanitizeTerminalText(
      `${action}${draft.redacted ? ' Private values were redacted using profile export rules; review before use.' : ''}`,
    )
    super(theme, {
      rows: options.rows,
      onClose: options.onClose,
      document: () => ({
        title: 'learned profile',
        context: draft.profile.name ?? 'profile',
        notice,
        emptyMessage: 'No lessons with a written reason are available.',
        rows: [
          ...draft.lessons.map((lesson, index) => ({
            id: `lesson-${index}`,
            kind: 'lesson',
            title: lesson.instruction,
            status: 'user feedback',
            detailLines: [
              lesson.instruction,
              '',
              lesson.rationale,
              '',
              `Source: ${lesson.sourceTrajectoryId}`,
            ],
          })),
          {
            id: 'changes',
            kind: 'profile',
            title: 'Exact profile changes',
            status: 'unmeasured',
            detailLines: JSON.stringify(draft.changes, null, 2).split('\n'),
          },
          {
            id: 'candidate',
            kind: 'profile',
            title: 'Complete portable AgentProfile',
            status: 'draft',
            detailLines: JSON.stringify(draft.profile, null, 2).split('\n'),
          },
        ],
      }),
    })
    this.#save = options.onSave
    this.#notice = (text) => {
      notice = sanitizeTerminalText(text)
      this.invalidate()
      options.requestRender()
    }
  }

  override handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+s') && this.#save !== undefined) {
      if (this.#saving || this.#saved) return
      this.#saving = true
      this.#notice('Saving the reviewed profile…')
      void this.#save()
        .then((message) => {
          this.#saved = true
          this.#notice(message)
        })
        .catch((error: unknown) => {
          this.#notice(error instanceof Error ? error.message : 'Profile save failed')
        })
        .finally(() => {
          this.#saving = false
        })
      return
    }
    super.handleInput(data)
  }
}

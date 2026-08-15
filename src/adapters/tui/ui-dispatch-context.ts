import type { BraidApplication } from '../../app/application.js'
import type { UiSubscriber } from '../../views/shared/intents.js'
import type { BraidViewModel } from '../../views/shared/models.js'
import type { ProfileConnectionDispatchServices } from './profile-connection-dispatch.js'

export interface UiDispatchContext {
  readonly app: BraidApplication
  readonly profileConnections: ProfileConnectionDispatchServices
  readonly fixture: import('./ui-fixtures.js').UiFixture | undefined
  readonly subscribers: ReadonlySet<UiSubscriber>
  readonly view: () => BraidViewModel
  readonly notify: () => void
  readonly interactionResolved: () => boolean
  markInteractionResolved(): void
  setSelectedSurface(surface: BraidViewModel['selectedSurface'], query?: string): void
  setNotice(notice: string): void
  setForkPreview(preview: NonNullable<BraidViewModel['forkPreview']>): void
}

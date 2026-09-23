import type { ConnectionViewModel } from '../../controllers/connection-controller.js'
import type { FirstRunViewModel } from '../../controllers/first-run-controller.js'
import type {
  ProfileEditorViewModel,
  ProfileListItem,
} from '../../controllers/profile-controller.js'
import { freezeBoundedProfileValue } from '../../profile/profile-json.js'

export type ProfileIntent =
  | { readonly kind: 'discover-profiles' }
  | { readonly kind: 'select-profile'; readonly reference: string }
  | { readonly kind: 'import-profile'; readonly rawJson: string }
  | { readonly kind: 'edit-profile-raw'; readonly rawJson: string }
  | { readonly kind: 'edit-profile-structured'; readonly path: string; readonly value: unknown }
  | { readonly kind: 'save-profile'; readonly path: string }

export type ConnectionIntent =
  | { readonly kind: 'setup-connection' }
  | { readonly kind: 'refresh-connection'; readonly id: string }
  | { readonly kind: 'select-connection'; readonly id: string }
  | { readonly kind: 'remove-connection'; readonly id: string }

export type FirstRunIntent =
  | { readonly kind: 'first-run-select-profile'; readonly reference: string }
  | { readonly kind: 'first-run-select-connection'; readonly id: string }
  | { readonly kind: 'first-run-confirm' }
  | { readonly kind: 'first-run-cancel' }

export interface ProfileViewModel {
  readonly profiles: readonly ProfileListItem[]
  readonly editor?: ProfileEditorViewModel
  readonly connections: readonly ConnectionViewModel[]
  readonly firstRun?: FirstRunViewModel
}

export function freezeProfileViewModel(value: ProfileViewModel): ProfileViewModel {
  return freezeBoundedProfileValue(value)
}

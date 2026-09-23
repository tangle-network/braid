import type { AgentProfile, AgentProfileSecurityPolicy } from '@tangle-network/agent-interface'
import {
  buildStructuredProfileView,
  editRawProfile,
  editStructuredProfile,
  openProfileEditor,
  type ProfileEditorDraft,
  type StructuredProfileView,
} from '../profile/profile-editor.js'
import { freezeBoundedProfileValue } from '../profile/profile-json.js'
import {
  type DiscoveredProfile,
  discoverProfiles,
  importProfileText,
  type ProfileDiscoveryInput,
  type ProfileDocument,
  type ProfileSaveBlock,
  type ProfileSourceRegistry,
} from '../profile/profile-sources.js'
import {
  type ProfileValidationReport,
  validateCanonicalProfile,
} from '../profile/profile-validation.js'

export interface ProfileListItem {
  readonly reference: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly tags: readonly string[]
  readonly source: string
  readonly digest?: string
  readonly writable: boolean
  readonly saveBlock?: ProfileSaveBlock
  readonly unrecognizedFields: readonly string[]
  readonly validation: 'valid' | 'invalid' | 'unavailable'
  readonly error?: string
}

export interface ProfileEditorViewModel {
  readonly source: ProfileDocument['source']
  readonly profile?: Readonly<AgentProfile>
  readonly rawJson: string
  readonly saveBlock?: ProfileSaveBlock
  readonly unrecognizedFields: readonly string[]
  readonly validation: ProfileValidationReport
  readonly structured?: StructuredProfileView
}

function profileItem(entry: DiscoveredProfile): ProfileListItem {
  const document = entry.document
  return Object.freeze({
    reference: entry.reference,
    name: document?.profile.name ?? 'Unnamed profile',
    ...(document?.profile.description === undefined
      ? {}
      : { description: document.profile.description }),
    ...(document?.profile.version === undefined ? {} : { version: document.profile.version }),
    tags: Object.freeze([...(document?.profile.tags ?? [])]),
    source: document?.source.label ?? entry.source,
    ...(document?.profileDigest === undefined ? {} : { digest: document.profileDigest }),
    writable: document?.writable ?? false,
    ...(document?.saveBlock === undefined ? {} : { saveBlock: document.saveBlock }),
    unrecognizedFields: Object.freeze([...(document?.unrecognizedFields ?? [])]),
    validation: document === undefined ? ('unavailable' as const) : ('valid' as const),
    ...(entry.error === undefined ? {} : { error: entry.error, validation: 'invalid' as const }),
  })
}

export class ProfileController {
  readonly #registry: ProfileSourceRegistry
  readonly #securityPolicy: AgentProfileSecurityPolicy | undefined
  #selected: ProfileDocument | undefined
  #draft: ProfileEditorDraft | undefined

  constructor(
    registry: ProfileSourceRegistry,
    options: { readonly securityPolicy?: AgentProfileSecurityPolicy } = {},
  ) {
    this.#registry = registry
    this.#securityPolicy = options.securityPolicy
  }

  async discover(input: ProfileDiscoveryInput): Promise<readonly ProfileListItem[]> {
    const entries = await discoverProfiles(
      {
        ...input,
        ...(this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy }),
      },
      this.#registry,
    )
    return Object.freeze(entries.map(profileItem))
  }

  async import(rawJson: string, label?: string): Promise<ProfileDocument> {
    const document = await importProfileText(
      rawJson,
      label,
      this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy },
    )
    this.#selected = document
    this.#draft = openProfileEditor(
      document,
      this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy },
    )
    return document
  }

  async select(reference: string): Promise<ProfileDocument> {
    const document = await this.#registry.resolve(
      reference,
      this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy },
    )
    this.#selected = document
    this.#draft = openProfileEditor(
      document,
      this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy },
    )
    return document
  }

  selected(): ProfileDocument | undefined {
    return this.#selected
  }

  validate(value: unknown): ProfileValidationReport {
    return validateCanonicalProfile(
      value,
      this.#securityPolicy === undefined ? {} : { securityPolicy: this.#securityPolicy },
    )
  }

  /** The current draft with one page of its structured view. */
  editor(
    page: { readonly offset?: number; readonly limit?: number } = {},
  ): ProfileEditorViewModel | undefined {
    const draft = this.#draft
    if (draft === undefined) return undefined
    return freezeBoundedProfileValue({
      source: draft.source,
      ...(draft.profile === undefined ? {} : { profile: draft.profile }),
      rawJson: draft.rawJson,
      ...(draft.saveBlock === undefined ? {} : { saveBlock: draft.saveBlock }),
      unrecognizedFields: draft.unrecognizedFields,
      validation: draft.validation,
      ...(draft.profile === undefined
        ? {}
        : { structured: buildStructuredProfileView(draft, page) }),
    })
  }

  editRaw(rawJson: string): ProfileEditorViewModel {
    if (this.#draft === undefined) throw new Error('Select or import a profile before editing')
    this.#draft = editRawProfile(this.#draft, rawJson)
    return this.editor() as ProfileEditorViewModel
  }

  editStructured(path: string, value: unknown): ProfileEditorViewModel {
    if (this.#draft === undefined) throw new Error('Select or import a profile before editing')
    this.#draft = editStructuredProfile(this.#draft, path, value)
    return this.editor() as ProfileEditorViewModel
  }

  draft(): ProfileEditorDraft | undefined {
    return this.#draft
  }
}

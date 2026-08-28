# Braid component system

## Design vision

Braid is a transcript-first terminal for operating one or many agent runs without hiding identity, capability, or uncertainty.

The main screen keeps the current conversation readable and keeps the composer immediately available.

Secondary work opens in a full-viewport surface or a modal only when the user asks for it.

Concurrent work stays visible through a small Work Strip and a searchable activity view.

Every rendered value comes from one immutable `BraidViewModel` projection.

Every user action emits a typed intent with a stable operation identifier.

Components do not call providers, mutate durable state, or infer unavailable capabilities.

Controllers coordinate focus and presentation, while application services own workflows and side effects.

The selected profile and connection determine the real runner, model, environment, and available actions.

A missing capability stays visible and disabled with one plain reason.

Narrow terminals remove secondary detail before they shorten primary meaning.

Wide terminals add measured context, not permanent side panels.

All untrusted text is sanitized before rendering, and secret values never enter a view model.

## What “best and simple” means

Each component has one user-visible job and one owner for its state transition.

The implementation uses the smallest general contract that works for every provider and runner.

It does not add a provider-specific branch when a capability, view model, or typed intent can express the behavior.

It does not duplicate canonical runtime, replay, interaction, fork, analysis, or supervisor contracts.

It bounds lists, text, and refresh work so the terminal stays responsive as stored history grows.

It fails closed when identity, capability, or response validity is unknown.

It proves keyboard behavior and terminal output at 40×12, 80×24, 120×40, and 200×60.

## Product components

| Product component | Document | Primary user outcome |
| --- | --- | --- |
| Terminal shell and chrome | [terminal-shell.md](terminal-shell.md) | Keep identity, status, input, and cleanup stable around every surface. |
| Transcript and composer | [transcript-composer.md](transcript-composer.md) | Read one branch and submit, queue, or steer without losing a draft. |
| Work Strip | [work-strip.md](work-strip.md) | See and focus concurrent work without a permanent side panel. |
| Multi-run orchestration | [multi-run-orchestration.md](multi-run-orchestration.md) | Run independent branches concurrently while preserving branch order. |
| Retained run lifecycle | [retained-run-lifecycle.md](retained-run-lifecycle.md) | Reconnect, replay, detach, cancel, and recover one exact provider run. |
| Native continuation | [native-continuation.md](native-continuation.md) | Continue the exact provider session at a verified branch boundary. |
| Run stream sanitizer | [run-stream-sanitizer.md](run-stream-sanitizer.md) | Make split provider output safe before durable storage and rendering. |
| Selectors and commands | [selectors-and-commands.md](selectors-and-commands.md) | Find an action or entity through one keyboard contract. |
| Modal coordination | [modal-coordination.md](modal-coordination.md) | Present one bounded decision surface with reliable focus restoration. |
| Conversation navigation | [conversation-navigation.md](conversation-navigation.md) | Create, rename, archive, switch, branch, and clone through explicit identities. |
| Fork preview | [fork-preview.md](fork-preview.md) | Explain exactly what a fork copies before any external mutation. |
| Conversation branch effects | [conversation-branch-effects.md](conversation-branch-effects.md) | Execute portable context transfer and real workspace forks without hidden provider assumptions. |
| Interactions and secrets | [interactions.md](interactions.md) | Answer, decline, cancel, or automate a typed request safely. |
| Profiles and connections | [profiles-and-connections.md](profiles-and-connections.md) | Select a portable agent and a credential-bearing execution connection. |
| Activity | [activity.md](activity.md) | Find live, queued, waiting, detached, and completed work. |
| Entity browser and details | [entity-browser.md](entity-browser.md) | Reuse one list-and-details interaction across complex records. |
| Supervisor graph | [supervision.md](supervision.md) | Inspect worker hierarchy and route supported controls to one worker. |
| Analysis | [analysis.md](analysis.md) | Inspect a cited review of a frozen run without mutating the source. |
| Comparison | [comparison.md](comparison.md) | Compare complete measured fields and asymmetries before a verdict. |
| Automation rules | [automation.md](automation.md) | Reuse safe interaction responses with explicit scope and confirmation. |
| Help and unavailable states | [help-and-capability-states.md](help-and-capability-states.md) | Explain real commands and disabled actions without fake readiness. |
| Safe rendering and responsive layout | [safe-rendering.md](safe-rendering.md) | Preserve terminal integrity and primary meaning at every supported size. |
| Headless and accessible presentation | [headless-and-accessibility.md](headless-and-accessibility.md) | Expose the same application through bounded JSONL and plain text. |

## Concrete component inventory

Every exported terminal component class maps to exactly one product document below.

Helpers remain in the same document as the component whose behavior they serve.

| Code component | Source | Product document |
| --- | --- | --- |
| `AlternateScreenTerminal` | `src/adapters/tui/alternate-screen-terminal.ts` | [terminal-shell.md](terminal-shell.md) |
| `ApplicationUiController` | `src/adapters/tui/application-ui-controller.ts` | [terminal-shell.md](terminal-shell.md) |
| `ActivityBrowserPanel` | `src/views/tui/activity-browser.ts` | [activity.md](activity.md) |
| `ActivityView` | `src/views/tui/activity.ts` | [activity.md](activity.md) |
| `AnalysisViewPanel` | `src/views/tui/analysis.ts` | [analysis.md](analysis.md) |
| `GuardedAutocompleteProvider` | `src/views/tui/autocomplete-guard.ts` | [selectors-and-commands.md](selectors-and-commands.md) |
| `AutomationOverlayWorkflow` | `src/views/tui/automation-overlay-workflow.ts` | [automation.md](automation.md) |
| `AutomationRulePanel` | `src/views/tui/automation-rule-panel.ts` | [automation.md](automation.md) |
| `RuleResponseEditor` | `src/views/tui/automation-rule-response-editor.ts` | [automation.md](automation.md) |
| `CommandPalette` | `src/views/tui/command-palette.ts` | [selectors-and-commands.md](selectors-and-commands.md) |
| `ComparisonViewPanel` | `src/views/tui/comparison.ts` | [comparison.md](comparison.md) |
| `ComposerView` | `src/views/tui/composer-view.ts` | [transcript-composer.md](transcript-composer.md) |
| `ConfigurationCredential` | `src/views/tui/configuration-credential.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `PreparedCredential` | `src/views/tui/configuration-credential.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ResponsiveText` | `src/views/tui/configuration-responsive-text.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConfigurationReview` | `src/views/tui/configuration-review.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConfigurationWizard` | `src/views/tui/configuration-wizard.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConnectionMetadataEditor` | `src/views/tui/connection-metadata-editor.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConnectionOverlayWorkflow` | `src/views/tui/connection-overlay-workflow.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConnectionSetupViewPanel` | `src/views/tui/connection-setup.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ConversationConfirmation` | `src/views/tui/conversation-dialogs.ts` | [conversation-navigation.md](conversation-navigation.md) |
| `ConversationRename` | `src/views/tui/conversation-dialogs.ts` | [conversation-navigation.md](conversation-navigation.md) |
| `ConversationOverlayActions` | `src/views/tui/conversation-overlay-actions.ts` | [conversation-navigation.md](conversation-navigation.md) |
| `ConversationOverlayController` | `src/views/tui/conversation-overlays.ts` | [conversation-navigation.md](conversation-navigation.md) |
| `DetailsViewPanel` | `src/views/tui/details.ts` | [entity-browser.md](entity-browser.md) |
| `DynamicAutocompleteProvider` | `src/views/tui/dynamic-autocomplete.ts` | [selectors-and-commands.md](selectors-and-commands.md) |
| `EntityBrowser` | `src/views/tui/entity-browser.ts` | [entity-browser.md](entity-browser.md) |
| `ForkPreviewPanel` | `src/views/tui/fork-preview.ts` | [fork-preview.md](fork-preview.md) |
| `GraphView` | `src/views/tui/graph.ts` | [supervision.md](supervision.md) |
| `HelpViewPanel` | `src/views/tui/help.ts` | [help-and-capability-states.md](help-and-capability-states.md) |
| `InteractionDecisionList` | `src/views/tui/interaction-decisions.ts` | [interactions.md](interactions.md) |
| `OutcomeKeys` | `src/views/tui/interaction-presentation.ts` | [interactions.md](interactions.md) |
| `SecretInput` | `src/views/tui/interaction-presentation.ts` | [interactions.md](interactions.md) |
| `InteractionShell` | `src/views/tui/interaction.ts` | [interactions.md](interactions.md) |
| `ModalCoordinator` | `src/views/tui/modal-coordinator.ts` | [modal-coordination.md](modal-coordination.md) |
| `ProfileCompatibilityPanel` | `src/views/tui/profile-compatibility.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `ProfileEditorViewPanel` | `src/views/tui/profile-editor.ts` | [profiles-and-connections.md](profiles-and-connections.md) |
| `SafeMarkdown` | `src/views/tui/safe-markdown.ts` | [safe-rendering.md](safe-rendering.md) |
| `MaskedSecretInput` | `src/views/tui/secret-input.ts` | [interactions.md](interactions.md) |
| `SearchableSelector` | `src/views/tui/selector.ts` | [selectors-and-commands.md](selectors-and-commands.md) |
| `BraidTerminalApp` | `src/views/tui/terminal-app.ts` | [terminal-shell.md](terminal-shell.md) |
| `TerminalChrome` | `src/views/tui/terminal-chrome.ts` | [terminal-shell.md](terminal-shell.md) |
| `TerminalCommandController` | `src/views/tui/terminal-command-controller.ts` | [terminal-shell.md](terminal-shell.md) |
| `TerminalDraftController` | `src/views/tui/terminal-drafts.ts` | [transcript-composer.md](transcript-composer.md) |
| `TerminalInputController` | `src/views/tui/terminal-input-controller.ts` | [terminal-shell.md](terminal-shell.md) |
| `TerminalInteractionController` | `src/views/tui/terminal-interaction-controller.ts` | [interactions.md](interactions.md) |
| `TerminalOverlayController` | `src/views/tui/terminal-overlays.ts` | [modal-coordination.md](modal-coordination.md) |
| `BraidShell` | `src/views/tui/terminal-shell.ts` | [terminal-shell.md](terminal-shell.md) |
| `UnavailablePanel` | `src/views/tui/terminal-shell.ts` | [help-and-capability-states.md](help-and-capability-states.md) |
| `TerminalSurfaceOverlays` | `src/views/tui/terminal-surface-overlays.ts` | [modal-coordination.md](modal-coordination.md) |
| `TranscriptView` | `src/views/tui/transcript.ts` | [transcript-composer.md](transcript-composer.md) |

## Change rule

Add a new product component only when it introduces a distinct user job, state owner, or interaction contract.

Add a helper to an existing component when it only renders or coordinates that component's established contract.

Update this inventory and the owning document in the same change as a new exported terminal component class.

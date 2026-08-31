# Profiles and connections

## Job

Profiles and connections select what agent runs and where it runs without mixing portable configuration with credentials.

## Best simple implementation

Use `AgentProfile` as the only agent configuration object.

Treat a runner as one run preference inside that profile.

Store connection metadata separately from credential bytes.

Ask the provider for current capabilities and show exact incompatibilities before save or run.

Use one staged configuration workflow with explicit review and commit.

## Component map

| Component | Responsibility |
| --- | --- |
| `ConfigurationWizard` | Select profile, connection, and cloud workspace request through one staged workflow. |
| `ConfigurationCredential` | Collect a required credential through a bounded secret path. |
| `PreparedCredential` | Hold the commit or rollback capability for a staged secret write. |
| `ConfigurationReview` | Show the effective selection before durable activation. |
| `WorkspaceRequestForm` | Edit the bounded provider-neutral cloud workspace request. |
| `ResponsiveText` | Present configuration detail without breaking narrow layouts. |
| `ProfileEditorViewPanel` | Create or edit canonical profile fields. |
| `ProfileCompatibilityPanel` | Explain supported, ignored, or blocking fields from real capability data. |
| `ConnectionSetupViewPanel` | Select, test, and activate an execution connection. |
| `ConnectionMetadataEditor` | Edit secret-free connection name, kind, endpoint, account, and region. |
| `ConnectionOverlayWorkflow` | Coordinate create, edit, test, select, remove, and credential recovery. |

## Data boundaries

A profile contains portable agent intent, runner preference, model, limits, and policy.

A connection contains secret-free transport and account metadata plus a credential reference.

Credential bytes live only in the operating-system credential facility or their bounded setup path.

`WorkspaceRequest` is an immutable provider-neutral startup selection, not connection metadata.

The local `workspaceRoot` remains separate from the remote provider workspace request.

Only a cloud-workspace provider exposes repository URL, git ref, and remote cwd in setup review.

Repository URLs require HTTPS, contain no credentials, query, or fragment data, and reject literal private hosts.

DNS names are not resolved during validation, so URL policy does not claim protection from DNS rebinding.

Provider-native workspace options never enter startup persistence, receipts, snapshots, or logs.

The active selection records stable profile and connection identifiers.

Each run receipt freezes the exact effective profile, connection, workspace request, and local root used for admission.

The request digest includes both workspace values, so changing either value creates a new admission identity.

## Workflow

Discovery loads available profiles, connections, models, and provider capabilities.

Selection validates the exact profile and workspace request against the selected connection capabilities.

Credential preparation writes through a recoverable staged operation.

Review shows effective runner, model, workspace fields, endpoint label, limits, and compatibility findings without secret values.

Commit saves the workspace request with startup metadata and activates the selection only after validation succeeds.

Rollback removes an uncommitted credential if later persistence fails.

## Failure and safety

Unsupported required fields block activation with the exact field and reason.

Optional unsupported actions remain disabled without weakening the saved profile.

Connection testing has bounded time and response size.

Endpoints are normalized for transport and redacted for display.

Credential removal is serialized, journaled, and recoverable after process interruption.

Recovery replays the workspace request stored in `receipt.requested`.

Legacy receipts without that field replay without a remote workspace request and never inherit current setup values.

Removing a shared credential remains unavailable until no saved connection references it.

## Responsive behavior

Narrow configuration shows the active stage, selected value, blocking reason, and navigation keys.

Standard and wide layouts add descriptions and the effective review summary.

No stage shows a giant default selection or repeats labels already visible in the control.

## Performance

Discovery and validation are asynchronous and cancellable.

Late results carry a generation and cannot replace a newer selection.

Lists use bounded summaries rather than full profile documents.

## Proof

Tests cover create, edit, validate, test, activate, restart, staged credential recovery, shared credential removal, unsupported fields, and secret canaries.

Keyboard proof walks from profile selection through connection review and back without losing state.

## Non-goals

The terminal does not materialize provider-private profile files.

It does not maintain a local runner or model compatibility table.

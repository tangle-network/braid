# Profiles and connections

## Mental model

Braid presents three separate choices.

1. A profile answers “which agent is this?”
2. A connection answers “where and with which account can it run?”
3. Run overrides answer “which runner, model, and effort should this turn use?”

Combining these choices in one hidden model string would destroy profile portability and make execution placement ambiguous.

## Canonical profile

Braid imports `AgentProfile`, `AgentProfileRef`, profile schemas, security helpers, merge helpers, validation types, and harness compatibility helpers from the current `agent-interface` package.

Braid does not define a Braid profile schema.

The structured editor covers every canonical field.

| Group | Canonical fields |
| --- | --- |
| Identity | `name`, `description`, `version`, and `tags` |
| Prompt | system prompt and additional instructions |
| Model | default, small, provider, reasoning effort, and model metadata |
| Runner | optional profile harness preference |
| Access | permissions and enabled tools |
| MCP | local stdio, remote HTTP or SSE, disabled servers, and metadata |
| Hub | connected-account identifiers, allowed capabilities, and aliases |
| Delegation | named subagents, models, tools, permissions, steps, and metadata |
| Resources | generic files, tool files, skills, agents, commands, instructions, executability, and failure policy |
| Hooks | command, timeout, blocking behavior, matcher, and environment |
| Modes | description, model, prompt, tools, permissions, and metadata |
| Confidentiality | TEE choice, attestation challenge, sealed behavior, and refresh requirement |
| Extensibility | metadata and namespaced backend extensions |

Unknown canonical fields introduced by a newer compatible package remain visible and round-trippable through the raw view.

An installed Braid version refuses to save a profile whose schema version it cannot preserve losslessly.

## Profile sources

Braid supports inline profiles, provider catalog identifiers, local canonical profile files, package-provided profiles, and GitHub-backed resources already expressible by `AgentProfileRef` and resource references.

The first release must not invent a remote Braid profile catalog.

Profile source adapters produce the canonical object, source label, immutable source reference when available, source revision, and write capability.

Braid discovers sources in this order for presentation, without merging them automatically.

1. An explicit `--profile` argument or import path.
2. Profiles explicitly listed in trusted workspace `.braid/config.json`.
3. Profiles explicitly listed in user Braid configuration.
4. Provider-named profiles returned when `profile.namedProfiles` is true.
5. Recently used profile references that still resolve.

Discovery never recursively scans a home directory or executes a profile file as code.

Executable TypeScript or JavaScript profile modules are not loaded in the main Braid process.

If code-defined profiles are supported, they resolve in a restricted helper process and must emit a validated serializable `AgentProfile` with no credential access.

## Selection precedence

Selection chooses one base profile rather than field-merging unrelated discovered profiles.

The selected base profile follows this precedence.

1. Explicit command-line selection for the current launch.
2. Existing branch selection.
3. Trusted workspace default.
4. User default.
5. First-run selection.

Runner, model, effort, mode, and connection are separate run overrides.

The effective runner follows explicit next-run override, branch override, profile harness preference, then canonical preferred-runner helper.

The effective model follows explicit next-run override, branch override, then profile default.

The effective effort follows explicit next-run override, branch override, then profile reasoning effort.

The effective connection follows explicit next-run selection, branch selection, trusted workspace default, then user default.

An explicit user action may create a derived profile using the canonical `mergeAgentProfiles` helper, but the preview must show every changed path and the result is saved as a new profile source or explicit overwrite.

Braid never stores run overrides back into the source profile without `Save to profile` and a diff confirmation.

## Profile resolution and snapshot

Before admission Braid performs the following operations.

1. Resolve the selected profile reference through its source adapter.
2. Validate the serializable value with the current canonical schema.
3. Resolve permitted remote resources through the current shared resource resolver with explicit network and workspace policy.
4. Ask the selected provider to validate the profile against live capabilities.
5. Apply only explicit run overrides through canonical helpers.
6. Show normalization, snapping, ignored selectors, warnings, errors, and unsupported dimensions.
7. Canonicalize the effective redacted value and compute its SHA-256 digest.
8. Commit the source reference, source revision, canonical snapshot, digest, capabilities, validation result, and overrides before dispatch.
9. Attach the provider's post-materialization receipt after admission.

Provider normalization is visible as a diff against the selected snapshot.

An error blocks admission.

A warning permits admission only when provider validation explicitly classifies it as non-fatal and the user or a recorded workspace policy accepts that exact warning code.

An informational issue does not require confirmation but remains in the run receipt.

Braid never locally guesses whether dropping a field is safe.

## Runner, model, and effort selection

The runner selector is populated from the canonical harness type and live connection capabilities.

The selector does not advertise a runner merely because its name exists in the type union; the chosen connection must prove it can execute it.

For each runner Braid uses current canonical helpers to determine model support, preferred runner, model snapping, runner snapping, available reasoning efforts, and whether model, effort, or selectors are honored.

A snapped value is displayed as a proposed effective value with the original value beside it.

The user can accept the one-run snap, choose another value, select another runner, or cancel.

Braid never silently increases reasoning effort and never turns reasoning on when the requested effort is `none`.

When a runner ignores model or effort, the status line labels the field `runner-controlled` and the run receipt stores the ignored override.

Model discovery results are connection-scoped, carry a retrieval time and source, and refresh without replacing an active user selection by list position.

## Profile picker

Each row shows profile name, description, version, tags, source, last validation result, and last used runner when available.

Rows with the same display name remain distinct by source and digest.

Search covers name, description, tags, source, runner preference, tool, skill, and connection capability.

Selecting a profile opens a compact effective-run preview before changing an active branch.

The preview shows identity, prompt summary, runner/model/effort, permission summary, tool count, MCP and Hub connections, subagents, resources, hooks, modes, confidentiality, source, digest, validation, and unsupported dimensions.

Raw prompt and secret-bearing fields remain folded until explicitly inspected.

## Profile editor

The structured and raw views edit one in-memory canonical draft.

Changes in either view validate immediately and preserve cursor and folded state when switching views.

The editor distinguishes schema errors, provider errors, security warnings, and style suggestions.

The permission editor makes inherited object policies and exact tool keys visible.

MCP command, argument, environment, working-directory, URL, and header fields are treated as security-sensitive and receive a resolved execution preview.

Hub connection capabilities are selected from the authenticated Hub contract rather than typed as unchecked strings when discovery is available.

Resource references preview immutable repository, ref, path, content digest, destination, mode, and conflict behavior.

Confidential settings explain that a request is not proof of confidential execution and that attestation evidence must be verified after placement.

Save writes to a temporary sibling with restrictive permissions, validates the written bytes, fsyncs, and atomically renames without following a planted symlink.

An external file modification since editor open produces a three-way diff and never overwrites silently.

Read-only, package, and provider-catalog profiles can be saved only as a new local profile.

## Profile import and export

Import accepts a local file, stdin, pasted canonical value, or immutable repository resource supported by the source adapter.

Import validates before adding the source reference to configuration.

An imported profile with local paths shows each resolved path relative to the profile source and workspace.

Export emits canonical JSON by default, with optional source-format preservation when lossless.

Export redacts credential values, secret environment values, confidential challenge material when classified secret, and runtime receipts that may contain secrets.

Export includes a machine-readable profile digest and schema package version.

## Connection model

A connection is a Braid record containing non-secret metadata and an opaque credential reference.

```ts
type ConnectionKind = 'cli-bridge' | 'tangle-inference' | 'tangle-sandbox'

interface ConnectionRecord {
  id: string
  kind: ConnectionKind
  name: string
  endpoint?: string
  credentialRef?: string
  providerOptions: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastHealth?: ConnectionHealth
}
```

This record is a Braid storage type, not a replacement for provider configuration types.

Provider options are validated by the current adapter before save and unknown sensitive values are not accepted into the generic record.

The saved connection catalog owns endpoint, kind, account, and credential-reference identity; journal replay may contribute only newer health observations when kind, workspace, endpoint, credential reference, and provider options still describe the same execution target.

JSONL can update secret-free metadata but cannot replace or remove an existing credential reference.

Credential replacement always uses the masked secure-storage flow.

## CLI Bridge connection

The setup view accepts endpoint, optional masked bearer credential input, default execution mode, and health timeout.

Every non-loopback CLI Bridge requires protected authentication before setup can persist it, even when its unauthenticated health response is healthy or unknown.

The default local endpoint must be loopback and first-run discovery rejects unencrypted non-loopback endpoints before sending health, model, or authorization requests.

A programmatically supplied non-loopback cleartext connection remains unavailable unless the product supplies an explicit trusted transport policy.

Setup calls bridge health, current model discovery, and provider capability checks.

Detected local bridge processes are suggestions and are not trusted until endpoint and authentication checks pass.

The runner list comes from live bridge model discovery and current provider support.

The effective model sent to the provider remains `<runner>/<model>` according to the provider adapter rather than hand-built in a view.

Catalog discovery therefore maps `pi/tangle-router/glm-5.2` to profile runner `pi` plus profile model `tangle-router/glm-5.2`; the connection route never becomes profile identity.

Startup configuration schema 2 stores that portable model, while schema-1 configurations generated by earlier Braid builds remove one matching runner prefix during load and reject a prefix that names another runner.

After setup applies the selected profile and connection, the same composer can send immediately through the replacement production application; restart is not required.

The run details retain bridge run identifier, provider session identifier, event cursor, execution placement, bridge version, runner version, and profile materialization receipt.

If the provider adapter reports detach false, Braid blocks detached exit for that run even when the raw bridge server could survive a socket disconnect.

## Tangle inference connection

The setup view accepts the current Tangle authentication method, endpoint or network selection when exposed by the provider, account or team context, and routing preferences supported by the runtime.

Braid does not store a model-provider API key inside an `AgentProfile`.

Model and route discovery come from the current runtime/provider API and are cached only as non-authoritative metadata.

The run preview distinguishes inference routing from sandbox placement and does not claim a workspace exists.

Usage and cost display only provider-reported values and label unavailable pricing.

## Tangle sandbox connection

The setup view accepts the current Tangle authentication method, account or team context, endpoint when configurable, and default non-secret placement preferences.

Workspace creation may specify environment or image, repository and Git ref, working directory, resources, provider options, and explicit secret references through the shared provider contract.

The setup preview shows repository, ref, image or environment, CPU, memory, disk, region when selectable, network policy, confidentiality request, and secret names without values.

Connection health proves authentication and provider reachability but does not create a sandbox.

A separate one-environment smoke proves create, prompt, replay, workspace operations, checkpoint, fork, and destroy in release verification.

Attestation status is displayed only after cryptographic verification through the current confidential-execution contract.

## Connection picker

Each connection row shows name, kind, endpoint or network, account context, health, last check time, and capabilities relevant to the selected profile.

The picker tests health only on explicit refresh or a bounded stale interval and never blocks navigation on every open.

Unauthorized, unreachable, incompatible, rate-limited, and healthy are distinct states.

Selecting a connection with a running branch affects only the next run or a new branch and does not move the existing provider session.

Removing a connection lists conversations, active runs, environments, and credential references that depend on it.

An active or detached run blocks removal unless the user first rebinds the metadata reference or acknowledges loss of control.

Removing a connection never destroys a cloud environment automatically.

Before metadata removal, Braid writes a private credential-cleanup record containing only opaque references and the mapping mode needed to validate them after restart.

One per-config process lock spans reference checks, saved-catalog publication, journal commit, protected deletion, and cleanup-record removal, so concurrent connection changes fail without displacing an earlier obligation.

Successful removal deletes an unshared credential after the journal and saved catalog commit; a process restart retries an interrupted deletion, while any surviving shared reference prevents deletion.

Custom credential mappings fail closed when their resolver is unavailable, mismatched durable and protected references retain the cleanup record, and a native keyring false-return is accepted only after a read proves the credential is absent.

## Workspace trust

Braid keys a workspace by canonical repository root and repository identity when available, otherwise by canonical absolute path.

A new workspace starts untrusted for project configuration, executable hooks, local MCP commands, profile resource writes, and environment-variable references.

Trust confirmation previews every project-controlled Braid file and executable profile capability that would become active.

Trust is stored by workspace identity and configuration digest so a material change can require review.

Opening an untrusted workspace still permits a user-selected external profile with safe provider policy.

Symlinks, path traversal, device files, FIFOs, world-writable profile sources, and repository changes during materialization are handled according to the security plan.

## Permissions and secrets in profiles

`allow`, `ask`, and `deny` values remain distinct and Braid does not broaden object policies into a global allow.

An absent permission is interpreted only by provider validation and never displayed as allowed by Braid.

Secret MCP environment values, remote headers, hook environment values, provider keys, and workspace secrets must use explicit secret references before persistence.

Where the installed canonical schema accepts `AgentProfileConfigValue`, Braid emits `AgentProfileSecretRef` and resolves it only through the private `AgentProfileSecretProvider` execution path.

If the canonical profile field currently accepts only a raw string, Braid either keeps the profile ephemeral and warns before run or requires an upstream secret-reference type before durable save.

A value is classified as protected only when Braid stores an opaque credential reference and the credential adapter confirms protected storage; masking plaintext in a view does not qualify.

## Run receipt

Every admitted run exposes one immutable receipt containing the following data.

- Braid version and build digest.
- Canonical profile package version, source reference, source revision, effective snapshot, and digest.
- Connection identifier and kind without credential value.
- Reported provider capabilities and profile validation result.
- Requested and effective runner, model, effort, mode, and selectors.
- Workspace request, environment identifier, placement, and checkpoint when present.
- Runtime run, provider session, turn, branch, and operation identifiers.
- Provider and server versions when reported.
- Materialization digest, generated paths and modes, unsupported dimensions, and normalized values.
- Start, first-event, interaction, terminal, and receive timestamps.
- Usage, cost, outcome, replay cursor, and completeness state.

Linked pre-admission and post-admission records retain the exact requested values and failure boundary even when dispatch never starts.

## Profile and connection acceptance

| ID | Required proof |
| --- | --- |
| PC-01 | Every field in the installed `AgentProfile` schema round-trips through structured and raw editors without loss. |
| PC-02 | Unknown extension namespaces round-trip, while an unknown non-preservable schema blocks save. |
| PC-03 | Selection and override precedence passes a complete table test covering command line, branch, workspace, user, and profile defaults. |
| PC-04 | Canonical harness helpers determine every runner, model, effort, snap, and ignored-selector state; no Braid compatibility table exists. |
| PC-05 | Provider validation errors block admission and accepted warning codes are captured in the immutable run receipt. |
| PC-06 | A real CLI Bridge run proves exact profile materialization and matches the displayed materialization receipt digest and generated paths. |
| PC-07 | A real Tangle sandbox run proves inline profile delivery, placement, workspace request, capability capture, and immutable snapshot digest. |
| PC-08 | Credential scanning of configuration, database, logs, exported profile, screenshots, traces, and diagnostic bundle finds zero seeded secret values. |
| PC-09 | Atomic save tests cover concurrent modification, symlink replacement, partial write, invalid written bytes, and read-only source. |
| PC-10 | Workspace trust tests prove project configuration, hooks, local MCP, and resource writes remain inactive before digest-bound approval. |
| PC-11 | Connection health distinguishes healthy, unauthorized, unreachable, incompatible, and rate-limited outcomes without creating external resources. |
| PC-12 | Removing a connection cannot silently cancel a run, destroy an environment, orphan an unacknowledged secret reference, erase historical receipts, lose a concurrent cleanup obligation, or delete through an unverified credential mapping. |

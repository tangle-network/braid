# Braid 0.3.2 release notes

Upgrade from 0.3.0 or 0.3.1.

## Security

- Credentials stored before origin binding require authentication through `braid --reauthenticate`.
  Braid no longer guesses their destination from a default endpoint or a loopback address.
- Startup credentials cannot follow an endpoint edited in workspace configuration.
  CLI Bridge discovery, model validation, and setup preserve the trusted startup origin.
- Redaction preserves secret boundaries for long bearer values, quoted values with escaped quotes, and credential URLs containing Unicode.
  Release proof captures use the same sanitizer as Braid.
- CLI Bridge model credentials stay on the selected origin.
  Credential-bearing requests reject redirects.

## Fixed

- Public RPC types match queue targets and require operation identifiers for run control.
- GitHub releases retain their versioned release notes when the workflow runs again.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.2
```

If an existing connection reports `CONNECTION_CREDENTIAL_REAUTH_REQUIRED`, run this command in the same workspace:

```bash
braid --reauthenticate
```

Keep the same `--config` and `--database-key-file` options when you use those options.
Select the existing profile and connection, then enter its credential in the masked prompt.
Review the destination before applying.
Cancel leaves the saved configuration unchanged.
The command keeps the existing conversation database.

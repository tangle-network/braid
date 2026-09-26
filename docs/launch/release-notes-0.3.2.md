# Braid 0.3.2 release notes

Upgrade from 0.3.0 or 0.3.1.

## Security

- Credentials stored before origin binding require authentication through setup.
  Braid no longer guesses their destination from a default endpoint or a loopback address.
- Startup credentials cannot follow an endpoint edited in workspace configuration.
  CLI Bridge discovery, model validation, and setup preserve the trusted startup origin.
- CLI Bridge model credentials stay on the selected origin.
  Credential-bearing requests reject redirects.

## Fixed

- Public RPC types match queue targets and require operation identifiers for run control.
- GitHub releases retain their versioned release notes when the workflow runs again.

## Upgrade

```bash
npm install --global @tangle-network/braid@0.3.2
```

If an existing connection reports `CONNECTION_CREDENTIAL_REAUTH_REQUIRED`, authenticate it again through setup.
The upgrade preserves saved conversations.

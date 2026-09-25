# Braid 0.3.1 release notes

0.3.1 is a security release.
Upgrade from 0.3.0.

## Security

- **Secret redaction covers quoted, escaped, and prefixed names.**
  0.3.0 did not redact values such as `{"token":"…"}`, `{\"api_key\":\"…\"}`, or `TANGLE_API_KEY=…`.
  Those values could reach the journal and stream subscribers.
  Batch and streaming redaction now use one recognizer.
  Streamed text is released one complete line at a time, so a chunk boundary cannot separate a secret name from its value.
- **A stored credential is bound to its endpoint origin.**
  In 0.3.0, an edited endpoint in the workspace configuration received the existing credential.
  Setup now stores the origin with the secret in the operating-system credential store.
  Braid releases the secret only to that origin.
  If an endpoint origin changes, run setup again to authenticate the new endpoint.
  A credential stored by 0.3.0 keeps working on the default Tangle origin for its connection kind, or on a loopback CLI Bridge.

## Fixed

- The README shows the `.braid/profile.json` that a clean workspace needs before the first run.
  0.3.0 setup found no profile in a clean workspace and could only exit.

## Upgrade notes

- A connection with a custom, non-loopback endpoint and a credential stored by 0.3.0 reports that it needs authentication.
  Run setup for that connection once.

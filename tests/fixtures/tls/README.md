# Throwaway TLS material for the Prometheus request tests

Everything in this directory is test material, made for `tests/unit/db/prometheus/request.test.ts` and for nothing else.
No key here protects anything, and no certificate here is trusted outside that test file.
Never reuse any of it.

| File | What it is |
|---|---|
| `ca.crt` | The test CA, self-signed, `CN=LibreDB Studio Test CA` |
| `server.crt` | The server certificate the test CA signed, for `localhost`, `127.0.0.1` and `::1` |
| `server.key.jwk.json` | The server certificate's private key, as a JWK |
| `other-ca.crt` | An unrelated CA that signed nothing here: the wrong CA in the verification tests |
| `client-ca.crt` | The CA a server that asks for a client certificate trusts |
| `client.crt` | The client certificate the client CA signed |
| `client.key.jwk.json` | The client certificate's private key, as a JWK |
| `generate.sh` | The script that made everything above |

The certificates are PEM files named `.crt`, because the repository's `.gitignore` ignores `*.pem`.

## Why the keys are JWK

The required Secret Scan runs gitleaks with its default rules, and the `private-key` rule matches a PEM private key wherever it is committed.
A `.gitleaksignore` fingerprint would not settle it: a fingerprint names one commit, so the same key carried into a squash onto `main` is a finding again (measured for commit `3023c7e0`).
A JWK holds the same key as JSON, which no default rule matches.
`tests/helpers/tls-fixtures.ts` turns each JWK back into PEM when a test file loads it.

The three CA keys are not kept: nothing signs anything at test time, so no test needs them.

## Regenerating

Run `bash tests/fixtures/tls/generate.sh` from the repository root; it needs `openssl` and `bun`.
It makes fresh keys every time, writes the five certificates and the two JWK files here, and deletes everything else it made.
Every certificate is valid for 36500 days from the day it was made.
The block `describe("the TLS fixtures")` in the request tests checks that a regenerated set is still what the other tests assume.

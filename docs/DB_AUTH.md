# Database auth layer (`src/lib/db/auth`)

This is how a database connection signs in to a cloud service, such as Google's token endpoint or its metadata server; it is not Studio's user sign-in (`src/lib/auth.ts`, OIDC, passkeys, OpenShift).

The layer holds one implementation of each cloud's sign-in mechanism, outside every provider directory.
Policy stays with each provider and is declared, never inferred: which credential kinds it accepts, whether and when it may use the server's own identity, its opt-in variable, its scope and its own refusal sentences.
Nothing in the layer consults a provider's type to pick an auth, and there is no default list, no registry and no base class.

## Use it

A provider imports the shared functions and passes a rules object it declares.
Every field that changes who or what may sign in is required.
By convention, a provider that calls a shared resolver with a rules object declares that object in its own `credential-policy.ts`.
A provider that only calls shared mechanism without a rules object needs no such file.

Imports name the file, such as `@/lib/db/auth/google/credentials`: the layer has no `index.ts`.

## Extend it

There are three ways, all explicit:

1. Values in the rules object: the accepted kinds, the server-identity gate (its opt-in name and the provider's three sentences), the quota-project rule and the provider label.
2. Composition around the call: the provider runs its own checks before or after the shared one, such as an emulator rule that runs before the credential is resolved.
3. Injected seams: the environment, files, clock, deadlines and the transport factory come in as parameters, so a provider wires its own effects and tests fake them.

Subclassing, overriding, monkey-patching, a branch on a type id inside the layer, a lookup table keyed by provider, and reaching the server's own identity around the gate are not allowed.
A need two providers share becomes a new kind, source or option in the shared module, used only by a provider whose rules list it.
A new optional field is allowed only when its absence means the narrower behaviour, and its docblock says so.

A provider whose engine has its own sign-in scheme writes it in its own directory, but never a second copy of a shared mechanism: the Google grants and token endpoint, the metadata path, or the SigV4 core.

## Root pieces

| File | What it holds |
| --- | --- |
| `server-identity-gate.ts` | `isServerWritten`: the one definition of a server-written connection; `admitServerIdentity`: the server's own identity only for a server-written connection whose provider opt-in (a variable ending in `_SERVER_CREDENTIALS`) is exactly `"true"`; it reads nothing but that one variable |
| `lanes.ts` | `authLaneOptions`: the transport options of every request to a credential endpoint, imported only inside the layer |
| `refresh.ts` | `createRefreshingValue`: a cached expiring value with an early refresh, one shared refresh on its own deadline, and `close()` |

`managed` exactly true is set only on the server side: the operator's seed file, the governance control plane or a discovery source.
Every record a browser sends reaches a provider with `managed: false`.
`managed: true` does not mean the server side wrote the credential text: a literal-mode seed file is written by a platform from data its users control.
So Studio sets `LITERAL_SEED_FILE` (`src/lib/types.ts`), a symbol key no file or request body can carry, on every row of a seed file read in literal mode (`SEED_LITERAL_VALUES`), and on no discovered, sample or governed row.
A connection is server-written when `managed` is exactly true and the record does not carry that marker; `isServerWritten` is the one definition, and `admitServerIdentity` is its reader.
Server identity is admitted only on a server-written connection whose provider's opt-in is exactly `"true"`, never on `managed` alone.
The gate refuses with the provider's `unmanaged` sentence when `managed` is not exactly true, with its `literalSeedFile` sentence when the record carries the marker, and then with its `withoutOptIn` sentence; it reads the opt-in only after the first two checks pass.
The provider cache key frames the marker, so a provider opened before literal mode was switched on is never served to a row that carries it.

An auth lane has one socket, checks TLS against its origin's host when the origin is https, fails a 101 answer at once, and refuses link-local addresses unless it is a metadata endpoint, which lives at one.
Only the layer builds an auth lane, so no provider can turn the link-local refusal off for an origin it chose.
Every auth request goes through the transport factory a provider passes, which is `createNodeTransport` in production, so the egress guard, the refusal of redirects and proxies, and the byte caps apply to it.

### Shared refresh

`createRefreshingValue` holds one expiring value for one connection, such as an access token or a temporary database password.
It is given the refresh function, the early-refresh margin `earlyMs`, the clock, the deadline factory and the sentence it raises once closed; it keeps no module-level state.

- A cached value is served while the clock reads earlier than `expiresAt - earlyMs`; from that instant the next `get()` refreshes.
- Concurrent callers share one refresh, which runs on its own 30-second deadline combined with `close()`, so no caller's abort fails the others.
- A caller's own abort rejects only that caller: as a timeout when its signal's reason is a `TimeoutError`, otherwise as cancelled.
- A failed refresh caches nothing, so the next `get()` refreshes again.
- A refresh is given a `RefreshRun`: its `signal`, which every request of the refresh takes, and `throwIfClosed()` for a step that takes no signal, such as signing.
- `throwIfClosed()` reads `close()` alone, so a deadline that fires during such a step surfaces as the timeout of the next request, never as closed.
- `close()` aborts a refresh in flight, drops the value, and makes every later `get()` reject as closed with the given sentence.

There is no synchronous read of the value: every consumer awaits `get()`.

## Transport facts the signer relies on

A request signer, such as a SigV4 one, signs what `src/lib/db/http/node-transport.ts` sends, so it relies on these facts of both transports, held by `tests/unit/db/http/node-transport-text-signer.test.ts` and `tests/unit/db/http/node-byte-transport.test.ts`.

- A transport signs only when it is built with a `signer`; without one it sends exactly what it sent before signing existed.
- The signer is called once per request, synchronously, when a socket is free and just before the request is written, so a clock or a credential it reads is read at send time.
- It is handed the method (GET or POST on the text transport, GET or HEAD on the byte transport), the Host, the path, the query, the headers and the body.
- The Host is `originHost(origin)`, and with a signer the transport sets the Host header itself, so the Host signed is the Host sent.
- The query is the one sent, without `?`, in the caller's order; the transport never reorders it, so a signer that needs a canonical query sorts the pairs itself.
- The headers are every header the transport sets except the signer's own, with lower-case names, in a frozen copy; on a text request with a payload they include `content-type` and `content-length`.
- The runtime appends `Connection: keep-alive`, and `Content-Length: 0` on a POST with no payload, after the signer runs; neither is in the headers it is handed, and neither must be signed.
- The body is the exact payload text written, `""` for none, and always `""` on the byte transport.
- A connection header named in two spellings is refused when the transport is built, so the signer sees one unambiguous set.
- The signer returns only names from its own closed `headerNames` list: `authorization` is the one name the transport owns that it may return, and it never returns a `content-` or `proxy-` name, a connection header or a request's own header.
- Each value it returns is visible ASCII or space of at most 8192 bytes, so an AWS session token fits, while a request's own header values stay at 1024 bytes.
- An `Error` the signer throws reaches the caller unchanged and nothing is sent; a signer that cancels its own request sends nothing either.
- `jsonContentType` sends a JSON body as `application/json` (the default when absent), `application/x-amz-json-1.0` or `application/x-amz-json-1.1`; any other value is refused when the transport is built.

## Google

`google/credentials.ts` reads a credential and `google/token-source.ts` turns it into access tokens, with no Google SDK.

### Credential kinds

| Kind | Pasted as | Secrets withheld from errors |
| --- | --- | --- |
| `service_account` | A service-account key JSON: non-empty `client_email` and a PKCS #8 PEM `private_key`; `private_key_id`, when present, becomes the assertion's `kid` | The private key, then the key id |
| `authorized_user` | An authorized-user JSON: non-empty `client_id`, `client_secret` and `refresh_token`; `quota_project_id`, when present, must pass the provider's rule and is sent as `x-goog-user-project` | The client secret, then the refresh token |
| `access_token` | A bare token, or one after `Bearer `, of 20 URL-safe characters or more | The token |
| `metadata` | Never pasted: the server's own identity through the metadata server | None |

A pasted text is trimmed; JSON text loses its line feeds and carriage returns before it is parsed, as the browser's password input removes them.
Every other field of a credential JSON is dropped, `token_uri`, `auth_uri` and `universe_domain` included, so no credential names an endpoint.
A kind the parser knows and the provider's rules do not list is refused as unsupported, before any of its fields is read.
The refusal sentences word the accepted kinds in a fixed order (service account, authorized user, access token), so a provider's list order changes no sentence.

### Server identity

A non-blank pasted credential always wins.
A blank one goes through the gate, then the Application Default Credentials chain: the file `GOOGLE_APPLICATION_CREDENTIALS` names (an unreadable one is an error), gcloud's well-known file under `HOME` or, on Windows, `APPDATA` (absent, `ENOENT` or `ENOTDIR`, moves on; any other read failure is an error), then the metadata server at `metadata.google.internal` or at `GCE_METADATA_HOST`, validated as a host with an optional port and no scheme.
The chain reads those four variables and nothing else, and its reader is not exported: `resolveGoogleCredential`, which runs the gate first, is the only way to it.
A provider passes `resolveGoogleCredential` the connection record it was given, never a copy built field by field, so the `LITERAL_SEED_FILE` marker reaches the gate and a keyless row of a literal-mode seed file is refused before any request.
A blank value of any of the four counts as unset.
`createGoogleTokenSource` takes whatever credential it is given, so a provider passes it only what `resolveGoogleCredential` returned and never builds a `metadata` credential itself.
The ADC file accepts the JSON kinds the provider lists; an access token is never a file kind.

### Tokens

| Kind | Request |
| --- | --- |
| `service_account` | A JWT-bearer grant: an RS256 assertion for the provider's scope, posted to `https://oauth2.googleapis.com/token` |
| `authorized_user` | A refresh-token grant with no scope, posted to the same endpoint |
| `metadata` | `GET /computeMetadata/v1/instance/service-accounts/default/token?scopes=<scope>` with `metadata-flavor: Google` |
| `access_token` | None: the pasted token is returned as is, and `close()` does nothing |

Each refreshing kind has one strategy in a typed table, so a kind without a strategy does not compile.
A lane is built on the first refresh that needs it, at most one per kind, and a pasted access token builds none.
`quotaProjectHeaders` gives the `x-goog-user-project` header for the provider's own API requests; no token request carries it.
A token is held by the shared refresh: cached and refreshed 60 seconds before it expires; concurrent callers share one refresh, which runs on its own 30-second deadline, so no caller's abort fails the others; a failed refresh caches nothing.
An answer without a usable `expires_in` lives Google's documented one hour.
A refusal reports `error_description`, then `error`, then `HTTP <status>`; a reason quoted from the server is withheld whole when it holds any form of the credential's secrets, and is then cut to 300 characters.
`close()` aborts a refresh in flight, drops the token, closes every lane, and makes every later call fail as closed.

## AWS

`aws/sigv4.ts` is the SigV4 core, with no AWS SDK: `signatureV4` computes the `Authorization` value of a canonical request for a key pair and a scope, `amzDateOf` writes the signing date, `canonicalQueryOf` sorts a query into its canonical order with `compareEncodedPairs`, and `EMPTY_PAYLOAD_SHA256` is the payload hash of an empty body.
It is tested on the 24 AWS SigV4 suite vectors and the smithy vector.
The core holds no signing policy: which headers are signed, the payload hash and the service name belong to the caller that builds the canonical request, such as S3's `s3Signer` ([providers/s3.md](providers/s3.md)).
Only the keys a caller passes sign: the module reads no environment variable, no file and no instance metadata.
It is the only file of the layer that imports `node:crypto`.

## Guards

`tests/unit/db/auth/seam-guard.test.ts` holds the layer's lines, each proven both ways with a planted violation:

- AUTH1: a file of the layer imports only `jose`, `node:crypto` (in `aws/sigv4.ts` alone), `@/lib/db/errors`, `@/lib/db/http/*`, `@/lib/db/utils/*`, `@/lib/types` and files of the layer.
- AUTH2: no `process.env`, `Date.now`, `new Date()` without an argument, timers, `AbortSignal.timeout` or console.
- AUTH3: no external engine's type id, comments included.
- AUTH4: no module state: top-level code is a closed list of declarations and frozen literals.
- AUTH5: under `src/`, only providers and the layer import the layer, and only the layer imports `lanes.ts`.
- AUTH6: the mechanism markers (the Google token host, the JWT-bearer grant, the metadata path, and SigV4's `AWS4-HMAC-SHA256` and `aws4_request`) appear under `src/` only in the layer.
  Its exception list is empty; a copy that must stay outside the layer for a while is listed there with its line count and the PR that removes it.

`tests/unit/lib/governance/preflight.test.ts` checks that governance mode refuses every server-identity opt-in a literal under `src/` names, so a new opt-in without a preflight row fails the build.

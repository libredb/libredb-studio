# Security Posture

What LibreDB Studio actually implements, and what it does not. Every row that claims a control
names the file that enforces it and the test that fails when it breaks; `bun run security:check`
runs in CI and fails the build when a row points at something that does not exist, or does not run,
or when a security test exists that no row accounts for.

For **reporting a vulnerability**, the disclosure timeline, supply-chain details and the SBOM, see
[SECURITY.md](../SECURITY.md) in the repository root. This page is the inventory; that one is the
policy.

## Scope

The deployment in scope is **self-hosted, standalone Studio**. There is one trust boundary and the
operator is the owner. The adversary this list is built against is an unauthenticated attacker on
the internet, because most of the distribution channels put the app on a public address.

Two consequences worth stating before the table:

- **Running arbitrary SQL is the product's purpose**, not a vulnerability. What is in scope is SQL
  the application composes itself — schema browsing, identifiers, pagination, filters.
- **The browser copy of your credentials is not encrypted.** See "Known limits" below. It is the
  reason the cross-site scripting controls are the highest-leverage entries in the table.

## Controls

| ID | Control | Status | Enforced in | Verified by |
|---|---|---|---|---|
| 0.1 | LLM output never becomes an HTML string; the renderer builds React elements | Implemented | [`src/components/DatabaseDocs.tsx`](../src/components/DatabaseDocs.tsx) | [`tests/security/xss-sinks.test.tsx`](../tests/security/xss-sinks.test.tsx) |
| 0.2 | No remote origin can be fetched through the image optimizer | Implemented | [`next.config.ts`](../next.config.ts) | [`tests/security/image-proxy.test.ts`](../tests/security/image-proxy.test.ts) |
| 0.3 | Every route that reaches a database or an LLM verifies its caller in its own handler — a user session, or for the one machine callback a server-minted single-purpose credential | Implemented | [`src/lib/api/require-session.ts`](../src/lib/api/require-session.ts), [`src/lib/agent/drive-token.ts`](../src/lib/agent/drive-token.ts) | [`tests/security/route-auth.test.ts`](../tests/security/route-auth.test.ts), [`tests/api/agent/drive.test.ts`](../tests/api/agent/drive.test.ts) |
| 0.4 | The security policy states only what the code does | Implemented | [`SECURITY.md`](../SECURITY.md) | [`tests/unit/security-check.test.ts`](../tests/unit/security-check.test.ts) |
| 0.5 | A published reporting channel with a stated response time | Implemented | [`SECURITY.md`](../SECURITY.md) | [`tests/security/vulnerability-disclosure.test.ts`](../tests/security/vulnerability-disclosure.test.ts) |
| 0.6 | The host and port of an HTTP-based database connection address only that server and the transport's own paths, and no such transport follows a redirect | Implemented | [`src/lib/db/http/endpoint.ts`](../src/lib/db/http/endpoint.ts), [`src/lib/db/providers/sql/clickhouse/http-transport.ts`](../src/lib/db/providers/sql/clickhouse/http-transport.ts), [`src/lib/db/providers/sql/druid/http-transport.ts`](../src/lib/db/providers/sql/druid/http-transport.ts), [`src/lib/db/providers/sql/search/http-transport.ts`](../src/lib/db/providers/sql/search/http-transport.ts), [`src/lib/db/providers/sql/trino/http-transport.ts`](../src/lib/db/providers/sql/trino/http-transport.ts), [`src/lib/db/providers/sql/libsql/hrana-transport.ts`](../src/lib/db/providers/sql/libsql/hrana-transport.ts), [`src/lib/db/providers/document/couchbase/http-transport.ts`](../src/lib/db/providers/document/couchbase/http-transport.ts), [`src/lib/db/providers/timeseries/prometheus/index.ts`](../src/lib/db/providers/timeseries/prometheus/index.ts), [`src/lib/db/providers/timeseries/prometheus/request.ts`](../src/lib/db/providers/timeseries/prometheus/request.ts) | [`tests/unit/db/http/endpoint.test.ts`](../tests/unit/db/http/endpoint.test.ts), [`tests/unit/db/clickhouse/http-transport.test.ts`](../tests/unit/db/clickhouse/http-transport.test.ts), [`tests/unit/db/druid/http-transport.test.ts`](../tests/unit/db/druid/http-transport.test.ts), [`tests/unit/db/search/http-transport.test.ts`](../tests/unit/db/search/http-transport.test.ts), [`tests/unit/db/trino/http-transport.test.ts`](../tests/unit/db/trino/http-transport.test.ts), [`tests/unit/db/libsql/hrana-transport.test.ts`](../tests/unit/db/libsql/hrana-transport.test.ts), [`tests/unit/db/couchbase/http-transport.test.ts`](../tests/unit/db/couchbase/http-transport.test.ts), [`tests/unit/db/prometheus/provider-endpoint.test.ts`](../tests/unit/db/prometheus/provider-endpoint.test.ts), [`tests/unit/db/prometheus/request.test.ts`](../tests/unit/db/prometheus/request.test.ts) |
| 1.1 | Every document response carries CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy; the asset paths the middleware skips carry the two of those that act on a subresource | Implemented | [`src/lib/security/headers.ts`](../src/lib/security/headers.ts), [`src/lib/security/config.ts`](../src/lib/security/config.ts), [`src/proxy.ts`](../src/proxy.ts) | [`tests/security/headers.test.ts`](../tests/security/headers.test.ts), [`tests/security/header-delivery.test.ts`](../tests/security/header-delivery.test.ts), [`tests/security/cross-origin-headers.test.ts`](../tests/security/cross-origin-headers.test.ts), [`e2e/security-headers.spec.ts`](../e2e/security-headers.spec.ts) |
| 1.2 | Login, AI and database-reaching routes are rate limited | Implemented | [`src/lib/api/rate-limit.ts`](../src/lib/api/rate-limit.ts) | [`tests/security/rate-limit-keying.test.ts`](../tests/security/rate-limit-keying.test.ts), [`tests/security/rate-limit-routes.test.ts`](../tests/security/rate-limit-routes.test.ts) |
| 1.3 | State-changing requests are checked against the deployment's own origin | Implemented | [`src/lib/api/origin-check.ts`](../src/lib/api/origin-check.ts), [`src/proxy.ts`](../src/proxy.ts) | [`tests/security/csrf-origin.test.ts`](../tests/security/csrf-origin.test.ts) |
| 1.4 | Authentication transitions and denials are audited | Partial | [`src/lib/audit.ts`](../src/lib/audit.ts), [`src/lib/api/require-session.ts`](../src/lib/api/require-session.ts) | [`tests/security/auth-audit.test.ts`](../tests/security/auth-audit.test.ts) |
| 1.5 | The login comparison is constant time and its failure response is uniform | Implemented | [`src/lib/auth-compare.ts`](../src/lib/auth-compare.ts), [`src/app/api/auth/login/route.ts`](../src/app/api/auth/login/route.ts) | [`tests/security/login-enumeration.test.ts`](../tests/security/login-enumeration.test.ts) |
| 1.6 | A local account with a TOTP secret configured cannot be signed in with its password alone, and an accepted code cannot be used twice | Implemented | [`src/lib/totp.ts`](../src/lib/totp.ts), [`src/lib/local-auth.ts`](../src/lib/local-auth.ts), [`src/app/api/auth/login/route.ts`](../src/app/api/auth/login/route.ts) | [`tests/security/mfa-second-factor.test.ts`](../tests/security/mfa-second-factor.test.ts) |
| 2.1 | Secrets, dependencies and the container image are scanned in CI | Implemented | [`.github/workflows/security-scan.yml`](../.github/workflows/security-scan.yml), [`.gitleaks.toml`](../.gitleaks.toml), [`.trivyignore.yaml`](../.trivyignore.yaml) | [`tests/unit/security-scan-workflow.test.ts`](../tests/unit/security-scan-workflow.test.ts), [`tests/unit/gitleaks-config.test.ts`](../tests/unit/gitleaks-config.test.ts), [`tests/unit/trivyignore-policy.test.ts`](../tests/unit/trivyignore-policy.test.ts) |
| 2.2 | An SBOM is published with every release | Implemented | [`.github/workflows/release-artifacts.yml`](../.github/workflows/release-artifacts.yml) | [`tests/unit/release-sbom.test.ts`](../tests/unit/release-sbom.test.ts) |
| 2.3 | No TypeScript error is suppressed at build time | Implemented | [`next.config.ts`](../next.config.ts) | [`tests/unit/next-config-typecheck.test.ts`](../tests/unit/next-config-typecheck.test.ts) |
| 3.1 | Credentials are encrypted at rest in the server-side store | Implemented | [`src/lib/storage/encryption.ts`](../src/lib/storage/encryption.ts), [`src/lib/storage/connection-secrets.ts`](../src/lib/storage/connection-secrets.ts), [`src/lib/storage/encrypting-provider.ts`](../src/lib/storage/encrypting-provider.ts), [`src/lib/storage/factory.ts`](../src/lib/storage/factory.ts) | [`tests/security/credential-at-rest.test.ts`](../tests/security/credential-at-rest.test.ts), [`tests/isolated/factory-singleton.test.ts`](../tests/isolated/factory-singleton.test.ts), [`tests/integration/storage/sqlite-credential-encryption.test.ts`](../tests/integration/storage/sqlite-credential-encryption.test.ts) |
| 3.2 | Every authoritative (server-generated) audit event is emitted as one structured JSON line on stdout | Implemented | [`src/lib/audit.ts`](../src/lib/audit.ts) | [`tests/security/audit-redaction.test.ts`](../tests/security/audit-redaction.test.ts), [`tests/security/audit-type-safety.test.ts`](../tests/security/audit-type-safety.test.ts), [`tests/security/audit-channel-callsites.test.ts`](../tests/security/audit-channel-callsites.test.ts) |
| 3.3 | This page is checked against the repository on every build | Implemented | [`scripts/security-check.mjs`](../scripts/security-check.mjs) | [`tests/unit/security-check.test.ts`](../tests/unit/security-check.test.ts) |
| 3.4 | A statement submitted on the agent execution path cannot write, change schema, reach another database, load code, or run the executing form of EXPLAIN | Partial | [`src/lib/db/operations/policy.ts`](../src/lib/db/operations/policy.ts), [`src/lib/db/operations/statement-guard.ts`](../src/lib/db/operations/statement-guard.ts), [`src/lib/agent/composed-sql.ts`](../src/lib/agent/composed-sql.ts), [`src/lib/agent/tools.ts`](../src/lib/agent/tools.ts), [`src/lib/db/providers/sql/postgres.ts`](../src/lib/db/providers/sql/postgres.ts), [`src/lib/db/providers/sql/sqlite.ts`](../src/lib/db/providers/sql/sqlite.ts), [`src/lib/db/providers/sql/mssql.ts`](../src/lib/db/providers/sql/mssql.ts), [`src/app/api/agent/runs/route.ts`](../src/app/api/agent/runs/route.ts), [`src/app/api/agent/runs/[runId]/handover/route.ts`](../src/app/api/agent/runs/[runId]/handover/route.ts), [`src/lib/agent/runtime.ts`](../src/lib/agent/runtime.ts) | [`tests/api/agent/handover.test.ts`](../tests/api/agent/handover.test.ts), [`tests/security/agent-statement-boundary.test.ts`](../tests/security/agent-statement-boundary.test.ts), [`tests/unit/lib/agent/composed-sql.test.ts`](../tests/unit/lib/agent/composed-sql.test.ts), [`tests/unit/lib/agent/tools.test.ts`](../tests/unit/lib/agent/tools.test.ts), [`tests/api/agent/runs.test.ts`](../tests/api/agent/runs.test.ts), [`tests/integration/db/postgres-provider.test.ts`](../tests/integration/db/postgres-provider.test.ts), [`tests/integration/db/sqlite-provider.test.ts`](../tests/integration/db/sqlite-provider.test.ts), [`tests/integration/db/mssql-provider.test.ts`](../tests/integration/db/mssql-provider.test.ts) |
| 3.5 | Every agent-path operation — allowed, denied, or held for approval — is audited under one correlation id, and its result is released with the run | Partial | [`src/lib/db/operations/execution.ts`](../src/lib/db/operations/execution.ts), [`src/lib/db/operations/artifacts.ts`](../src/lib/db/operations/artifacts.ts), [`src/lib/agent/tools.ts`](../src/lib/agent/tools.ts), [`src/lib/audit.ts`](../src/lib/audit.ts), [`src/lib/api/agent-run-access.ts`](../src/lib/api/agent-run-access.ts), [`src/app/api/agent/drive/route.ts`](../src/app/api/agent/drive/route.ts), [`src/app/api/agent/runs/[runId]/artifacts/[correlationId]/route.ts`](../src/app/api/agent/runs/[runId]/artifacts/[correlationId]/route.ts) | [`tests/security/agent-execution-audit.test.ts`](../tests/security/agent-execution-audit.test.ts), [`tests/security/agent-tool-layer-audit.test.ts`](../tests/security/agent-tool-layer-audit.test.ts), [`tests/unit/db/operations/execution.test.ts`](../tests/unit/db/operations/execution.test.ts), [`tests/unit/db/operations/artifacts.test.ts`](../tests/unit/db/operations/artifacts.test.ts), [`tests/api/agent/drive.test.ts`](../tests/api/agent/drive.test.ts), [`tests/api/agent/artifacts.test.ts`](../tests/api/agent/artifacts.test.ts), [`tests/api/db/query.test.ts`](../tests/api/db/query.test.ts) |
| 3.6 | Every application of an edited object definition is authorised by a server-issued plan, and both the decision and the engine's verdict are audited under one correlation id | Implemented | [`src/app/api/db/objects/edit-plan/route.ts`](../src/app/api/db/objects/edit-plan/route.ts), [`src/app/api/db/objects/edit-apply/route.ts`](../src/app/api/db/objects/edit-apply/route.ts), [`src/lib/api/object-edit-plan-token.ts`](../src/lib/api/object-edit-plan-token.ts), [`src/lib/db/object-edit.ts`](../src/lib/db/object-edit.ts), [`src/lib/db/connection-fingerprint.ts`](../src/lib/db/connection-fingerprint.ts) | [`tests/security/object-edit-audit.test.ts`](../tests/security/object-edit-audit.test.ts), [`tests/api/db/objects/edit-plan.test.ts`](../tests/api/db/objects/edit-plan.test.ts), [`tests/api/db/objects/edit-apply.test.ts`](../tests/api/db/objects/edit-apply.test.ts), [`tests/unit/lib/db/connection-fingerprint.test.ts`](../tests/unit/lib/db/connection-fingerprint.test.ts) |

## Notes on individual rows

**0.1.** The fix removed the HTML-string path rather than escaping its input, so a future edit to the
markdown rules cannot reintroduce the sink. Fixed in 0.10.0; earlier releases are affected.

**0.3.** Exactly one route verifies something other than a user session, and it is named here rather
than left to the test file: `POST /api/agent/drive`, the callback that asks this server to pick an
agent run up again. It can have no session by construction — its caller is the durable transport,
not a person — so it verifies a credential this server minted instead: single-purpose, valid for a
minute, naming one run, signed with a key derived from `JWT_SECRET` rather than with `JWT_SECRET`
itself, so it is not a session and cannot become one. It grants nothing beyond continuing that run:
what the run may read is decided by the actor recorded in the run's own ledger, never by the
credential and never by the request body. `src/proxy.ts`'s public-path list is unchanged — the
middleware admits this one path only when the credential verifies, and the handler verifies it
again.

**0.6.** This is not a target allowlist: which server a connection reaches is still the user's
choice (see "Known limits"). What it guarantees is that the value in the `host` and `port` fields is
the whole of that choice: a host must be a hostname or an IP literal, a port an integer from 1 to
65535, and every URL is built with `URL` and checked after it is built, so no value can splice a
path, a query or another authority into a request. A refusal names the field and never echoes the
value. A 3xx answer is refused rather than followed, so neither the statement nor the credential
goes to a server the connection does not name. Links a server hands back in a response body (Trino's
`nextUri` chain) are held to the connection's own origin as well: a link on another scheme, host or
port is refused before any request is sent to it. Two residuals are stated in the provider docs:
libSQL's version probe answers "no version" on a redirect by contract, and Couchbase's TLS path
reports a 3xx as an HTTP failure rather than as a redirect.

**1.1.** The Content-Security-Policy permits inline scripts, because the application is statically
prerendered and its hydration scripts are inline and nonce-less. What the policy contains is
**where an injected script could send data** — not whether one can run. Set `CSP_REPORT_ONLY=true`
(a runtime variable, no rebuild) if an upgrade blocks a resource you need while you identify the
directive.

**1.1, HSTS.** `Strict-Transport-Security` is sent with a 180-day `max-age` (15 552 000 s) and has no
off switch: a browser that has cached the pin keeps enforcing HTTPS-only until it expires, whatever
the server sends next. Browsers ignore the header when it arrives over plain HTTP. `includeSubDomains`
is off unless `HSTS_INCLUDE_SUBDOMAINS=true`, and it is left to the operator because its reach is a
property of the hostname rather than of Studio: it extends the pin to every host *below* the one
serving Studio, for the full 180 days, with no server-side way to withdraw it. On a dedicated host
such as `studio.example.com` that usually covers nothing else; served from a registrable domain that
other services sit under, it makes each of those services HTTPS-only in every browser that visited
Studio. See [`.env.example`](../.env.example) under Security Headers.

**1.1, the subresource half.** The row says *document* response for a reason: the two delivery
paths do not carry the same set. [`src/proxy.ts`](../src/proxy.ts)'s matcher deliberately skips
`_next/static`, `_next/image` and every path containing a dot — so a file under `public/` or
`/monaco/vs/` never reaches it. [`next.config.ts`](../next.config.ts) covers those, and it carries
**two** of the seven headers rather than all seven. That is not an omission: the set it may carry is
derived from two exclusions, both now executed rather than asserted. A header whose value or
presence changes under any option `src/lib/security/config.ts` can vary is operator-configurable and
cannot be baked into a build-time routes manifest (the CSP, whose `CSP_REPORT_ONLY` escape hatch a
baked copy would strand, and HSTS, which is host-scoped so the last value the browser sees wins). A
header that acts on a *document* is inert on a subresource (`Referrer-Policy`,
`Permissions-Policy`, `Cross-Origin-Opener-Policy`).

Selecting by *exclusion* reversed the default that AU2's allowlist had: a new constant document
header is now baked onto `/logo.svg` and every `_next/static` chunk unless somebody excludes it,
where before it was withheld until somebody opted it in. What replaces the closed default is
[`tests/security/cross-origin-headers.test.ts`](../tests/security/cross-origin-headers.test.ts) —
the one verifier in the row that is about the *set* rather than about a path or a value. It requires
every header `securityHeaders()` sends to declare one of three reasons (baked, document-only,
option-dependent) and then checks the declared reason against the class the two exclusions actually
produce, so a header added with no decision recorded fails there. The other three verifiers answer
different questions: [`headers.test.ts`](../tests/security/headers.test.ts) the CSP's *meaning*,
[`header-delivery.test.ts`](../tests/security/header-delivery.test.ts) what each *path* receives
from each of the two deliveries, and [`security-headers.spec.ts`](../e2e/security-headers.spec.ts)
whether the enforced policy breaks the real asset surface in a real browser.

**1.1, the two cross-origin headers.** `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy` are the pair that would add protection a subresource can use, and
they are answered differently: **COOP is sent, CORP is refused.**

COOP is `same-origin`, set per request in
[`src/lib/security/headers.ts`](../src/lib/security/headers.ts) and applied by
[`src/proxy.ts`](../src/proxy.ts) — the document path only. It is classified document-only in
[`next.config.ts`](../next.config.ts) and therefore barred from the baked set: HTML's "create
navigation params by fetching" obtains a response's opener policy under one step, *"If navigable is
a top-level traversable"*, so nothing ever reads the header off a subresource and it is ignored even
for a framed document. Its value is a constant, which is exactly what makes baking it beside
`nosniff` tempting and pointless. `same-origin` rather than the weaker `same-origin-allow-popups`,
because the weaker value exists for a page that opens a popup and then scripts it and nothing here
does: the OIDC flow is a top-level redirect in both directions
(`window.location.href = "/api/auth/oidc/login"`, and the logout redirect in
`src/hooks/use-auth.ts`), and the one `window.open` call already passes `"noopener,noreferrer"`.
Three things to know when reading a header dump. COOP is ignored outright in a non-secure context —
"obtain an opener policy" returns the default `unsafe-none` before it looks at the header — so on
the plain-HTTP channels it is a no-op regardless (loopback counts as secure, so the desktop shell is
not among them). It appears on documents and not on `/monaco/vs/*` or `/logo.svg`, by design. And
`same-origin` without `Cross-Origin-Embedder-Policy` does **not** make the page cross-origin
isolated — no `SharedArrayBuffer`, and `crossOriginIsolated` stays false. That pairing was declined
deliberately: `require-corp` makes every cross-origin subresource that carries no CORP header of its
own count as blocked, which the documented off-origin `NEXT_PUBLIC_MONACO_VS_PATH` setup cannot
promise, and the capability it would buy is one nothing here uses.

CORP is **refused**, and the reason is recorded beside the header rule in
[`next.config.ts`](../next.config.ts). It could not break the editor — the cross-origin resource
policy check is only reached for a response whose tainting is opaque, which a same-origin request
never becomes, and under the shipped defaults every asset Monaco needs is same-origin.
`NEXT_PUBLIC_MONACO_VS_PATH` is the one documented way that stops being true, and it changes
nothing here: a CORP header of *ours* never labels another origin's responses. What refuses it is that its
correct *value* is the only one in the set that is a property of the deployment topology rather
than of the application, while the only delivery path that reaches a subresource is the one baked
at build time. The protection given up is narrow, and it is read off this repository's own code: a
cross-**site** no-cors subresource request already arrives without `auth-token` (`sameSite: "lax"`),
`nosniff` already refuses to execute a non-JavaScript response at a script destination, and CORP is
not a framing defence so it does not overlap `X-Frame-Options`. What stays open is the
same-**site**, cross-**origin** case — a sibling subdomain under the operator's own registrable
domain does get the cookie and can time an authenticated endpoint. That residual is stated under
"Known limits" below.

**1.2.** The counters live in the application process. With more than one replica the budgets apply
per replica; multi-replica deployments should enforce the same budgets at the ingress. See
[`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md).

**1.2, tuning the budgets.** Each bucket takes a request count and a window in seconds from a pair of
runtime variables, documented in [`.env.example`](../.env.example) under Rate Limiting:

| What it bounds | Variables | Default |
|---|---|---|
| Failed logins per client address | `RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_LOGIN_WINDOW_SEC` | 5 per 300 s |
| Failed logins per submitted account | `RATE_LIMIT_LOGIN_ACCOUNT_MAX`, `RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SEC` | 20 per 300 s |
| AI and agent-run requests per signed-in user | `RATE_LIMIT_AI_MAX`, `RATE_LIMIT_AI_WINDOW_SEC` | 20 per 60 s |
| Database-reaching requests per signed-in user | `RATE_LIMIT_QUERY_MAX`, `RATE_LIMIT_QUERY_WINDOW_SEC` | 120 per 60 s |
| Permission-denied audit lines | `RATE_LIMIT_ANON_MAX`, `RATE_LIMIT_ANON_WINDOW_SEC` | 5 per 300 s |

Setting a `*_MAX` to `0` disables that bucket. A window below one second is raised to one. The last
bucket bounds how often a refusal is written to the audit log; it never changes whether a request
is refused.

Still **Partial**, for the one reason that survives: the proxy's `jwtVerify` failure arm is logged, not
audited. A forged, tampered or truncated `auth-token` reaches the trailing `catch` in
[`src/proxy.ts`](../src/proxy.ts) that covers the whole `verifyToken` call, which writes
`logger.warn("JWT verification failed, redirecting to login")` and redirects without an
`emitAuditEvent` call, so the attempt lands in stdout and never in `GET /api/admin/audit`. The proxy's
other two refusals both emit: `origin_mismatch` and `insufficient_role`. See
[`docs/BACKLOG.md`](./BACKLOG.md) H12.

Everything the row once described short of that is audited. Role failures are recorded at all five
sites that refuse on role, four in handlers and one in the proxy, and the four handler sites are the
ones the Admin Audit tab can read:

| site | call |
|---|---|
| `GET` in `src/app/api/admin/audit/route.ts` | `auditRoleDenial` |
| `POST` in `src/app/api/admin/audit/route.ts` | `auditRoleDenial` |
| `src/app/api/db/maintenance/route.ts` | `auditRoleDenial` |
| `src/app/api/admin/fleet-health/route.ts` | `auditRoleDenial` |
| `src/proxy.ts` | `emitAuditEvent`, `insufficient_role` |

`auditRoleDenial`
([`src/lib/api/require-session.ts`](../src/lib/api/require-session.ts)) emits `permission_denied`
with `reason: "insufficient_role"`, so those four reach the tab. An earlier version of this note
claimed the opposite and pointed at an `H12` that did not exist.

Two qualifiers the grade rests on, both deliberate and documented at each call site:

- **Recorded, not unlimited.** Every `permission_denied` emit is metered through the anon bucket (the
  rate-limit table under 1.2), so a sustained denial is audited up to 5 lines per 300 s per key. The
  refusals themselves are never metered, and a missing token redirecting to `/login` is ordinary
  logged-out traffic, not a denial.
- **The proxy's ring is its own.** [`src/proxy.ts`](../src/proxy.ts) compiles as a separate Next entry
  with its own module graph, so its audit writes do not appear in what `GET /api/admin/audit` returns.
  Mechanism and disclosure are 3.2's subject.

**1.6.** Opt-in: a second factor exists for an account exactly when `ADMIN_TOTP_SECRET` /
`USER_TOTP_SECRET` is set, so the row claims nothing about a deployment that sets neither.
Verification is RFC 6238 with HMAC-SHA-1, six digits, a 30-second step and one step of skew either
side. Three things are worth stating precisely.

It guards `POST /api/auth/login`, and that route is **not** disabled by
`NEXT_PUBLIC_AUTH_PROVIDER=oidc` — the provider setting changes what the login page renders, not
what the API accepts. A deployment that runs OIDC while still setting `ADMIN_PASSWORD` therefore
keeps a way in that never reaches the issuer, and so never meets the MFA policy configured there;
these variables are honoured in that mode too, which is how it is closed
([`docs/MFA.md`](./MFA.md), [`docs/OIDC.md`](./OIDC.md)).

Replies distinguish "code required" from "invalid code", which is not the enumeration oracle 1.5
removes: both are reachable only with a correct password, and without MFA that same request would
have returned a session.

The spent-code set that makes an accepted code single-use lives in the application process, like
the counters in 1.2 — with more than one replica each process enforces its own view, so a captured
code can be replayed once per replica inside its 90-second window.

**3.1.** Applies to `STORAGE_PROVIDER=sqlite` and `postgres` only. Seven fields are encrypted;
`host`, `port`, `user`, `agentUser`, `database`, `name` and the TLS certificates stay readable so a
dump can still be identified. Rotating the key makes stored credentials unreadable — the connection survives, the
field is omitted. For `STORAGE_PROVIDER=sqlite` with no `STORAGE_ENCRYPTION_KEY` set, the fallback
key is persisted beside the SQLite file, in the same directory the Helm chart mounts as one volume
— a backup or snapshot of it carries the key alongside the ciphertext it opens. Set
`STORAGE_ENCRYPTION_KEY` from outside that volume (a Kubernetes Secret, an environment variable) to
close that gap; `postgres` deployments do not share this exposure by default. Full detail in
[`docs/STORAGE.md`](./STORAGE.md#credential-encryption-at-rest).

**3.2.** `POST /api/admin/audit` is the one writer that reaches the in-app buffer without reaching
stdout, and that is deliberate: its body is client-supplied, so giving it the authoritative channel
would let an admin session forge an indistinguishable log line.

The gap in the other direction is `src/proxy.ts`, and it is why stdout is the authoritative channel
for boundary denials specifically. Next compiles the proxy as its own entry, which can run outside
the application's main runtime, so the module-level ring buffer it pushes to is never the one
`GET /api/admin/audit` reads. Measured in #851: an `origin_mismatch` or a proxy-level
`insufficient_role` line, when the anon rate limit under 1.2 lets it through, reaches stdout and
never the Admin Audit tab. The tab discloses that rather than presenting its buffer as the whole
log.

**3.4.** WRITES are refused by the database itself, and each engine's boundary is its own. A
PostgreSQL read-only transaction carrying exactly one statement, run by a role verified at open to
hold neither superuser nor any server-file/program privilege (a read-only transaction does not stop
`COPY … TO PROGRAM`); a separate SQLite read-only open with `PRAGMA query_only` re-asserted before
every statement; a DuckDB `READ_ONLY` engine handle paired with an SQL-level guard, because that flag
alone still admits `COPY … TO`, `EXPORT DATABASE` and the local-file table functions; and, on SQL
Server, four layers rather than one, because the engine offers no read-only transaction and no
session-level read-only switch at all: a session principal verified at open to be unable to write or
to reach the server's dangerous surfaces, an admission step that asks the optimizer to compile each
statement without running it, a server-side row bound (`SET ROWCOUNT`) that stops an unbounded read
before its rows are materialised, and a pinned transaction that is always rolled back. Reading
the SQL is defense in depth only, never the boundary. A route now reaches this layer: an agent run
is opened at `POST /api/agent/runs` by a verified session, and every statement it sends passes
through the operation pipeline above, on a provider acquired for the run's read-only execution
profile rather than from the shared writable cache.

**A second route reaches it, and it exists because the boundary above is the point.**
`POST /api/agent/runs/{runId}/handover` replays the statement an auto-execute run answered with, in
the user's editor. It used to be replayed through `POST /api/db/query` — the ordinary editor path, a
read-WRITE session whose only protection is a syntactic read of the statement — which meant the same
text was refused where the run proved it and executed where the user saw it: a `SELECT` invoking a
VOLATILE function that performs an `INSERT` is refused by the read-only transaction (SQLSTATE 25006)
and performed by a read-write one, and no reading of the SQL can tell the two apart. The replay now
runs through `provider.queryReadOnly` under its own execution profile (`agent-handover`), so the
same database-native control applies to it. Its request carries no SQL at all — the statement comes
from the run's own `answer-composed` event and the connection from the run's persisted
`connectionId` — so it is not a general endpoint for running a statement read-only, and nothing a
user types reaches the profile.

Still **Partial**, for the one reason that
survives: out-of-scope READS have no database-native control on any of those providers — only the
declared-target allowlist, the statement guard, and whatever the role's grants bound (see
[`docs/BACKLOG.md`](./BACKLOG.md) A3).

**3.5.** Each execution emits a decision event and, once allowed, an execution-outcome event
sharing one server-generated correlation id; a denial emits the decision event alone with a typed
`agent_*` reason. The decision is recorded **before** the provider is called and the emission is not
wrapped in a try/catch, so an execution that cannot be audited does not run. What the events carry
is deliberately narrow: the registry-resolved operation id, an `agent:<role>` actor label, the
outcome, the reason code, the elapsed time and the correlation id — never the statement, the
agent-supplied operation id, the session identifier or a driver message. Results live in an
in-process artifact store released with the run (TTL and an entry cap are backstops), so no agent
result is written at rest. A user can read one of those results back while its run is live — the route
that serves it authorizes the run first and only then reads the store, keyed on the correlation id the
run's own ledger recorded, so an id belonging to another run answers exactly like one that never
existed; once the run ends, its results are gone and the route says so rather than reporting them
missing. One outcome carries no correlation id, because no execution produced one:
the agent tool layer refuses a call that no longer fits the run's wall-clock deadline BEFORE the
execution glue is reached, and records that with its own two `agent_*` reasons
(`agent_run_deadline_exceeded`, `agent_insufficient_time_remaining`) so a run that stopped on its own
deadline is not silent. The routes that make this reachable are session-verified in their own
handlers, and a run is authorized against the actor persisted in its own ledger — not against the
caller of the moment, so a drive that continues a run minutes later cannot widen what it may audit or
read (that resume path exists and authenticates, but nothing calls it yet — see
[`docs/BACKLOG.md`](./BACKLOG.md) B9). Still **Partial**, for the one reason that survives: the in-app
ring buffer is per-process — the stdout line remains the authoritative record.

**3.6.** This is the first row that covers a database WRITE, and the claim it makes is the narrow
one. Each apply emits a decision event before the provider is called and an outcome event after it,
both under one correlation id, both naming the object address (kind, path, part), the resolved
strategy and the outcome; and neither carries the statement, the command payload, the reader's
text, the pre-image, the engine's message, the engine's code, the revision token or the plan token.
The decision event is emitted outside any try/catch, so an apply that cannot be audited does not
run; the outcome event is wrapped, because the engine has already acted and a broken log sink must
not turn a completed apply into a 500 that invites a retry that would be a second write.
Authorisation is a server-issued plan: the preview and the apply are bound by a sealed plan whose
bytes the server minted, so what the user approved is what the engine receives, and a plan whose
seal does not verify is refused with one audited event and no provider call.

**The seal binds the SERVER as well as the bytes, and the field list is what makes that true.**
`connectionFingerprint` is the part of the seal that answers "is this the machine the plan was built
against", so it is named in the row above rather than left as an implementation detail of the token:
a change to the frame is a change to this control. Ten fields are hashed and each one, changed alone,
sends the same approved statement somewhere else: `type`, `host`, `port`, `database`, `user`, the
`connectionString` that overrides all of those when a record carries one, Trino's session `schema`,
Oracle's `serviceName`, a MSSQL `instanceName`, and the SSH tunnel's ROUTE - its four addressing
fields, because the same `db:5432` reached through two different bastions is two different databases.
`host` and `port` are the FAR END on both sides of the compare. The provider factory rewrites a
tunnelled record to the tunnel's loopback endpoint before the driver opens, so it carries the far end
alongside that rewrite and the seal hashes the far end, never the ephemeral local port, which is a
property of this process and not of the server. The far end is read back off the tunnel and is never
the address the factory asked for, and the tunnel pool keys a forward by connection id, by that far
end and by the same four bastion fields this seal frames, so the only forward a provider can be
handed is one opened to the address it seals THROUGH the bastion its record names. Measured against a
live bastion in both directions on 2026-09-15: with the far end alone in the key, a record edited to
name a bastion that does not resolve was served the forward already open through the real one,
reached the old machine, and sealed a digest the route recomputed to the same value; with the route
in the key the same record opens its own forward and fails to connect, which is what the same record
on a connection id nothing is pooled under has always done. The connection's `id` and `name` are
deliberately OUT, because a caller supplies them, and so is the password, because rotating a
credential must not invalidate a plan built five minutes earlier. Both of the last two additions came
from external review of the change that introduced the control, each with a colliding pair measured
against the real module, so this list is a measured floor rather than a design intention.

**What the round trip carried, on PostgreSQL: guarded on both sides, and neither guard is a
parser.** The day-one PostgreSQL unit is a multi-statement simple query, so every statement the
reader's text carried used to run, and the audit event named only the addressed object. This
repository cannot count the statements in a routine body itself: a dollar-quoted body may contain
any number of semicolons, a `BEGIN ATOMIC` body contains them by construction, and no parser here
can tell a statement separator from a character of the definition. So the engine is asked instead.
The build parses the reader's submitted text alone as a NAMED prepared statement inside a
transaction block it has already poisoned with `SELECT 1/0`, then rolls that block back: for every
text that reaches this check the server performs no parse analysis, no planning and no execution,
and its multi-command check still runs because it precedes the aborted-block check in the server's
own `exec_parse_message`. A text PostgreSQL parses as more than one statement is refused, no plan is
minted and nothing is sent; a server that does not answer that check is refused `unsupported`
rather than trusted.

**The aborted block is not a universal brake, and that is why the sentence above is bounded by the
population it was measured over.** Measured on 18.4 on 2026-09-15, one `BEGIN` plus `SELECT 1/0`
plus a named Parse per row: `exec_parse_message` exempts a transaction-exit statement, so `COMMIT`,
`ROLLBACK`, `END` and `ABORT` answer no error at all, run, and end the very block this check opened;
and an empty, whitespace-only or comment-only text answers `25P02` from Bind rather than from Parse,
so the named statement is created and survives the rollback on a client that then goes back to the
pool. Neither class can reach this check, and the reason is the ORDER of the build's refusals rather
than the block: the identity comparison answers two refusals earlier and renders a header that is
not the addressed routine's for either one. So the order is load-bearing and not only a saved round
trip, and the provider's own suite asserts that neither class reaches the wire rather than leaving
it to a comment.

**On the apply side the round trip is counted rather than trusted.** A simple query answers one
result per statement, so the provider counts the results it already receives and reports
`interrupted` with `committed: "unknown"`, never a plain `applied`, when the count is not the four
statements the unit is made of. Measured on PostgreSQL 18.4 on 2026-09-15, driven through the
provider: the rider that used to drop another routine at HTTP 200 is now refused at build with the
victim's `count(*)` unmoved, while a routine whose body carries semicolons inside `$function$` and
a `BEGIN ATOMIC` body of two `SELECT`s both still build and apply. `docs/providers/postgres.md`
carries the full table.

**What that still does NOT claim.** The check is exactly as good as the server's own parser, and
this type id also serves CockroachDB and Materialize, neither of which was probed. The result count
says how many statements ran and never which, so it detects a round trip that did not match the
plan and cannot name what it carried. And neither half widens the plan's consequence model: one
statement whose effects reach beyond the addressed routine is still described by the empty
consequence list the strategy carries. So the event says an edit was applied at this address, with
this strategy, and with this outcome, and a reader of the log should read it as exactly that.

## Known limits

These are real, current, and not oversights. Each is a decision with a reason.

- **Browser `localStorage` holds your credentials in plaintext.** It is the rendering source, and
  encrypting it would require a master password and a recovery flow, changing what the product is.
  This is why 0.1 and 1.1 matter as much as they do.
- **Anyone who can read the server's environment can read the stored credentials.** 3.1 protects a
  stolen database file or dump on its own; it is not a vault. For `STORAGE_PROVIDER=sqlite` with no
  `STORAGE_ENCRYPTION_KEY` configured, that protection does not extend to a backup or volume
  snapshot of the data directory — see the note on 3.1 below.
- **A `user` can connect to any host and port and run any statement.** The product ships two roles,
  and the boundary between them is not a policy engine. Target allowlists, per-provider command
  capabilities and a locked-down deployment profile are a coherent direction and are not
  implemented.
  A Kafka broker's metadata chooses the further hosts Studio connects to, with the connection's SASL credentials: a Kafka client reaches every broker at the address the broker advertises, so a hostile or misconfigured broker can direct Studio, with those credentials, to any host and port.
  Use TLS with verify-full so credentials reach only hosts whose certificate the configured CA vouches for.
  A Kafka connection refuses an SSH tunnel for the same reason: the tunnel would carry the bootstrap connection only, and every read would go to the advertised addresses directly.
  And the Kafka client decompresses every batch of a fetch response whole, before any bound Studio applies, while the broker bounds only the compressed batch, so one response can hold its compressed size times the codec's ratio, measured at about 1,029 to 1 for gzip and 32,692 to 1 for zstd, in the one process every user shares; a hostile broker is bounded by neither, because the client buffers whatever frame length the broker announces ([`docs/providers/kafka.md`](./providers/kafka.md) section 5.4).
  The Kafka client's SCRAM exchange runs PBKDF2 over the password as many times as the broker's first SCRAM answer asks, checking only the lower bound, while Apache Kafka 4.3.1 stores no credential above 16,384 iterations, so a hostile broker, or one in the middle of a connection in TLS mode `require`, can hold threads of the process's pool for minutes per connect, which stalls every file read, DNS lookup and crypto call waiting for a thread ([`docs/providers/kafka.md`](./providers/kafka.md) section 4.2).
- **Local login credentials are not hashed.** They arrive as `ADMIN_PASSWORD` and `USER_PASSWORD`
  environment variables, so the environment already holds the secret. Rate limiting (1.2) and the
  constant-time comparison (1.5) address the reachable part of the risk.
- **Rate limiting is per process and every bucket is keyed on something the caller supplies.** See
  [`docs/BACKLOG.md`](./BACKLOG.md), entries H11 and H13. Two variables decide what that something
  is. `TRUST_PROXY_HEADERS` (default `true`) derives the client address from `X-Forwarded-For`,
  falling back to `X-Real-IP`; set to `false`, every anonymous caller shares one bucket, so a single
  caller tripping the login limiter locks everyone out until the window closes. `TRUSTED_PROXY_HOPS`
  (default `0`) picks which `X-Forwarded-For` entry is the client. `0` takes the leftmost entry,
  which the caller writes, so behind a reverse proxy it should be set to the number of proxies in
  front of Studio. Set too low, a caller can choose the bucket they land in; set too high, it keys
  on a proxy and lumps everyone behind it into one bucket. The same derived address is the `ip`
  field in the audit log, so a wrong value also makes that field unreliable. Both are documented in
  [`.env.example`](../.env.example) under Forwarded Headers.
- **Configuring an AI model means database content leaves the machine.** Nothing here is telemetry
  and nothing fires on its own, but an agent run sends the objective you typed, the schema
  inventory, the relations graph and the rows of every read it performs to the model provider you
  configured — and the three remaining AI routes send your statement and a schema context. The
  agent fences everything database-derived before it reaches a prompt, and one path is **not**
  fenced: an identifier the model quotes back into its own tool arguments
  ([`docs/BACKLOG.md`](./BACKLOG.md) B29, open). What each surface sends, and what comes back, with
  the call site for every claim, is [`docs/AGENT_DATA_FLOW.md`](./AGENT_DATA_FLOW.md). **A key is not
  what decides whether any of this happens — a model configuration that validates is.**
  `validateConfig()` ([`config.ts`](../src/lib/llm/utils/config.ts)) requires `LLM_API_KEY` for the
  `gemini` and `openai` kinds only, so a keyless `LLM_PROVIDER=ollama` deployment, or a
  `custom` one with `LLM_API_URL`, has the agent available and sends everything above to that
  endpoint. What sends nothing is a deployment with **no `LLM_*` configuration at all**: the provider
  defaults to `gemini` through `DEFAULT_PROVIDER`
  ([`config.ts`](../src/lib/llm/utils/config.ts)), it is refused without a key, availability answers
  `NO_MODEL_CONFIGURED`, no rail renders and no model call is made.
- **A page on a sibling subdomain can time an authenticated endpoint on this one.** The auth cookie
  is `SameSite=Lax`, which withholds it from a cross-*site* subresource request but sends it to a
  same-*site*, cross-*origin* one — so an attacker who controls any host under the deployment's own
  registrable domain can load a Studio URL as a no-cors subresource and read the load/error and
  coarse-timing signal, even though the response bytes stay opaque to them.
  `Cross-Origin-Resource-Policy: same-origin` is the control that closes this, and it is refused for
  now with the reason recorded in [`next.config.ts`](../next.config.ts): its correct value is a
  property of the deployment topology, and the only header path that reaches a subresource is baked
  at build time, where an operator cannot change it. Closing it properly means a runtime delivery
  path that reaches a subresource, which the two-path split above does not have.
- **A test linked from this table is checked to exist and to run — not to be true.** Nothing
  verifies that a linked test actually exercises the control it is linked from. That is the
  residual this page carries knowingly; the same limitation is recorded for the route-guard
  allowlist in [`docs/BACKLOG.md`](./BACKLOG.md), entry H10.
- **No dynamic application security testing, no penetration test, no OpenSSF Scorecard badge yet.**
  Each was deferred deliberately rather than skipped.

## Verifying this page yourself

```bash
bun run security:check   # the drift guard CI runs
bun run test             # includes tests/security/
bun run test:e2e         # includes the CSP verification against a real browser
```

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
| 0.1 | LLM output never becomes an HTML string; the renderer builds React elements | Implemented | [`src/components/DatabaseDocs.tsx`](../src/components/DatabaseDocs.tsx), [`src/components/AIAutopilotPanel.tsx`](../src/components/AIAutopilotPanel.tsx) | [`tests/security/xss-sinks.test.tsx`](../tests/security/xss-sinks.test.tsx) |
| 0.2 | No remote origin can be fetched through the image optimizer | Implemented | [`next.config.ts`](../next.config.ts) | [`tests/security/image-proxy.test.ts`](../tests/security/image-proxy.test.ts) |
| 0.3 | Every route that reaches a database or an LLM verifies the session in its own handler | Implemented | [`src/lib/api/require-session.ts`](../src/lib/api/require-session.ts) | [`tests/security/route-auth.test.ts`](../tests/security/route-auth.test.ts) |
| 0.4 | The security policy states only what the code does | Implemented | [`SECURITY.md`](../SECURITY.md) | [`tests/unit/security-check.test.ts`](../tests/unit/security-check.test.ts) |
| 0.5 | A published reporting channel with a stated response time | Implemented | [`SECURITY.md`](../SECURITY.md) | [`tests/security/vulnerability-disclosure.test.ts`](../tests/security/vulnerability-disclosure.test.ts) |
| 1.1 | Every response carries CSP, HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy and Permissions-Policy | Implemented | [`src/lib/security/headers.ts`](../src/lib/security/headers.ts), [`src/lib/security/config.ts`](../src/lib/security/config.ts), [`src/proxy.ts`](../src/proxy.ts) | [`tests/security/headers.test.ts`](../tests/security/headers.test.ts), [`tests/security/header-delivery.test.ts`](../tests/security/header-delivery.test.ts), [`e2e/security-headers.spec.ts`](../e2e/security-headers.spec.ts) |
| 1.2 | Login, AI and database-reaching routes are rate limited | Implemented | [`src/lib/api/rate-limit.ts`](../src/lib/api/rate-limit.ts) | [`tests/security/rate-limit-keying.test.ts`](../tests/security/rate-limit-keying.test.ts), [`tests/security/rate-limit-routes.test.ts`](../tests/security/rate-limit-routes.test.ts) |
| 1.3 | State-changing requests are checked against the deployment's own origin | Implemented | [`src/lib/api/origin-check.ts`](../src/lib/api/origin-check.ts), [`src/proxy.ts`](../src/proxy.ts) | [`tests/security/csrf-origin.test.ts`](../tests/security/csrf-origin.test.ts) |
| 1.4 | Authentication transitions and denials are audited | Partial | [`src/lib/audit.ts`](../src/lib/audit.ts), [`src/lib/api/require-session.ts`](../src/lib/api/require-session.ts) | [`tests/security/auth-audit.test.ts`](../tests/security/auth-audit.test.ts) |
| 1.5 | The login comparison is constant time and its failure response is uniform | Implemented | [`src/lib/auth-compare.ts`](../src/lib/auth-compare.ts), [`src/app/api/auth/login/route.ts`](../src/app/api/auth/login/route.ts) | [`tests/security/login-enumeration.test.ts`](../tests/security/login-enumeration.test.ts) |
| 2.1 | Secrets, dependencies and the container image are scanned in CI | Implemented | [`.github/workflows/security-scan.yml`](../.github/workflows/security-scan.yml), [`.gitleaks.toml`](../.gitleaks.toml), [`.trivyignore.yaml`](../.trivyignore.yaml) | [`tests/unit/security-scan-workflow.test.ts`](../tests/unit/security-scan-workflow.test.ts), [`tests/unit/gitleaks-config.test.ts`](../tests/unit/gitleaks-config.test.ts), [`tests/unit/trivyignore-policy.test.ts`](../tests/unit/trivyignore-policy.test.ts) |
| 2.2 | An SBOM is published with every release | Implemented | [`.github/workflows/release-artifacts.yml`](../.github/workflows/release-artifacts.yml) | [`tests/unit/release-sbom.test.ts`](../tests/unit/release-sbom.test.ts) |
| 2.3 | No TypeScript error is suppressed at build time | Implemented | [`next.config.ts`](../next.config.ts) | [`tests/unit/next-config-typecheck.test.ts`](../tests/unit/next-config-typecheck.test.ts) |
| 3.1 | Credentials are encrypted at rest in the server-side store | Implemented | [`src/lib/storage/encryption.ts`](../src/lib/storage/encryption.ts), [`src/lib/storage/connection-secrets.ts`](../src/lib/storage/connection-secrets.ts), [`src/lib/storage/encrypting-provider.ts`](../src/lib/storage/encrypting-provider.ts), [`src/lib/storage/factory.ts`](../src/lib/storage/factory.ts) | [`tests/security/credential-at-rest.test.ts`](../tests/security/credential-at-rest.test.ts), [`tests/isolated/factory-singleton.test.ts`](../tests/isolated/factory-singleton.test.ts), [`tests/integration/storage/sqlite-credential-encryption.test.ts`](../tests/integration/storage/sqlite-credential-encryption.test.ts) |
| 3.2 | Every authoritative (server-generated) audit event is emitted as one structured JSON line on stdout | Implemented | [`src/lib/audit.ts`](../src/lib/audit.ts) | [`tests/security/audit-redaction.test.ts`](../tests/security/audit-redaction.test.ts), [`tests/security/audit-type-safety.test.ts`](../tests/security/audit-type-safety.test.ts) |
| 3.3 | This page is checked against the repository on every build | Implemented | [`scripts/security-check.mjs`](../scripts/security-check.mjs) | [`tests/unit/security-check.test.ts`](../tests/unit/security-check.test.ts) |
| 3.4 | A statement submitted on the agent execution path cannot write, change schema, reach another database, load code, or run the executing form of EXPLAIN | Partial | [`src/lib/db/operations/policy.ts`](../src/lib/db/operations/policy.ts), [`src/lib/db/operations/statement-guard.ts`](../src/lib/db/operations/statement-guard.ts), [`src/lib/db/providers/sql/postgres.ts`](../src/lib/db/providers/sql/postgres.ts), [`src/lib/db/providers/sql/sqlite.ts`](../src/lib/db/providers/sql/sqlite.ts) | [`tests/security/agent-statement-boundary.test.ts`](../tests/security/agent-statement-boundary.test.ts), [`tests/integration/db/postgres-provider.test.ts`](../tests/integration/db/postgres-provider.test.ts), [`tests/integration/db/sqlite-provider.test.ts`](../tests/integration/db/sqlite-provider.test.ts) |
| 3.5 | Every agent-path operation — allowed, denied, or held for approval — is audited under one correlation id, and its result is released with the run | Partial | [`src/lib/db/operations/execution.ts`](../src/lib/db/operations/execution.ts), [`src/lib/db/operations/artifacts.ts`](../src/lib/db/operations/artifacts.ts), [`src/lib/audit.ts`](../src/lib/audit.ts) | [`tests/security/agent-execution-audit.test.ts`](../tests/security/agent-execution-audit.test.ts), [`tests/unit/db/operations/execution.test.ts`](../tests/unit/db/operations/execution.test.ts), [`tests/unit/db/operations/artifacts.test.ts`](../tests/unit/db/operations/artifacts.test.ts), [`tests/api/db/query.test.ts`](../tests/api/db/query.test.ts) |

## Notes on individual rows

**0.1.** The fix removed the HTML-string path rather than escaping its input, so a future edit to the
markdown rules cannot reintroduce the sink. Fixed in 0.10.0; earlier releases are affected.

**1.1.** The Content-Security-Policy permits inline scripts, because the application is statically
prerendered and its hydration scripts are inline and nonce-less. What the policy contains is
**where an injected script could send data** — not whether one can run. Set `CSP_REPORT_ONLY=true`
(a runtime variable, no rebuild) if an upgrade blocks a resource you need while you identify the
directive.

**1.2.** The counters live in the application process. With more than one replica the budgets apply
per replica; multi-replica deployments should enforce the same budgets at the ingress. See
[`charts/libredb-studio/README.md`](../charts/libredb-studio/README.md).

**1.4.** Marked Partial: sessions and origin failures are audited, role failures are not. Four
in-handler admin checks and the middleware's `/admin` redirect return their denial with no audit
line. Tracked in [`docs/BACKLOG.md`](./BACKLOG.md), entry H12.

**3.1.** Applies to `STORAGE_PROVIDER=sqlite` and `postgres` only. Six fields are encrypted;
`host`, `port`, `user`, `database` and the TLS certificates stay readable so a dump can still be
identified. Rotating the key makes stored credentials unreadable — the connection survives, the
field is omitted. For `STORAGE_PROVIDER=sqlite` with no `STORAGE_ENCRYPTION_KEY` set, the fallback
key is persisted beside the SQLite file, in the same directory the Helm chart mounts as one volume
— a backup or snapshot of it carries the key alongside the ciphertext it opens. Set
`STORAGE_ENCRYPTION_KEY` from outside that volume (a Kubernetes Secret, an environment variable) to
close that gap; `postgres` deployments do not share this exposure by default. Full detail in
[`docs/STORAGE.md`](./STORAGE.md#credential-encryption-at-rest).

**3.2.** `POST /api/admin/audit` is the one writer that reaches the in-app buffer without reaching
stdout, and that is deliberate: its body is client-supplied, so giving it the authoritative channel
would let an admin session forge an indistinguishable log line.

**3.4.** WRITES are refused by the database itself — a PostgreSQL read-only transaction carrying
exactly one statement, run by a role verified at open to hold neither superuser nor any
server-file/program privilege (a read-only transaction does not stop `COPY … TO PROGRAM`); and a
separate SQLite read-only open with `PRAGMA query_only` re-asserted before every statement. Reading
the SQL is defense in depth only, never the boundary. **Partial** for two reasons: out-of-scope
READS have no database-native control on either provider (only the declared-target allowlist, the
statement guard, and whatever the role's grants bound — see
[`docs/BACKLOG.md`](./BACKLOG.md) A3), and no route or agent runtime reaches this layer yet, so it
governs nothing in a shipped release until the agent surface lands.

**3.5.** Each execution emits a decision event and, once allowed, an execution-outcome event
sharing one server-generated correlation id; a denial emits the decision event alone with a typed
`agent_*` reason. The decision is recorded **before** the provider is called and the emission is not
wrapped in a try/catch, so an execution that cannot be audited does not run. What the events carry
is deliberately narrow: the registry-resolved operation id, an `agent:<role>` actor label, the
outcome, the reason code, the elapsed time and the correlation id — never the statement, the
agent-supplied operation id, the session identifier or a driver message. Results live in an
in-process artifact store released with the run (TTL and an entry cap are backstops), so no agent
result is written at rest. **Partial** for the same two reasons as 3.4: no route reaches this layer
yet, and the in-app ring buffer is per-process — the stdout line remains the authoritative record.

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
- **Local login credentials are not hashed.** They arrive as `ADMIN_PASSWORD` and `USER_PASSWORD`
  environment variables, so the environment already holds the secret. Rate limiting (1.2) and the
  constant-time comparison (1.5) address the reachable part of the risk.
- **Rate limiting is per process and every bucket is keyed on something the caller supplies.** See
  [`docs/BACKLOG.md`](./BACKLOG.md), entries H11 and H13.
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

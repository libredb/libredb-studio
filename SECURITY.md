# Security Policy

## Supported Versions

We actively support and provide security updates for the following versions of LibreDB Studio:

| Version | Supported          |
| ------- | ------------------ |
| 0.9.x   | :white_check_mark: |
| < 0.9.0 | :x:                |

> **Note**: We recommend always using the latest version to ensure you have the most recent security patches.

## Reporting a Vulnerability

We take the security of LibreDB Studio seriously. If you believe you have found a security vulnerability, please report it to us as described below.

### How to Report

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to:

**Email:** info@sekoya.tech

Reports are handled by Sekoya Grup Bilişim ve Teknoloji Ltd. Şti., the
maintainer of LibreDB Studio.

### What to Include

When reporting a security vulnerability, please include the following information:

- **Type of issue** (e.g., buffer overflow, SQL injection, cross-site scripting, etc.)
- **Full paths of source file(s) related to the manifestation of the issue**
- **The location of the affected source code** (tag/branch/commit or direct URL)
- **Step-by-step instructions to reproduce the issue**
- **Proof-of-concept or exploit code** (if possible)
- **Impact of the issue**, including how an attacker might exploit the issue

This information will help us triage your report more quickly.

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your vulnerability report within **48 hours**
- **Initial Assessment**: We will provide an initial assessment within **7 days**
- **Updates**: We will keep you informed of our progress every 7-10 days
- **Resolution**: We will work with you to understand and resolve the issue quickly

### Disclosure Policy

- We will coordinate with you to fix the vulnerability before public disclosure
- We will credit you for the discovery (unless you prefer to remain anonymous)
- We will not take legal action against security researchers who:
  - Act in good faith
  - Do not access more data than necessary
  - Do not modify or delete data
  - Do not disrupt our services
  - Report vulnerabilities promptly

### Security Best Practices

When using LibreDB Studio, please follow these security best practices:

1. **Keep Updated**: Always use the latest version of LibreDB Studio
2. **Secure Credentials**: Use strong passwords for `ADMIN_PASSWORD` and `USER_PASSWORD`
3. **JWT Secret**: Generate a secure `JWT_SECRET` using `openssl rand -base64 32`
4. **Environment Variables**: Never commit `.env.local` or `.env` files to version control
5. **Network Security**: Deploy behind a firewall or VPN when accessing production databases
6. **Database Access**: Use read-only database users when possible
7. **HTTPS**: Always use HTTPS in production environments
8. **API Keys**: Store LLM API keys securely and rotate them regularly

### Known Security Considerations

#### Authentication
- LibreDB Studio uses JWT-based authentication
- Credentials for the built-in local login are supplied through the `ADMIN_PASSWORD` and
  `USER_PASSWORD` environment variables and are compared directly; they are not stored in a
  database and are not hashed. Protect them the way you protect any other server environment
  variable, or use the OIDC provider instead.
- Session tokens (the JWT and its cookie) have a fixed 24-hour lifetime; this is not configurable
  today

#### Database Connections
- Connection details, including database passwords and SSH private keys, are stored unencrypted
  in browser `localStorage`, and in the server-side store when `STORAGE_PROVIDER` is set to
  `sqlite` or `postgres`. Treat both as secret material: anyone who can read that browser
  profile or that database can read every configured credential.
- Database credentials are not written to application logs, but they are returned in plaintext
  to the authenticated owner through storage API responses (for example `GET /api/storage`),
  because the app must be able to redisplay a saved connection's password for editing and reuse
- Connection pooling is used to prevent connection exhaustion

#### API Security
- All API endpoints require authentication except `POST /api/auth/login`, `POST /api/auth/logout`,
  `GET /api/auth/oidc/login`, `GET /api/auth/oidc/callback`, `GET /api/db/health` (for load
  balancer probes), and `GET /api/storage/config` (which returns the storage mode only).
  `GET /api/auth/me` and `POST /api/db/health` each check for a session themselves and return 401
  without one, the same as every other endpoint.
- Running arbitrary SQL against your connected database is the product's purpose, not an
  injection surface. Where the application builds SQL of its own — generated starter queries,
  schema browsing, inline cell edits — values are bound as parameters, and identifiers the
  application knows from schema metadata, column names and table names alike, are quoted for the
  target dialect, since SQL has no parameter syntax for identifiers. The one identifier it infers
  rather than knows — the table name behind an inline cell edit, read from a tab title or guessed
  from the query text — is validated as a bare identifier instead, and the edit is refused when it
  is not, because a guess cannot be safely quoted
- Login attempts, the AI endpoints and every database-reaching route (query execution, schema
  browsing, maintenance operations, and the admin fleet-health check) are rate limited in the
  application. The counters live in the application process, so with more than one replica the
  limits apply per replica; multi-replica deployments should enforce the same budgets at the
  ingress as well (see `charts/libredb-studio/README.md`). The budgets are configurable through the
  `RATE_LIMIT_*` environment variables documented in `.env.example`
- Every state-changing request (`POST`, `PUT`, `PATCH`, `DELETE`) must carry an `Origin` (or
  `Referer`) whose host matches the deployment's own host, as a second layer behind the
  `SameSite=Lax` session cookie — except a request whose `Content-Type` is exactly
  `application/json` and carries neither header at all, the one shape a cross-site browser cannot
  forge; see `docs/API_DOCS.md`'s "CSRF: Origin Check" section for the full carve-out and why it is
  safe. A non-browser client that does NOT send that content type (a webhook sender, for instance)
  must send `Origin: <your public origin>` instead — that requirement is on clients which skip the
  JSON carve-out, not on every non-browser client unconditionally. Deployments behind a reverse
  proxy that rewrites `Host` set `ALLOWED_ORIGINS`
- Every response that passes through the app's request middleware carries `Content-Security-Policy`,
  `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and
  `Permissions-Policy` (static assets and the storage-config bootstrap path are excluded from the
  middleware and carry none of these — see `docs/BACKLOG.md`). `/api/db/health` is NOT excluded:
  its `POST` handler is a session-gated, provider-reaching route like any other, so it goes through
  the same Origin check and carries the same headers; `GET /api/db/health` is unaffected because
  the Origin check exempts GET by method and the load-balancer/probe path stays a public route. The
  CSP permits inline scripts, because the application is statically prerendered and its hydration
  scripts are inline and nonce-less; what it does contain is where an injected script could send
  data, not whether one can run. The CSP is enforced by default; if an upgrade breaks a blocked
  resource, set `CSP_REPORT_ONLY=true` (no rebuild required — it is a runtime environment variable)
  to downgrade it to report-only while you identify the violated directive
- Logins, logouts, missing-session denials, Origin-mismatch denials and rate-limit trips are
  written to the in-app audit log and emitted as one structured JSON line each on stdout, for
  whatever log pipeline you already run. A denial based on ROLE rather than session or Origin — the
  proxy's `/admin` redirect for a non-admin token, and the in-handler admin-only checks on
  `admin/audit`, `admin/fleet-health` and `db/maintenance` — is not audited today; see
  `docs/BACKLOG.md`. A failed login records the submitted email verbatim (truncated to 254
  characters) as the event's actor, not just a real, known account: a user who mistypes their
  password into the email field puts that password on a retained audit log line

#### AI/LLM Integration
- API keys are stored server-side only
- User queries sent to LLM providers may be logged by the provider
- Consider privacy implications when using cloud-based LLM services

#### Supply Chain

- Dependencies are scanned on every pull request against the npm, Go and Rust
  inputs that actually build the shipped artefacts: `bun.lock`, the Windows
  launcher's `go.mod`, and the desktop shell's `Cargo.lock`. Findings appear in
  the run's job summary and, for branches in this repository, in the GitHub
  Security tab
- The scan **fails** only for a CRITICAL advisory that has a fixed version
  available and is not covered by an unexpired entry in `.trivyignore.yaml`, and
  only outside pull requests. Findings with no available fix are reported and
  never gate: the runtime container image inherits Debian package advisories for
  which no fixed package exists, and a gate over those would be permanently red
  without making anyone safer
- Every suppression in `.trivyignore.yaml` carries a written justification and an
  expiry date. An expired suppression is re-reported, so a decision to accept a
  risk has to be made again rather than inherited
- The published container image is scanned daily and its findings are published
  to the Security tab. Most OS-package findings in any Debian-based image have no
  fixed package available at the time they appear; the ones that do are taken by
  bumping the base image
- Every commit is scanned for credentials. The full history was swept once and
  classified: 24 matches across 753 commits, every one of them a fabricated test
  fixture, a documented example password or UI placeholder copy. **No credential
  has ever been committed to this repository**, and none has been rotated for that
  reason. The classification is `.gitleaks.toml`, and the full sweep runs again on
  every push to `main` and daily
- The production build type-checks. `next.config.ts` sets no
  `typescript.ignoreBuildErrors`, so a type error fails the build rather than
  shipping

### Software Bill of Materials

Every release carries `libredb-studio-<version>.cdx.json`, a CycloneDX 1.7 SBOM
of the production dependency closure, attached as a release asset and signed with
a GitHub build-provenance attestation. It covers all three ecosystems the release
is built from — npm, Go and Rust — and therefore describes **the dependency
closure of** the npm package, the standalone tarballs, the Windows zip, the
`.deb` and `.rpm` packages, the snap, the AppImage and the desktop package alike.

It does **not** describe the pinned Node.js runtime that `packaging/linux/fetch-node.sh`
and `packaging/windows/fetch-node.sh` download and bundle into every one of those
artefacts except the npm package. That runtime is the largest single binary in
most of them, it is fetched by a shell script rather than resolved from a
lockfile, and the SBOM's only `node`-named component is `pkg:npm/@types/node`, a
type-declarations package with no relationship to the runtime that actually
ships. This is a known gap, tracked in `docs/BACKLOG.md`.

Verify it:

```bash
gh attestation verify libredb-studio-<version>.cdx.json --repo libredb/libredb-studio
```

The container image is not covered by that document, because the image is built
after the release is published and this project's releases are immutable. Its
SBOM is generated daily from the published image, and you can regenerate it
yourself from any digest at any time. A tag such as `:0.9.67` is mutable - it
resolves to whatever manifest it currently points at - so resolve it to the
immutable digest first:

```bash
digest=$(docker buildx imagetools inspect ghcr.io/libredb/libredb-studio:0.9.67 --format '{{json .Manifest.Digest}}' | tr -d '"')
trivy image --format cyclonedx --scanners license \
  --output libredb-studio-image.cdx.json \
  "ghcr.io/libredb/libredb-studio@$digest"
```

### Security Updates

Security updates will be released as:
- **Patch releases** (e.g., 0.5.4 → 0.5.5) for critical security fixes
- **Minor releases** (e.g., 0.5.x → 0.6.0) for security improvements
- **Security advisories** will be published in the GitHub Security tab

### Security Audit

If you are conducting a security audit or penetration test, please contact us in advance at info@sekoya.tech so we can coordinate and ensure your testing does not impact other users.

---

**Thank you for helping keep LibreDB Studio and our users safe!**


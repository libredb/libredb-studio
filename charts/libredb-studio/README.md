# LibreDB Studio Helm Chart

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/libredb-studio)](https://artifacthub.io/packages/search?repo=libredb-studio)

Web-based SQL IDE for cloud-native teams supporting PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, and Redis.

## Prerequisites

- Kubernetes >= 1.26
- Helm >= 3.12

## Quick Start

```bash
# Add the Helm repository
helm repo add libredb https://libredb.org/libredb-studio/
helm repo update

# Zero-config install: first-run admin credentials are generated automatically
helm install libredb libredb/libredb-studio

# Retrieve the generated admin credentials from the pod log
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"

# Access via port-forward
kubectl port-forward svc/libredb-libredb-studio 3000:80
# Open http://localhost:3000
```

For production, provide your own secrets instead of relying on generated ones
(add `--set secrets.userPassword=...` only if you want the optional non-admin account):

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

### OCI Registry Install

```bash
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio \
  --version 0.1.38 \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Storage Modes

### Local (default)

Browser localStorage. No server-side persistence. Suitable for single-user testing.

### SQLite

Persistent file-based storage. A PVC is automatically created.

```bash
helm install libredb libredb/libredb-studio \
  --set config.storageProvider=sqlite \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

> **Note:** SQLite is single-writer. Do not use with multiple replicas.
> With SQLite storage `autoscaling.enabled` is ignored: the HPA is not rendered
> (a warning appears in the install notes) and the deployment stays at `replicaCount`.

### PostgreSQL (built-in subchart)

Deploys a Bitnami PostgreSQL instance alongside LibreDB Studio.

```bash
helm install libredb libredb/libredb-studio \
  --set postgresql.enabled=true \
  --set postgresql.auth.password=pg-secret \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

Storage provider is automatically set to `postgres` when the subchart is enabled.

> **Note:** after Broadcom's August 2025 Bitnami catalog freeze the subchart's
> pinned image is pulled from `docker.io/bitnamilegacy/postgresql`, which is
> frozen and receives no further security updates. For production, prefer an
> external database (below) or a dedicated operator such as
> [CloudNativePG](https://cloudnative-pg.io/).

### PostgreSQL (external)

```bash
helm install libredb libredb/libredb-studio \
  --set config.storageProvider=postgres \
  --set secrets.storagePostgresUrl="postgresql://user:pass@host:5432/libredb" \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Auth Bootstrap (Zero-Config vs Strict)

**The chart defaults to the application's zero-config bootstrap** (`config.authBootstrap: ""` — the `AUTH_BOOTSTRAP` variable is omitted and the app default, on, applies): when `secrets.jwtSecret` / `secrets.adminPassword` are not provided, they are generated on first start, printed once to the pod log, and stored in `/app/data/auth-bootstrap.json`. Explicitly set values always win — only missing ones are generated. This makes the chart deployable with default values, which certified catalogs such as the Rancher partner-charts repository require.

Notes on the zero-config default:

- The default install is **admin-only**. The second, non-admin account is never generated; set `secrets.userPassword` to enable it.
- Without persistence the data directory is an `emptyDir`: generated credentials survive container restarts but are regenerated when the pod is recreated. Set `persistence.enabled=true` or provide your own `secrets.*` values for stable credentials.
- Generated credentials appear once in the pod log. If your logs are collected centrally, prefer explicit secrets or strict mode.
- Zero-config is single-replica only: each pod would generate its own JWT secret, breaking sessions across replicas, so the chart refuses to render with `replicaCount > 1` or `autoscaling.enabled` unless `secrets.jwtSecret` (or `secrets.existingSecret`) is set.

### Retrieving the generated credentials

The banner is printed once, by the container that ran the first start. The pod log is therefore not always where you will find it:

```bash
# 1. The usual case
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"

# 2. The container has restarted since first start - the banner is in the previous log
kubectl logs deployment/libredb-libredb-studio --previous | grep -A 4 "generated admin credentials"

# 3. Or read the file the app stored them in (mode 0600, survives restarts)
kubectl exec deploy/libredb-libredb-studio -- cat /app/data/auth-bootstrap.json
```

`kubectl logs deployment/...` picks **one** pod arbitrarily, so with more than one replica name the pod that started first explicitly (`kubectl get pods --sort-by=.status.startTime`, then `kubectl logs <pod>`). Deleting `auth-bootstrap.json` makes the next start generate a fresh set.

**Strict mode** (`--set config.authBootstrap=off`) restores fail-closed behavior: `secrets.jwtSecret` is required, and `secrets.adminPassword` is required as well while `authProvider=local` (or use `secrets.existingSecret`); the install fails fast with a clear message when either is missing, and with an existing secret the pod will not start until the referenced keys exist. Under `authProvider=oidc` the admin password is neither required nor referenced as a mandatory Secret key - the issuer authenticates users, so an OIDC `existingSecret` needs no `admin-password` entry. Recommended for production. `secrets.userPassword` stays optional in every mode. Setting `config.authBootstrap=on` is equivalent to the default `""`, just explicit.

## OIDC SSO

```bash
helm install libredb libredb/libredb-studio \
  --set authProvider=oidc \
  --set config.oidcIssuer=https://dev-xxx.auth0.com \
  --set secrets.oidcClientId=your-client-id \
  --set secrets.oidcClientSecret=your-client-secret \
  --set secrets.jwtSecret=$(openssl rand -base64 32)
```

`secrets.adminPassword` is not part of an OIDC install: the issuer authenticates every user, and the app still signs its own session cookie with `secrets.jwtSecret`. Strict mode (`config.authBootstrap=off`) therefore requires only the JWT secret here.

## AI Configuration

```bash
helm install libredb libredb/libredb-studio \
  --set config.llmProvider=openai \
  --set config.llmModel=gpt-4o \
  --set secrets.llmApiKey=sk-your-key \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

## Agent Runtime

Studio can run a read-only investigation agent over a connected database, and **there is nothing to
turn on**. The app derives whether the agent can run from what is true at runtime: a model configured
through the AI settings above (there is no second place to enter a key) plus a writable ledger
directory. Configuring a model IS the opt-in, so this install already has an agent:

```bash
helm install libredb libredb/libredb-studio \
  --set config.llmProvider=gemini \
  --set secrets.llmApiKey=your-key \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

No `extraEnv` recipe and no `--set-string` trap: **the chart sets
`WORKFLOW_LOCAL_DATA_DIR=/app/data/workflow` for you**, and `/app/data` is mounted in every render (an
`emptyDir` by default, the PVC when `persistence.enabled`), so the ledger is writable under this
chart's `readOnlyRootFilesystem: true`. Override it through `extraEnv` only to put the ledger
somewhere else — the chart writes it before `extraEnv`, so your entry wins. When the agent cannot run,
`GET /api/agent/config` says which of the two conditions failed rather than leaving a rail that fails
on its first Start.

The chart sets it rather than leaning on the image because of when each one ships. `image.tag`
defaults to the chart's `appVersion`, and the container image gained its own
`WORKFLOW_LOCAL_DATA_DIR` default in an app version **later than `0.11.0`**, the version this chart
deploys. On the image a default install actually pulls, an unset variable resolves to `.workflow-data`
under the container's working directory `/app` — which `readOnlyRootFilesystem: true` makes
unwritable, and every run would refuse with `LEDGER_UNAVAILABLE`. Once an image carrying the default is
released the two agree on the same path, so nothing changes for you either way.

**Upgrading a deployment that already has `secrets.llmApiKey` set?** Then it has an agent now, whether
or not you asked for one. Decline it explicitly:

```bash
helm upgrade libredb libredb/libredb-studio --reuse-values --set agent.enabled=false
```

`agent.enabled` is an off-switch and nothing more. Unset (the default) writes no
`LIBREDB_AGENT_ENABLED` at all and leaves the runtime deriving its own answer; `false` writes
`LIBREDB_AGENT_ENABLED=false`, which is the supported way to have AI configured and no agent; `true`
is accepted and explicit but cannot conjure a model. The chart renders the value as a quoted string,
which is why no `--set-string` is needed here.

**Run history lives in that ledger, so `persistence` decides whether it survives.** With
`persistence.enabled=false` the ledger is an `emptyDir`: every run is written, and the entire history
goes with the pod — a restart of the container keeps it, a rescheduled or recreated pod does not. Set
`persistence.enabled=true` if a finished run should still be readable tomorrow. The install notes say
so at the end of a `helm install` that lands in this state.

**The zero-config backend is single-instance, and the chart enforces it.** It keeps run state on each
pod's own disk behind file locks, which is correct for the default `replicaCount: 1` and broken above
it: a run started on one pod is simply not there when the browser's next request lands on another. So
a release that could run agents and asks for more than one replica (or an HPA that can reach two)
**fails to render**, with a message naming the three ways out. Two of them are real today:

```bash
# keep the agent, on one pod
--set replicaCount=1
# or keep many pods, with no agent anywhere
--set agent.enabled=false
```

The third — `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`, the opt-in PostgreSQL backend, pointed
at **its own** database rather than one of the databases you connect Studio to — lifts the render
guard when supplied through `extraEnv`:

```yaml
# values.yaml — extraEnv is rendered verbatim, so valueFrom works for the URL.
# Assumes secrets.jwtSecret (or secrets.existingSecret) is set: the chart also
# refuses to render above one replica under zero-config bootstrap.
replicaCount: 3
extraEnv:
  - name: WORKFLOW_TARGET_WORLD
    value: "@workflow/world-postgres"
  - name: WORKFLOW_POSTGRES_URL
    valueFrom:
      secretKeyRef:
        name: libredb-workflow
        key: postgres-url
```

…but it **does not work with the published image**: that world is absent from the container image and
the npx payload (`B16` in the project's `docs/BACKLOG.md`), so multi-replica agent runs are
unsupported today rather than merely unconfigured. The escape hatch exists because `image.repository`
is overridable — use it only with an image that carries the world. Two further caveats if you do:
`WORKFLOW_TARGET_WORLD` accepts only `local` and `@workflow/world-postgres`, and any other value is
refused when a run is opened rather than defaulted (the workflow runtime would otherwise treat it as a
module to load); and `WORKFLOW_POSTGRES_URL` must be set, because unset that backend falls back to a
development default (`postgres://world:world@localhost:5432/world`) rather than refusing.

**The guard's blind spots, completely.** It reads these values and nothing else, so a model configured
in any of these three places passes it unseen and a multi-replica release renders without complaint:

| Where the model is configured | Why the guard cannot see it |
| --- | --- |
| `secrets.existingSecret` | a Secret the chart does not create and cannot read |
| `extraEnvFrom` | `envFrom` sources, whose keys are not visible to a template |
| `extraEnv` | rendered verbatim and **not** inspected for `LLM_API_KEY`, `LLM_API_URL` or `LLM_PROVIDER` (the only entry it does look for is `WORKFLOW_TARGET_WORLD`, above) |

Set `agent.enabled=false` by hand in any of those cases. The alternative — counting what cannot be
read — would refuse to render every existing multi-replica install that keeps a JWT secret in an
`existingSecret` and configures no AI at all, so the trade is deliberate.

Which providers count as a configured model, when no `agent.enabled` is set: an inline
`secrets.llmApiKey`, or `config.llmProvider` set to `ollama` or `custom`, both of which the app
accepts without an API key (`custom` wants `LLM_API_URL` instead). `gemini` and `openai` require a key,
so they count only when `secrets.llmApiKey` is also set.

Full behaviour, the tool set and the honest limitations are in the project's `docs/AGENT.md`.

## Production Setup (Ingress + HA)

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=StrongPass123 \
  --set postgresql.enabled=true \
  --set postgresql.auth.password=pg-secret \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.hosts[0].host=libredb.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  --set "ingress.tls[0].secretName=libredb-tls" \
  --set "ingress.tls[0].hosts[0]=libredb.example.com" \
  --set autoscaling.enabled=true \
  --set podDisruptionBudget.enabled=true
```

### Traefik Ingress

```bash
helm install libredb libredb/libredb-studio \
  --set ingress.enabled=true \
  --set ingress.className=traefik \
  --set "ingress.annotations.traefik\.ingress\.kubernetes\.io/router\.entrypoints=websecure" \
  --set "ingress.hosts[0].host=libredb.example.com" \
  --set "ingress.hosts[0].paths[0].path=/" \
  --set "ingress.hosts[0].paths[0].pathType=Prefix" \
  # ... secrets omitted for brevity
```

## Rate Limiting Across Replicas

Studio's built-in rate limiter (login attempts, AI endpoints, and every database-reaching route —
query execution, schema browsing, maintenance, fleet health) keeps its counters in the application
process. With the default `replicaCount: 1` that is the whole deployment. **If you raise
`replicaCount` or enable `autoscaling`, each replica enforces the budget separately**, so N replicas
allow N times the configured limit. Studio does not ship a distributed limiter, and it is not
planned: an ingress already has one.

Enforce the same budgets at the ingress instead. With nginx:

```bash
helm install libredb libredb/libredb-studio \
  --set replicaCount=3 \
  --set ingress.enabled=true \
  --set ingress.className=nginx \
  --set "ingress.annotations.nginx\.ingress\.kubernetes\.io/limit-rpm=120" \
  --set "ingress.annotations.nginx\.ingress\.kubernetes\.io/limit-burst-multiplier=2"
```

With Traefik, attach a `rateLimit` middleware and reference it from the ingress annotations.

Set `ALLOWED_ORIGINS` at the same time. Studio refuses any POST, PUT, PATCH or DELETE whose Origin
host does not match its own, and an ingress that rewrites the `Host` header to a service name
without setting `x-forwarded-host` will trip that on every request including login. The symptom is
a page that loads and then refuses every action with a 403. There is no dedicated values field for
it, so pass it through `extraEnv`:

```bash
helm install libredb libredb/libredb-studio \
  --set extraEnv[0].name=ALLOWED_ORIGINS \
  --set extraEnv[0].value=https://libredb.example.com
```

### The Content-Security-Policy escape hatch

Studio's `Content-Security-Policy` is enforced by default. If an upgrade breaks a resource you
serve from a non-default origin (a self-hosted Monaco bundle, a CDN in front of static assets),
downgrade it to report-only without a rebuild — it is a plain runtime environment variable, also
passed through `extraEnv`:

```bash
helm install libredb libredb/libredb-studio \
  --set extraEnv[0].name=CSP_REPORT_ONLY \
  --set extraEnv[0].value="true"
```

In report-only mode the browser logs the same violation to its console instead of blocking the
resource. Please also open an issue naming the violated directive.

Setting both `ALLOWED_ORIGINS` and `CSP_REPORT_ONLY` at once needs a distinct index per entry —
`extraEnv` is a list, and `--set` on the same index (`extraEnv[0]` in both examples above) just
overwrites the one element, so copying both snippets into a single command silently keeps only the
second variable:

```bash
helm install libredb libredb/libredb-studio \
  --set extraEnv[0].name=ALLOWED_ORIGINS \
  --set extraEnv[0].value=https://libredb.example.com \
  --set extraEnv[1].name=CSP_REPORT_ONLY \
  --set extraEnv[1].value="true"
```

### Separating the storage encryption key

With `STORAGE_PROVIDER` set to `sqlite` or `postgres`, connection credentials are encrypted at rest
using a key derived from `JWT_SECRET`. Nothing needs configuring for that to work. Set
`STORAGE_ENCRYPTION_KEY` when you want the two separated — most usefully so rotating the
session-signing secret does not invalidate every saved connection password, and, for
`STORAGE_PROVIDER=sqlite`, so a backup or volume snapshot of `/app/data` does not also carry the
key that opens the ciphertext it contains (with nothing set, the fallback key is persisted in that
same directory, alongside the database file):

```bash
helm install libredb libredb/libredb-studio \
  --set extraEnv[0].name=STORAGE_ENCRYPTION_KEY \
  --set extraEnv[0].valueFrom.secretKeyRef.name=libredb-studio-storage \
  --set extraEnv[0].valueFrom.secretKeyRef.key=encryption-key
```

Rotating the key makes existing stored credentials unreadable — the connections survive and their
passwords are omitted. See
[docs/STORAGE.md](https://github.com/libredb/libredb-studio/blob/main/docs/STORAGE.md#credential-encryption-at-rest).

## External Secrets

Use `secrets.existingSecret` to reference a secret managed by External Secrets Operator, Sealed Secrets, or Vault:

```bash
helm install libredb libredb/libredb-studio \
  --set secrets.existingSecret=my-libredb-secret
```

Your external secret is referenced with these keys (customizable via `secrets.existingSecretKeys`):
- `jwt-secret`, `admin-password` — required in strict mode (the pod waits for them); in zero-config mode missing ones are generated at first start
- Optional: `admin-email`, `user-email`, `user-password` (the non-admin account exists only when `user-password` is set), `llm-api-key`, `oidc-client-id`, `oidc-client-secret`, `storage-postgres-url`

## Upgrading

```bash
helm repo update
helm upgrade libredb libredb/libredb-studio
```

> **Behavior change:** the chart default flipped from strict (`config.authBootstrap: "off"`)
> to zero-config (`""`). Releases that relied on the old default become zero-config on
> upgrade: missing `secrets.jwtSecret`/`secrets.adminPassword` no longer fail the install,
> and with `secrets.existingSecret` the auth env references become `optional: true` — a pod
> whose external Secret is missing a key now starts with generated credentials instead of
> waiting in `CreateContainerConfigError`. To keep the previous fail-closed behavior, set
> `config.authBootstrap=off` explicitly.

## Uninstalling

```bash
helm uninstall libredb
```

> **Note:** PVCs are not deleted automatically. To remove persistent data:
> ```bash
> kubectl delete pvc -l app.kubernetes.io/instance=libredb
> ```

## Configuration Reference

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of replicas | `1` |
| `image.repository` | Container image | `ghcr.io/libredb/libredb-studio` |
| `image.tag` | Image tag | `""` (Chart appVersion) |
| `image.pullPolicy` | Pull policy | `IfNotPresent` |
| `authProvider` | Auth mode: local or oidc | `local` |
| `config.authBootstrap` | Auth bootstrap: `""` (zero-config, app default), `on` (explicit zero-config), `off` (strict) | `""` |
| `secrets.jwtSecret` | JWT signing secret: empty (zero-config) or >= 32 chars (schema-enforced) | `""` |
| `secrets.adminEmail` | Admin email | `admin@libredb.org` |
| `secrets.adminPassword` | Admin password | `""` |
| `secrets.userEmail` | User email | `user@libredb.org` |
| `secrets.userPassword` | User password (optional; enables the non-admin account) | `""` |
| `secrets.existingSecret` | Use existing Secret | `""` |
| `config.storageProvider` | Storage: local, sqlite, postgres | `local` |
| `config.llmProvider` | AI provider | `""` |
| `agent.enabled` | Explicit off-switch for the agent runtime. Unset writes nothing and the app derives availability (a configured model plus a writable ledger); `false` writes `LIBREDB_AGENT_ENABLED=false`; `true` declines the off-switch but cannot conjure a model. Rendering fails when an agent could run above one replica | unset |
| `persistence.enabled` | Enable PVC | `false` |
| `persistence.size` | PVC size | `1Gi` |
| `persistence.emptyDirSizeLimit` | Cap the `/app/data` emptyDir used when persistence is off (e.g. `512Mi`); empty means unlimited | `""` |
| `persistence.fixPermissions` | Chown the mounted volume to `runAsUser:fsGroup` in a root init container (hostPath / static PVs the kubelet does not `fsGroup`). Rendering fails when the OpenShift security-context adaptation is active - restricted-v2 rejects a root container and the UID/GID come from the namespace range there | `false` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `ingress.enabled` | Enable Ingress | `false` |
| `route.labels` | Labels added to every enabled route (a per-route label with the same key wins); `labels` is therefore a reserved key name and cannot be a route name | `{}` |
| `route.annotations` | Annotations added to every enabled route (a per-route annotation with the same key wins); reserved key name, as `route.labels` | `{}` |
| `route.main.enabled` | Enables or disables the route | `false` |
| `route.main.additionalRules` | Additional custom rules appended to `spec.rules` | `[]` |
| `route.main.annotations` | Annotations for this route only | `{}` |
| `route.main.apiVersion` | Route apiVersion, e.g. `gateway.networking.k8s.io/v1` or `gateway.networking.k8s.io/v1alpha2` | `gateway.networking.k8s.io/v1` |
| `route.main.filters` | Filters applied to requests matching this rule | `[]` |
| `route.main.hostnames` | Hostnames for the route | `[]` |
| `route.main.httpsRedirect` | Redirect to HTTPS (HTTP 301) instead of routing to the Service | `false` |
| `route.main.kind` | Route kind; only `HTTPRoute` is supported (schema-enforced) | `HTTPRoute` |
| `route.main.labels` | Labels for this route only | `{}` |
| `route.main.matches[0].path.type` | Path match type | `PathPrefix` |
| `route.main.matches[0].path.value` | Path match value | `/` |
| `route.main.parentRefs` | Gateways to attach to; required when the route is enabled (rendering fails without it, since it cannot be defaulted) | `[]` |
| `autoscaling.enabled` | Enable HPA (ignored with SQLite storage: single-writer) | `false` |
| `autoscaling.minReplicas` | Min replicas | `2` |
| `autoscaling.maxReplicas` | Max replicas | `10` |
| `podDisruptionBudget.enabled` | Enable PDB | `false` |
| `podDisruptionBudget.minAvailable` | Min available pods (set only one of minAvailable/maxUnavailable) | `1` |
| `podDisruptionBudget.maxUnavailable` | Max unavailable pods (unset minAvailable with `null` to use) | unset |
| `networkPolicy.enabled` | Enable NetworkPolicy | `false` |
| `postgresql.enabled` | Deploy PostgreSQL subchart | `false` |
| `global.compatibility.openshift.adaptSecurityContext` | Drop fixed UID/GID fields for the OpenShift SCC: `auto`, `force`, or `disabled` | `auto` |

See [values.yaml](values.yaml) for the complete list of configurable parameters.

## OpenShift

OpenShift's `restricted-v2` SCC assigns `runAsUser`/`fsGroup` from a
per-namespace range and rejects pods that hard-code IDs outside it. With the
default `global.compatibility.openshift.adaptSecurityContext: auto`, the chart
detects OpenShift (via the `security.openshift.io/v1` API group) and omits its
fixed `runAsUser`/`runAsGroup`/`fsGroup` so the SCC can assign valid IDs;
`runAsNonRoot` and the seccomp profile are kept. The image supports arbitrary
UIDs: every writable path is a volume mount. Set `force` to always adapt (for
example when templating manifests offline for an OpenShift cluster) or
`disabled` to keep the fixed IDs everywhere.

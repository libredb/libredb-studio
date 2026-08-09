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
  --version 0.1.30 \
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
| `persistence.enabled` | Enable PVC | `false` |
| `persistence.size` | PVC size | `1Gi` |
| `persistence.emptyDirSizeLimit` | Cap the `/app/data` emptyDir used when persistence is off (e.g. `512Mi`); empty means unlimited | `""` |
| `persistence.fixPermissions` | Chown the mounted volume to `runAsUser:fsGroup` in a root init container (hostPath / static PVs the kubelet does not `fsGroup`). Rendering fails when the OpenShift security-context adaptation is active - restricted-v2 rejects a root container and the UID/GID come from the namespace range there | `false` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `80` |
| `ingress.enabled` | Enable Ingress | `false` |
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

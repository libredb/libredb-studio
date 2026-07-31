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
  --version 0.1.24 \
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

**Strict mode** (`--set config.authBootstrap=off`) restores fail-closed behavior: `secrets.jwtSecret` and `secrets.adminPassword` are required (or use `secrets.existingSecret`) and the install fails fast with a clear message when either is missing; with an existing secret the pod will not start until the referenced keys exist. Recommended for production. `secrets.userPassword` stays optional in every mode. Setting `config.authBootstrap=on` is equivalent to the default `""`, just explicit.

## OIDC SSO

```bash
helm install libredb libredb/libredb-studio \
  --set authProvider=oidc \
  --set config.oidcIssuer=https://dev-xxx.auth0.com \
  --set secrets.oidcClientId=your-client-id \
  --set secrets.oidcClientSecret=your-client-secret \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
```

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

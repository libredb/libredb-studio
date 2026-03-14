# Helm Chart Architecture

## Overview

LibreDB Studio's Helm chart provides a production-grade Kubernetes deployment with security hardening, pluggable storage, autoscaling, and dual distribution (GitHub Pages + OCI).

## Distribution Channels

| Channel | URL | Command |
|---------|-----|---------|
| **ArtifactHub** | [artifacthub.io/packages/helm/libredb-studio/libredb-studio](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio) | Browse & discover |
| **Helm Repo** | `https://libredb.org/libredb-studio/` | `helm repo add libredb https://libredb.org/libredb-studio/` |
| **OCI Registry** | `oci://ghcr.io/libredb/charts/libredb-studio` | `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio` |

## Chart Structure

```
charts/libredb-studio/
├── Chart.yaml                 # Metadata, appVersion, Bitnami PostgreSQL dependency
├── values.yaml                # All configurable defaults
├── values.schema.json         # JSON Schema validation (helm lint --strict)
├── .helmignore                # Package exclusion patterns
├── README.md                  # Chart-level documentation
└── templates/
    ├── _helpers.tpl           # Named templates (labels, names, image, storage logic)
    ├── deployment.yaml        # App Deployment (checksum restart, emptyDir, probes)
    ├── service.yaml           # ClusterIP / NodePort / LoadBalancer
    ├── ingress.yaml           # Optional Ingress (nginx/traefik)
    ├── configmap.yaml         # Non-sensitive env vars (PORT, storage, LLM, OIDC)
    ├── secret.yaml            # Sensitive env vars (JWT, passwords, API keys)
    ├── serviceaccount.yaml    # SA with IRSA/Workload Identity annotations
    ├── hpa.yaml               # HorizontalPodAutoscaler (CPU + memory)
    ├── pdb.yaml               # PodDisruptionBudget
    ├── pvc.yaml               # PersistentVolumeClaim (SQLite mode)
    ├── networkpolicy.yaml     # Ingress/egress rules (DB ports, DNS, HTTPS)
    └── NOTES.txt              # Post-install usage instructions
```

## Architecture Decisions

### 1. Security Hardening

The chart enforces a restrictive security posture by default:

```yaml
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1001          # Matches Dockerfile (adduser --uid 1001 nextjs)
  runAsGroup: 1001
  fsGroup: 1001
  seccompProfile:
    type: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop: [ALL]
```

**readOnlyRootFilesystem + emptyDir**: Next.js writes to `.next/cache` at runtime. Two `emptyDir` volumes solve this without relaxing security:
- `/app/.next/cache` — Next.js ISR/build cache (ephemeral, per-pod)
- `/tmp` — Temporary files

### 2. Dockerfile Alignment

The chart is tightly coupled to the Dockerfile:

| Dockerfile | Chart |
|-----------|-------|
| `EXPOSE 3000/tcp` | `service.targetPort: 3000` |
| `adduser --uid 1001 nextjs` | `podSecurityContext.runAsUser: 1001` |
| `WORKDIR /app` | Volume mounts under `/app/` |
| `mkdir -p data` | PVC mounts at `/app/data` (SQLite mode) |
| `GET /api/db/health` | Startup/readiness/liveness probes |

### 3. Storage Modes

```
                ┌─────────────┐
                │ values.yaml │
                │ storageProvider │
                └──────┬──────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      ┌───────┐   ┌────────┐   ┌──────────┐
      │ local │   │ sqlite │   │ postgres │
      │       │   │        │   │          │
      │ No PVC│   │ Auto   │   │ External │
      │ No DB │   │ PVC    │   │ URL or   │
      │       │   │ create │   │ Subchart │
      └───────┘   └────────┘   └──────────┘
```

- **local** (default): Browser localStorage only. No server-side persistence.
- **sqlite**: Auto-creates PVC. Single-writer — do not use with multiple replicas.
- **postgres**: Two options:
  - `postgresql.enabled=true` → Deploys Bitnami subchart, auto-wires `STORAGE_POSTGRES_URL`
  - `secrets.storagePostgresUrl` → External PostgreSQL connection

**Auto-wiring logic** (`_helpers.tpl`):
```
if postgresql.enabled AND storageProvider == "local":
    effective storageProvider = "postgres"    # auto-switch
```

### 4. PostgreSQL Subchart Integration

When `postgresql.enabled=true`:

```
┌──────────────────────┐      ┌───────────────────────┐
│  LibreDB Studio Pod  │      │  PostgreSQL Pod        │
│                      │      │  (Bitnami subchart)    │
│  STORAGE_POSTGRES_URL├─────►│  :5432                 │
│  = postgresql://     │      │                        │
│    libredb:$PASS@    │      │  Secret:               │
│    <release>-pg:5432 │      │  <release>-postgresql   │
│    /libredb_storage  │      │                        │
└──────────────────────┘      └───────────────────────┘
```

Subchart secret name follows Bitnami convention: `<release-name>-postgresql` (not `<release>-<chart>-postgresql`).

### 5. Secret Management

```
┌─────────────────────────────────────────────┐
│            secrets.existingSecret            │
│                                             │
│  Set?  ──Yes──► Use external secret         │
│    │            (Vault/Sealed Secrets/ESO)   │
│    No           Skip secret.yaml rendering   │
│    │                                         │
│    ▼                                         │
│  secret.yaml rendered with:                  │
│  - required: jwtSecret, adminPassword,       │
│              userPassword                    │
│  - optional: llmApiKey, oidcClientId/Secret, │
│              storagePostgresUrl              │
└─────────────────────────────────────────────┘
```

`existingSecretKeys` allows custom key name mapping for external secrets.

### 6. ConfigMap / Environment Variables

All non-sensitive configuration flows through a ConfigMap:

| Variable | Source | Conditional |
|----------|--------|-------------|
| `NODE_ENV` | Fixed `production` | Always |
| `PORT` | `service.targetPort` | Always |
| `HOSTNAME` | Fixed `0.0.0.0` | Always |
| `NEXT_TELEMETRY_DISABLED` | Fixed `1` | Always |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `authProvider` | Always |
| `STORAGE_PROVIDER` | Auto-wired (see above) | Always |
| `STORAGE_SQLITE_PATH` | `config.storageSqlitePath` | When sqlite |
| `LLM_PROVIDER/MODEL/API_URL` | `config.llm*` | When set |
| `OIDC_*` | `config.oidc*` | When `authProvider=oidc` |

### 7. Pod Restart on Config Change

Deployment annotations include checksums of ConfigMap and Secret:

```yaml
annotations:
  checksum/config: {{ sha256sum configmap.yaml }}
  checksum/secret: {{ sha256sum secret.yaml }}
```

Any change to configuration values triggers a rolling restart automatically.

## Release Pipeline

```
Push to main (charts/** changed)
  │
  ▼
┌─────────────────────────────────────────┐
│  helm-release.yml                       │
│                                         │
│  Job 1: lint-test                       │
│    ├── ct lint (chart-testing)          │
│    ├── Kind cluster create              │
│    └── ct install (real cluster test)   │
│                                         │
│  Job 2: release-github-pages            │
│    ├── helm dependency build            │
│    └── chart-releaser-action            │
│        ├── GitHub Release (tag + .tgz)  │
│        └── gh-pages index.yaml update   │
│                                         │
│  Job 3: release-oci                     │
│    ├── helm dependency build            │
│    ├── helm package                     │
│    └── helm push → ghcr.io/libredb/charts│
└─────────────────────────────────────────┘
  │
  ▼
ArtifactHub auto-scan (~30 min)
```

### Version Management

- `Chart.yaml version` (e.g., `0.1.0`): Chart version, bumped for chart-only changes
- `Chart.yaml appVersion` (e.g., `0.8.10`): Must match `package.json` version
- CI enforces `appVersion == package.json.version` via the `helm-lint` job

## Deployment Examples

### Minimal (port-forward)
```bash
helm repo add libredb https://libredb.org/libredb-studio/
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123 \
  --set secrets.userPassword=MyUser123
kubectl port-forward svc/libredb-libredb-studio 3000:80
```

### Production (Ingress + PostgreSQL + HPA)
```bash
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=StrongPass123 \
  --set secrets.userPassword=StrongPass456 \
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

### External Secrets (Vault / ESO)
```bash
helm install libredb libredb/libredb-studio \
  --set secrets.existingSecret=my-vault-secret
```

## Known Limitations

1. **SQLite + Multi-Replica**: SQLite is single-writer. `storageProvider=sqlite` with `replicaCount > 1` will cause write conflicts. Use `postgres` for multi-replica.
2. **ISR Cache**: Next.js ISR cache is per-pod (emptyDir). Session-based app, so no impact.
3. **Chart appVersion**: Must be manually synced with `package.json` (CI validates but doesn't auto-bump).

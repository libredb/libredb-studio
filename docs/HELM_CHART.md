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
    ├── seed-configmap.yaml    # Optional seed-connections config (rendered when enabled)
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

**readOnlyRootFilesystem + writable volumes**: Next.js writes to `.next/cache` at runtime, and the app writes generated first-run credentials and the sample database into its data directory. Three writable mounts solve this without relaxing security:
- `/app/.next/cache` — emptyDir; Next.js ISR/build cache (ephemeral, per-pod)
- `/tmp` — emptyDir; temporary files
- `/app/data` — data directory (`auth-bootstrap.json`, sample database): emptyDir by default, the PVC when persistence is enabled

**OpenShift adaptation**: OpenShift's `restricted-v2` SCC assigns
`runAsUser`/`fsGroup` from a per-namespace range and rejects pods that
hard-code IDs outside it. `global.compatibility.openshift.adaptSecurityContext`
(default `auto`; same contract as the Bitnami subchart, so one value covers
both) makes the `libredb-studio.podSecurityContext` helper omit
`runAsUser`/`runAsGroup`/`fsGroup` when the API server exposes
`security.openshift.io/v1`, keeping `runAsNonRoot` and the seccomp profile.
Arbitrary UIDs are safe because every writable path is a volume mount and the
entrypoint execs directly when not running as root.

### 2. Dockerfile Alignment

The chart is tightly coupled to the Dockerfile:

| Dockerfile | Chart |
|-----------|-------|
| `EXPOSE 3000/tcp` | `service.targetPort: 3000` |
| `adduser --uid 1001 nextjs` | `podSecurityContext.runAsUser: 1001` |
| `WORKDIR /app` | Volume mounts under `/app/` |
| `mkdir -p data` | `/app/data` volume: PVC when persistence is enabled, emptyDir otherwise |
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
│  - strict (authBootstrap=off): required      │
│    jwtSecret, adminPassword                  │
│  - zero-config (default): only provided      │
│    values are written, missing ones are      │
│    generated by the app on first start       │
│  - optional: llmApiKey, oidcClientId/Secret, │
│              storagePostgresUrl              │
└─────────────────────────────────────────────┘
```

`existingSecretKeys` allows custom key name mapping for external secrets.

### 6. ConfigMap / Environment Variables

Most non-sensitive configuration flows through a ConfigMap (the seed-connection vars are the exception — see the note below the table):

| Variable | Source | Conditional |
|----------|--------|-------------|
| `NODE_ENV` | Fixed `production` | Always |
| `PORT` | `service.targetPort` | Always |
| `HOSTNAME` | Fixed `0.0.0.0` | Always |
| `NEXT_TELEMETRY_DISABLED` | Fixed `1` | Always |
| `NODE_OPTIONS` | Fixed `--max-old-space-size=384` | Always |
| `NEXT_PUBLIC_AUTH_PROVIDER` | `authProvider` | Always |
| `LOG_LEVEL` | `config.logLevel` | Always |
| `AUTH_BOOTSTRAP` | `config.authBootstrap` | When non-empty (chart default: `""` — omitted) |
| `STORAGE_PROVIDER` | Auto-wired (see above) | Always |
| `STORAGE_SQLITE_PATH` | `config.storageSqlitePath` | When sqlite |
| `SEED_CONFIG_PATH` / `SEED_CACHE_TTL_MS` | `seedConnections.*` — set **directly on the Deployment** (not via the ConfigMap) | When `seedConnections.enabled` |
| `LLM_PROVIDER/MODEL/API_URL` | `config.llm*` | When set |
| `OIDC_*` | `config.oidc*` | When `authProvider=oidc` |

**The chart follows the application's zero-config default** (`config.authBootstrap: ""` omits `AUTH_BOOTSTRAP`, so missing `JWT_SECRET`/`ADMIN_PASSWORD` are generated at first boot): a default-values install is fully working, which certified catalogs such as the Rancher partner-charts repository require. The architectural consequence for this document is that the deployment may only reference Secret keys that actually exist — the env entries for `JWT_SECRET`, `ADMIN_PASSWORD`, `USER_EMAIL`, `USER_PASSWORD` render only when their value is set or an `existingSecret` is used, and a mandatory `secretKeyRef` is reserved for the one combination where a missing key really is an error (strict mode with `authProvider=local`).

The behaviour itself — what gets generated, how to retrieve the credentials, what strict mode requires per auth provider, and the single-replica constraint — is documented once, in the chart's [`README.md`](../charts/libredb-studio/README.md#auth-bootstrap-zero-config-vs-strict). Treat that section as canonical and do not restate it here.

> For the complete, authoritative list of configurable values and defaults, see the chart's own [`README.md`](../charts/libredb-studio/README.md#configuration-reference). This document covers architecture and rationale; the chart README is the values reference.

### 7. Pod Restart on Config Change

Deployment annotations include checksums of ConfigMap and Secret:

```yaml
annotations:
  checksum/config: {{ sha256sum configmap.yaml }}
  checksum/secret: {{ sha256sum secret.yaml }}
```

Any change to configuration values triggers a rolling restart automatically.

### 8. Seed Connections

When `seedConnections.enabled=true`, the chart provisions a set of pre-defined database connections at startup:

- You **must** supply the definitions via **either** inline `seedConnections.config` (rendered into `seed-configmap.yaml`) **or** an `existingConfigMap`. Enabling the feature with neither **fails the render** with an explicit message (a template guard in `deployment.yaml`) — previously the Deployment shipped mounting a ConfigMap that was never rendered, and the pods failed at startup instead.
- The deployment mounts the ConfigMap at `/app/config/<key>`, where `<key>` is `seedConnections.configMapKey` (default `seed-connections.yaml`), and sets `SEED_CONFIG_PATH` to that path (plus `SEED_CACHE_TTL_MS` from `seedConnections.cacheTTL`). These two env vars are set on the Deployment directly, not through the app ConfigMap.
- Credentials referenced by the seed config resolve from environment/secret at runtime, so secrets stay out of the ConfigMap.

## Release Pipeline

The chart never releases before the image it deploys exists (#161), and the
whole flow is compatible with the repository's immutable-releases policy
(draft-first, #154/#155/#158). For a product release, `docker-build-push.yml`
dispatches `helm-release.yml` **on the release tag ref** after the image
publish succeeds - the chart is deliberately published from the tag's
snapshot (the same commit as the image), not from main HEAD; a chart-only
fix merged in between publishes separately via its own `charts/**` push run.

```
Push to main (charts/** changed)   OR   dispatched by docker-build-push
  │                                     after a successful image publish
  ▼
┌─────────────────────────────────────────┐
│  helm-release.yml                       │
│                                         │
│  Job 0: preflight gates                 │
│    ghcr image <appVersion> published?   │
│    ├── yes → proceed                    │
│    ├── no + push event → green no-op    │
│    │   (the release chain re-dispatches │
│    │    after the image is published)   │
│    └── no + dispatch → fail fast        │
│                                         │
│    chart <version> already released     │
│    with its .tgz? → skip jobs 2 and 3   │
│                                         │
│  Job 1: lint-test                       │
│    ├── ct lint (chart-testing)          │
│    ├── Kind cluster create              │
│    └── ct install (real cluster test)   │
│                                         │
│  Job 2: release-github-pages            │
│    ├── helm dependency build            │
│    ├── draft release + .tgz upload,     │
│    │   publish last (immutable-safe)    │
│    └── helm repo index --merge → push   │
│        gh-pages index.yaml              │
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

Do not manually dispatch `helm-release.yml` for a new appVersion before its
image is on GHCR - the gate fails fast by design. A failed image build
dispatches nothing, so the chart correctly stays unpublished. The gate
queries GHCR anonymously and relies on the image package being public.

The second preflight gate protects the published surfaces from re-publication
(#167). Immutable releases freeze the release asset, but the gh-pages index and
the OCI tag are mutable: both publish jobs re-package whatever `charts/**`
currently holds, so a `charts/**` merge that changed chart content without
bumping the chart version used to rewrite the released version's index digest
and its OCI copy while the asset kept the original bytes. When the release for
`libredb-studio-<version>` already exists, is published, and carries its
`.tgz`, jobs 2 and 3 are skipped and the run is a full no-op after `lint-test`.
A missing release, a leftover draft, or a published release without its asset
all still publish - the last one so the release job's loud immutability error
(#154) is what the run reports. Publishing chart changes therefore always means
bumping `version:`; `bun run chart:check` now refuses the un-bumped state at PR
time, so this gate is the backstop rather than the first line of defence.

The gate has one escape hatch, the `force_republish` dispatch input, for the
single case a version bump cannot fix: a run whose asset upload succeeded but
whose index or OCI push failed, leaving a released version missing from the
index (this happened to chart 0.1.5 and was hand-patched at the time). Dispatch
`helm-release.yml` with `force_republish=true` **on the released version's ref**
and only while `charts/**` is byte-identical to what that version shipped -
otherwise it does exactly the damage the gate exists to prevent. The release
chain's automated dispatch passes no inputs, so it can never take this path.

### Version Management

- `Chart.yaml version` (e.g., `0.1.4`): the chart's own SemVer. Chart-only fixes bump it
  alone; `bun run chart:bump` bumps its patch when tracking an app release.
- `Chart.yaml appVersion`: the app image version this chart deploys. **Always equals
  `package.json` version — enforced in CI.**
- Guard: `scripts/sync-chart-version.mjs` runs as `bun run chart:check` inside the required
  `Lint, Typecheck and Build` check (`ci.yml`), so a PR that bumps `package.json` cannot
  merge until `bun run chart:bump` is run and committed (issue #138). The guard also fails
  when `appVersion` changes without a chart `version` bump (chart-releaser's
  `skip_existing` would silently publish nothing) or when the new chart version was
  already released, and it keeps the `artifacthub.io/images` tag and the README
  `--version` example in step. The `artifacthub.io/changes` line is written by
  `chart:bump` but deliberately not checked, so hand-written changelog entries for
  chart-only releases never trip the guard.
- Guard (#167): a PR that changes any packaged file under `charts/libredb-studio/`
  while leaving the chart `version` at an **already-released** value fails the same
  check - re-publishing that version would mutate its gh-pages/OCI digest. Fix it by
  bumping `version:` (and the README `--version` examples) by hand: `chart:bump` only
  moves the chart version when `appVersion` is out of sync, so a chart-only content
  change needs the manual bump. Paths matched by the chart's `.helmignore` (`ci/`) are
  excluded because they never reach the packaged `.tgz`, and a version that has not
  been released yet stays freely editable.
- Base comparisons read main's `Chart.yaml` at the merge-base of `HEAD` and `origin/main`,
  so a release merged to `main` after your branch point cannot false-positive the
  already-released check on a stale branch (issue #151); in shallow checkouts with no
  computable merge-base (CI's depth-1 fetch), the `origin/main` tip is used as before,
  which is effectively exact on PR merge refs. CI sets `CHART_SYNC_STRICT=1`
  (`ci.yml`), which turns the guard's skip-and-warn paths (`origin/main` not resolvable,
  origin tags unreachable) into hard failures; unset locally, they stay warnings so
  offline runs still work.

#### Versioning policy: version and appVersion stay independent (researched 2026-07)

Lockstep (`version` == `appVersion`, the cert-manager model) was considered and rejected:
it only works when chart-only releases never happen. This chart still has an active
chart-only backlog, and under lockstep each such fix would either wait for the next
product release or force an artificial one through the full distribution pipeline (npm,
Docker, brew, deb/rpm, snap) — irreversible now that immutable releases are enabled.
SemVer prerelease suffixes are not an escape hatch (they sort *below* the version they
suffix and Helm hides prereleases by default), and kubernetes-sigs/kueue abandoned
lockstep for the same reasons (kueue#3971). Consumers still see the app version
everywhere it matters: the `APP VERSION` column in `helm search repo`, ArtifactHub, and
the `artifacthub.io/images` annotation. Revisit lockstep if the chart reaches 1.0 and
chart-only churn drops.

## Deployment Examples

### Minimal (port-forward)
```bash
helm repo add libredb https://libredb.org/libredb-studio/
helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123
kubectl port-forward svc/libredb-libredb-studio 3000:80
```

### Production (Ingress + PostgreSQL + HPA)
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

### External Secrets (Vault / ESO)
```bash
helm install libredb libredb/libredb-studio \
  --set secrets.existingSecret=my-vault-secret
```

## Known Limitations

1. **SQLite + Multi-Replica**: SQLite is single-writer. `storageProvider=sqlite` with `replicaCount > 1` will cause write conflicts. Use `postgres` for multi-replica. With SQLite storage `autoscaling.enabled` is ignored: the HPA is not rendered (NOTES.txt warns) and the deployment falls back to `replicaCount`.
2. **ISR Cache**: Next.js ISR cache is per-pod (emptyDir). Session-based app, so no impact.
3. **Chart appVersion**: Not auto-bumped - a version-bump PR must run `bun run chart:bump`; the CI sync guard blocks the merge until `appVersion` equals `package.json` (see Version Management above).

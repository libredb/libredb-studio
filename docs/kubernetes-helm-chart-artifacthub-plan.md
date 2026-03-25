# Helm Chart & ArtifactHub Setup – LibreDB Studio in Kubernetes Plan

## Context

The LibreDB Studio Docker image (`ghcr.io/libredb/libredb-studio`) and GitHub Actions CI/CD pipelines are already fully operational. However, there is currently no Helm chart or ArtifactHub integration for users who want to deploy LibreDB Studio on Kubernetes.

The goal of this plan is to create a **production-grade Helm chart** and publish it automatically to **ArtifactHub** through a release pipeline.

**Current state**

* Docker image publishing → `ghcr.io`
* CI pipeline → lint / typecheck / test / build
* Deployments → Fly.io and Render
* **Missing components** → Helm chart + Kubernetes support

---

# Directory Structure

```
charts/
  libredb-studio/
    Chart.yaml                    # Chart metadata + ArtifactHub annotations
    values.yaml                   # Default configuration values
    values.schema.json            # JSON Schema validation
    .helmignore                   # Files excluded from Helm packages
    README.md                     # Chart documentation
    templates/
      _helpers.tpl                # Named template helpers
      deployment.yaml             # Main application Deployment
      service.yaml                # ClusterIP/NodePort/LoadBalancer Service
      ingress.yaml                # Optional Ingress (nginx/traefik)
      configmap.yaml              # Non-sensitive environment variables
      secret.yaml                 # Sensitive environment variables
      serviceaccount.yaml         # ServiceAccount
      hpa.yaml                    # HorizontalPodAutoscaler
      pdb.yaml                    # PodDisruptionBudget
      pvc.yaml                    # PersistentVolumeClaim (SQLite mode)
      networkpolicy.yaml          # Optional NetworkPolicy
      NOTES.txt                   # Post-install usage instructions

artifacthub-repo.yml              # ArtifactHub repository metadata (project root)

.github/workflows/
  helm-release.yml                # Helm lint, test, and release pipeline
```

---

# Step 1 – `charts/libredb-studio/Chart.yaml`

Helm API version: **v2**

* `appVersion` → taken from `package.json` (`0.8.10`)
* `chart version` → `0.1.0`

```yaml
apiVersion: v2
name: libredb-studio
description: Web-based SQL IDE for cloud-native teams supporting PostgreSQL, MySQL, SQLite, Oracle, SQL Server, MongoDB, and Redis
type: application
version: 0.1.0
appVersion: "0.8.10"
kubeVersion: ">=1.26.0-0"
home: https://github.com/libredb/libredb-studio
icon: https://raw.githubusercontent.com/libredb/libredb-studio/main/public/logo.svg
sources:
  - https://github.com/libredb/libredb-studio
keywords:
  - sql
  - ide
  - database
  - postgresql
  - mysql
  - mongodb
  - redis
  - sqlite
  - oracle
  - mssql
  - web-ide
maintainers:
  - name: cevheri
    url: https://github.com/cevheri
annotations:
  artifacthub.io/category: database
  artifacthub.io/license: MIT
  artifacthub.io/prerelease: "true"
  artifacthub.io/containsSecurityUpdates: "false"
  artifacthub.io/images: |
    - name: libredb-studio
      image: ghcr.io/libredb/libredb-studio:0.8.10
      platforms:
        - linux/amd64
  artifacthub.io/links: |
    - name: Documentation
      url: https://github.com/libredb/libredb-studio#readme
    - name: Container Image
      url: https://github.com/libredb/libredb-studio/pkgs/container/libredb-studio
    - name: Source
      url: https://github.com/libredb/libredb-studio
  artifacthub.io/changes: |
    - Initial Helm chart release
dependencies:
  - name: postgresql
    version: "16.x.x"
    repository: https://charts.bitnami.com/bitnami
    condition: postgresql.enabled
```

---

# Step 2 – `values.yaml`

All configuration keys use **camelCase** and include clear documentation.

### Image & Replica Settings

* `image.repository: ghcr.io/libredb/libredb-studio`
* `image.tag: ""` → defaults to `Chart.appVersion`
* `image.pullPolicy: IfNotPresent`
* `replicaCount: 1`

---

### Secrets (stored in Kubernetes Secret)

Examples:

* `secrets.jwtSecret`
* `secrets.adminEmail`
* `secrets.adminPassword`
* `secrets.userEmail`
* `secrets.userPassword`
* `secrets.llmApiKey`
* `secrets.oidcClientId`
* `secrets.oidcClientSecret`
* `secrets.storagePostgresUrl`

External secret integration:

```
secrets.existingSecret: ""
secrets.existingSecretKeys: {}
```

Supports integrations like:

* External Secrets Operator
* Sealed Secrets
* HashiCorp Vault

---

### Config (stored in ConfigMap)

Key settings include:

```
authProvider: local        # local | oidc
config.logLevel: info
config.storageProvider: local    # local | sqlite | postgres
config.storageSqlitePath: /app/data/libredb-storage.db
```

Optional configuration for:

* AI providers
* OIDC SSO

---

### Persistence (SQLite Mode)

```
persistence.enabled: false
persistence.size: 1Gi
persistence.accessModes: [ReadWriteOnce]
persistence.existingClaim: ""
```

Persistence automatically enables when `storageProvider=sqlite`.

---

### Security

Example secure defaults:

```
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 1001
  runAsGroup: 1001
  fsGroup: 1001
  seccompProfile: RuntimeDefault

securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL
```

---

### Health Probes

Using Dockerfile health endpoint:

```
GET /api/db/health
```

Probes:

* **startupProbe** → fast startup detection
* **readinessProbe** → traffic readiness
* **livenessProbe** → container health monitoring

---

### Resources

```
requests:
  cpu: 100m
  memory: 256Mi

limits:
  memory: 512Mi
```

---

### Networking

```
service.type: ClusterIP
service.port: 80
service.targetPort: 3000
```

Optional:

* Ingress
* NetworkPolicy

---

### Scaling & High Availability

Optional features:

```
autoscaling.enabled: false
podDisruptionBudget.enabled: false
```

---

### PostgreSQL Subchart

Optional internal database:

```
postgresql.enabled: false
postgresql.auth.username
postgresql.auth.password
postgresql.auth.database
```

---

# Step 3 – `_helpers.tpl`

Common Helm helper templates:

* `libredb-studio.name`
* `libredb-studio.fullname`
* `libredb-studio.chart`
* `libredb-studio.labels`
* `libredb-studio.selectorLabels`
* `libredb-studio.serviceAccountName`
* `libredb-studio.secretName`
* `libredb-studio.configMapName`
* `libredb-studio.pvcName`
* `libredb-studio.persistenceEnabled`
* `libredb-studio.image`

These helpers standardize naming, labels, and resource references.

---

# Step 4 – `deployment.yaml`

Important design decisions:

### 1. Config checksum annotations

Pods restart automatically when ConfigMaps or Secrets change.

### 2. readOnlyRootFilesystem compatibility

Next.js writes runtime cache to:

```
/app/.next/cache
```

Solution:

```
emptyDir volume mount
```

Also used for `/tmp`.

---

### 3. Conditional PVC Mount

```
/app/data
```

Mounted only when using **SQLite storage mode**.

---

### 4. Environment variables

Sources:

* ConfigMap
* Secret references
* optional `extraEnv`

---

### Dockerfile compatibility

Deployment settings match the container configuration:

| Setting        | Value              |
| -------------- | ------------------ |
| Port           | 3000               |
| User           | UID 1001           |
| Workdir        | `/app`             |
| Data directory | `/app/data`        |
| Next.js cache  | `/app/.next/cache` |

---

# Step 5 – `configmap.yaml`

Fixed environment variables:

```
NODE_ENV=production
PORT=3000
HOSTNAME=0.0.0.0
NEXT_TELEMETRY_DISABLED=1
NODE_OPTIONS=--max-old-space-size=384
```

Dynamic variables include:

* authProvider
* storageProvider
* logLevel
* OIDC settings
* AI settings

Smart default:

If `postgresql.enabled=true` and storageProvider=local → automatically switch to PostgreSQL.

---

# Step 6 – `secret.yaml`

Behavior:

* If `secrets.existingSecret` is set → Helm **does not generate a Secret**
* Otherwise Helm creates a Secret with:

```
jwtSecret
adminEmail
adminPassword
userEmail
userPassword
```

Optional values:

* `llmApiKey`
* `oidcClientSecret`
* `storagePostgresUrl`

---

# Step 7 – Additional Templates

Includes:

* `service.yaml`
* `ingress.yaml`
* `serviceaccount.yaml`
* `hpa.yaml`
* `pdb.yaml`
* `pvc.yaml`
* `networkpolicy.yaml`
* `NOTES.txt`

These resources are conditionally rendered depending on values.

---

# Step 8 – `values.schema.json`

Uses **JSON Schema Draft-07** to validate Helm values.

Examples:

```
authProvider: enum [local, oidc]
storageProvider: enum [local, sqlite, postgres]
logLevel: enum [debug, info, warn, error]
service.type: enum [ClusterIP, NodePort, LoadBalancer]
```

Additional validations:

* `replicaCount ≥ 1`
* storage size format validation
* email format validation

---

# Step 9 – `.helmignore`

```
.git
.gitignore
.github
.vscode
.idea
*.swp
*.bak
*.tmp
*.orig
.DS_Store
ci/
```

---

# Step 10 – `artifacthub-repo.yml`

Located in the **project root**.

```yaml
repositoryID: libredb-studio
owners:
  - name: cevheri
    email: cevheri@users.noreply.github.com
```

---

# Step 11 – GitHub Workflow (`helm-release.yml`)

Pipeline contains **three jobs**.

### Job 1 – lint-test

Tools used:

* `helm/chart-testing-action`
* `helm/kind-action`

Steps:

1. Lint Helm chart
2. Create temporary Kubernetes cluster
3. Install chart and run tests

---

### Job 2 – release-github-pages

Uses:

```
helm/chart-releaser-action
```

Outputs:

* `index.yaml`
* Helm repository hosted on GitHub Pages

Repository URL:

```
https://libredb.github.io/libredb-studio/
```

---

### Job 3 – release-oci

Publishes the chart to an OCI registry.

Steps:

```
helm dependency build
helm package
helm push
```

Target registry:

```
oci://ghcr.io/libredb/charts
```

Authentication via `GITHUB_TOKEN`.

---

# Step 12 – Chart README

`charts/libredb-studio/README.md` includes:

* Overview
* Badges
* Installation guide
* Storage modes
* OIDC setup
* AI configuration
* High availability configuration
* Ingress examples
* External Secrets integration
* Upgrade guide
* Full configuration reference table

---

# Installation Examples

## Minimal Installation

```
helm repo add libredb https://libredb.github.io/libredb-studio

helm install libredb libredb/libredb-studio \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123 \
  --set secrets.userPassword=MyUser123
```

---

## Production Installation

Example with:

* PostgreSQL
* Ingress
* Autoscaling

(Commands remain unchanged.)

---

# Important Design Decisions

### Next.js Cache

Next.js writes cache files at runtime.

Solution:

```
emptyDir volume
```

Cache is ephemeral but acceptable because LibreDB Studio is session-based.

---

### SQLite Multi-Replica Warning

SQLite supports only **one writer**.

If:

```
storageProvider=sqlite
replicaCount > 1
```

the README includes a warning.

---

### PostgreSQL Subchart Integration

When `postgresql.enabled=true`:

* storage provider automatically switches to PostgreSQL
* connection URL generated automatically
* credentials read from the subchart secret

---

### existingSecret Pattern

Encourages production-grade secret management with:

* Vault
* Sealed Secrets
* External Secrets Operator

---

### Dual Distribution Strategy

Charts are published to both:

1. GitHub Pages (classic Helm repo)
2. OCI registry (`ghcr.io`)

ArtifactHub supports both.

---

# Verification

## Local Testing

Steps:

```
helm lint charts/libredb-studio
helm template ...
helm install ...
```

Includes:

* lint validation
* schema validation
* installation test on a Kind cluster

---

# Implementation Order

Recommended order of implementation:

1. `.helmignore`
2. `Chart.yaml`
3. `values.yaml`
4. `values.schema.json`
5. `_helpers.tpl`
6. `configmap.yaml`
7. `secret.yaml`
8. `serviceaccount.yaml`
9. `deployment.yaml`
10. `service.yaml`
11. `ingress.yaml`
12. `hpa.yaml`
13. `pdb.yaml`
14. `pvc.yaml`
15. `networkpolicy.yaml`
16. `NOTES.txt`
17. `README.md`
18. `artifacthub-repo.yml`
19. `helm-release.yml`
20. Final verification with `helm lint` and `helm dependency build`

---

# ArtifactHub Setup Guide

Steps performed **after the code is implemented**.

---

## 1 – Enable GitHub Pages

Repository → **Settings → Pages**

Source:

```
Deploy from a branch
```

Branch:

```
gh-pages
```

Result:

```
https://libredb.github.io/libredb-studio/
```

---

## 2 – Create ArtifactHub Organization

Go to:

[https://artifacthub.io](https://artifacthub.io)

Sign in with GitHub.

Create organization:

```
Name: libredb
Display Name: LibreDB
Home URL: https://github.com/libredb
Description: Open-source database tools for cloud-native teams
```

---

## 3 – Add Helm Repository

ArtifactHub → Control Panel → Repositories → Add

```
Kind: Helm charts
Name: libredb-studio
URL: https://libredb.github.io/libredb-studio/
Organization: libredb
```

ArtifactHub scans the repo automatically.

---

## 4 – Add OCI Repository (Optional)

```
oci://ghcr.io/libredb/charts/libredb-studio
```

---

## 5 – Verified Publisher Badge

Requirements:

* `artifacthub-repo.yml` in repository
* Hosted Helm repo

ArtifactHub verifies ownership automatically.

---

## 6 – Official Status (Optional)

Once verified:

```
Control Panel → Organization → Request Official Status
```

ArtifactHub performs a manual review.

---

# Final Result

LibreDB Studio Helm chart will be available at:

**ArtifactHub**

[https://artifacthub.io/packages/helm/libredb-studio/libredb-studio](https://artifacthub.io/packages/helm/libredb-studio/libredb-studio)

**Helm repository**

```
helm repo add libredb https://libredb.github.io/libredb-studio
```

**OCI registry**

```
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio
```


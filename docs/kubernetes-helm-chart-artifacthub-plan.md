# Helm Chart & ArtifactHub Kurulumu - LibreDB Studio

## Context

LibreDB Studio'nun Docker image'ı (`ghcr.io/libredb/libredb-studio`) ve GitHub Actions CI/CD pipeline'ları tam ve çalışır durumda. Ancak Kubernetes'e kurulum yapanlar için Helm chart ve ArtifactHub entegrasyonu eksik. Bu plan, production-grade bir Helm chart oluşturup, otomatik release pipeline'ı ile ArtifactHub'da yayınlamayı hedefliyor.

**Mevcut durum:** Docker image push (ghcr.io), CI (lint/typecheck/test/build), Fly.io + Render deploy mevcut. Helm/K8s yapısı yok.

---

## Dosya Yapısı

```
charts/
  libredb-studio/
    Chart.yaml                    # Chart metadata + ArtifactHub annotations
    values.yaml                   # Tüm konfigürasyon defaults
    values.schema.json            # JSON Schema validation
    .helmignore                   # Package exclusion patterns
    README.md                     # Chart documentation
    templates/
      _helpers.tpl                # Named template helpers (labels, names, etc.)
      deployment.yaml             # Ana uygulama Deployment
      service.yaml                # ClusterIP/NodePort/LoadBalancer Service
      ingress.yaml                # Optional Ingress (nginx/traefik)
      configmap.yaml              # Non-sensitive env vars
      secret.yaml                 # Sensitive env vars (JWT, passwords)
      serviceaccount.yaml         # ServiceAccount (IRSA/Workload Identity uyumlu)
      hpa.yaml                    # HorizontalPodAutoscaler
      pdb.yaml                    # PodDisruptionBudget
      pvc.yaml                    # PersistentVolumeClaim (SQLite mode)
      networkpolicy.yaml          # Optional NetworkPolicy
      NOTES.txt                   # Post-install kullanım notları
artifacthub-repo.yml              # Repo-level ArtifactHub metadata (proje kökünde)
.github/workflows/
  helm-release.yml                # Chart lint + test + release pipeline
```

---

## Adım 1: `charts/libredb-studio/Chart.yaml`

Helm v2 API, appVersion `0.8.10` (package.json'dan), chart version `0.1.0`.

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

## Adım 2: `charts/libredb-studio/values.yaml`

Tüm değerler camelCase, iyi dokümante edilmiş. Kritik bölümler:

### Image & Replica
- `image.repository: ghcr.io/libredb/libredb-studio`
- `image.tag: ""` (default → Chart.appVersion)
- `image.pullPolicy: IfNotPresent`
- `replicaCount: 1`

### Secrets (K8s Secret'a gider)
- `secrets.jwtSecret`, `secrets.adminEmail/Password`, `secrets.userEmail/Password`
- `secrets.llmApiKey`, `secrets.oidcClientId/Secret`, `secrets.storagePostgresUrl`
- `secrets.existingSecret: ""` — External Secrets Operator / Sealed Secrets / Vault entegrasyonu
- `secrets.existingSecretKeys: {...}` — key name mapping for existing secrets

### Config (ConfigMap'e gider)
- `authProvider: local` (local | oidc)
- `config.logLevel: "info"`
- `config.storageProvider: "local"` (local | sqlite | postgres)
- `config.storageSqlitePath: "/app/data/libredb-storage.db"`
- `config.llmProvider/llmModel/llmApiUrl` (optional AI)
- `config.oidcIssuer/oidcScope/oidcRoleClaim/oidcAdminRoles` (optional SSO)

### Persistence (SQLite mode için PVC)
- `persistence.enabled: false` (auto-enable when storageProvider=sqlite)
- `persistence.size: 1Gi`, `accessModes: [ReadWriteOnce]`
- `persistence.existingClaim: ""`

### Security
- `podSecurityContext: { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 1001, fsGroup: 1001, seccompProfile: RuntimeDefault }`
- `securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities.drop: [ALL] }`
- `serviceAccount.automountServiceAccountToken: false`

### Probes (Dockerfile'daki `/api/db/health` GET endpoint'ini kullanır)
- `startupProbe: httpGet /api/db/health, failureThreshold: 30, periodSeconds: 2` (max 60s startup)
- `readinessProbe: httpGet /api/db/health, initialDelay: 5s, period: 10s`
- `livenessProbe: httpGet /api/db/health, initialDelay: 30s, period: 30s`

### Resources
- `requests: { cpu: 100m, memory: 256Mi }`
- `limits: { memory: 512Mi }`

### Networking
- `service.type: ClusterIP`, `service.port: 80`, `service.targetPort: 3000`
- `ingress.enabled: false` — hosts, paths, TLS, className, annotations
- `networkPolicy.enabled: false`

### Scaling & HA
- `autoscaling.enabled: false` — minReplicas: 2, maxReplicas: 10, CPU: 75%, Memory: 80%
- `podDisruptionBudget.enabled: false` — minAvailable: 1

### PostgreSQL Subchart
- `postgresql.enabled: false` — enable for built-in storage DB
- `postgresql.auth.username/password/database`

### Extras
- `extraEnv: []`, `extraEnvFrom: []`
- `nodeSelector: {}`, `tolerations: []`, `affinity: {}`
- `topologySpreadConstraints: []`
- `demo.enabled: false` — demo DB config

---

## Adım 3: `templates/_helpers.tpl`

Standard Helm helpers:
- `libredb-studio.name` — chart name (truncated 63 chars)
- `libredb-studio.fullname` — release-aware full name
- `libredb-studio.chart` — `name-version` label value
- `libredb-studio.labels` — common labels (helm.sh/chart, app.kubernetes.io/*)
- `libredb-studio.selectorLabels` — selector labels (name + instance)
- `libredb-studio.serviceAccountName` — conditional SA name
- `libredb-studio.secretName` — existing secret or generated
- `libredb-studio.configMapName` — `fullname-config`
- `libredb-studio.pvcName` — existing claim or generated
- `libredb-studio.persistenceEnabled` — `true` if persistence.enabled OR storageProvider=sqlite
- `libredb-studio.image` — `repository:tag` (tag defaults to appVersion)

---

## Adım 4: `templates/deployment.yaml`

Kritik tasarım kararları:
1. **checksum annotations**: ConfigMap/Secret değişince pod restart
2. **readOnlyRootFilesystem uyumluluğu**: `/app/.next/cache` ve `/tmp` için emptyDir volume mount (Next.js runtime'da cache'e yazıyor)
3. **Conditional `/app/data` PVC mount**: Sadece SQLite mode'da
4. **envFrom**: ConfigMap ref + extraEnvFrom
5. **env**: Secret key refs (jwt, admin, user, llm, oidc, postgres — conditional)
6. **PostgreSQL subchart entegrasyonu**: `postgresql.enabled=true` ise subchart secret'tan password okuma

**Dockerfile ile uyum noktaları:**
- Container port: `3000` (Dockerfile EXPOSE 3000/tcp)
- UID: `1001` (Dockerfile `adduser --uid 1001 nextjs`)
- Workdir: `/app` (Dockerfile WORKDIR /app)
- Data dir: `/app/data` (Dockerfile `mkdir -p data`)
- Next.js cache: `/app/.next/cache` (standalone output)

---

## Adım 5: `templates/configmap.yaml`

Fixed env vars: `NODE_ENV=production`, `PORT=3000`, `HOSTNAME=0.0.0.0`, `NEXT_TELEMETRY_DISABLED=1`, `NODE_OPTIONS=--max-old-space-size=384`

Dynamic env vars: authProvider, logLevel, storageProvider, storageSqlitePath, llm*, oidc*, demo*

**Smart default**: `postgresql.enabled=true` ve `storageProvider=local` ise otomatik `postgres`'a override.

---

## Adım 6: `templates/secret.yaml`

- `secrets.existingSecret` set ise tamamen skip (whole resource not rendered)
- Base64 encoded data: jwtSecret, adminEmail/Password, userEmail/Password, + conditional: llmApiKey, oidcClientId/Secret, storagePostgresUrl
- `existingSecretKeys` ile custom key name mapping

---

## Adım 7: Diğer Templates

- **service.yaml**: ClusterIP default, port 80→3000, optional NodePort
- **ingress.yaml**: Conditional, networking.k8s.io/v1, className, TLS, multi-host paths
- **serviceaccount.yaml**: Conditional, annotations (IRSA/Workload Identity), automountToken: false
- **hpa.yaml**: autoscaling/v2, CPU + memory targets, custom behavior
- **pdb.yaml**: policy/v1, minAvailable veya maxUnavailable
- **pvc.yaml**: Auto-create when persistenceEnabled (sqlite), skip if existingClaim
- **networkpolicy.yaml**: Ingress (port 3000), egress (DNS + HTTPS), custom rules
- **NOTES.txt**: Access URL (ingress/nodeport/port-forward), config summary, health check command, JWT warning

---

## Adım 8: `values.schema.json`

JSON Schema Draft-07 ile validation:
- `authProvider`: enum [local, oidc]
- `config.storageProvider`: enum [local, sqlite, postgres]
- `config.logLevel`: enum [debug, info, warn, error]
- `image.pullPolicy`: enum [Always, IfNotPresent, Never]
- `service.type`: enum [ClusterIP, NodePort, LoadBalancer]
- `replicaCount`: integer, minimum 1
- `persistence.size`: pattern `^[0-9]+(Gi|Mi|Ti)$`
- `secrets.adminEmail/userEmail`: format email

---

## Adım 9: `.helmignore`

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

## Adım 10: `artifacthub-repo.yml` (proje kökünde)

```yaml
repositoryID: libredb-studio
owners:
  - name: cevheri
    email: cevheri@users.noreply.github.com
```

---

## Adım 11: `.github/workflows/helm-release.yml`

3 job'lu pipeline:

### Job 1: `lint-test`
- `helm/chart-testing-action` ile lint (`ct lint`)
- `helm/kind-action` ile ephemeral K8s cluster
- `ct install` ile gerçek cluster'da test (required secrets --set ile)

### Job 2: `release-github-pages` (needs: lint-test)
- `helm/chart-releaser-action@v1.6.0` ile GitHub Pages'a release
- `gh-pages` branch'ine `index.yaml` oluşturur
- Repo URL: `https://libredb.github.io/libredb-studio/`
- Bitnami repo add (subchart dependency için)

### Job 3: `release-oci` (needs: lint-test)
- `helm dependency build` → `helm package` → `helm push`
- OCI target: `oci://ghcr.io/libredb/charts`
- ghcr.io login via GITHUB_TOKEN

**Trigger**: push to main (paths: `charts/**`) + workflow_dispatch

---

## Adım 12: `charts/libredb-studio/README.md`

Sections:
- Overview + badges (ArtifactHub, Helm version, K8s version)
- Prerequisites
- Quick Start (3 komutluk install)
- Storage Modes (local / sqlite / postgres) örneklerle
- OIDC SSO setup
- AI configuration
- HA mode (HPA + PDB + multi-replica)
- Ingress/TLS (nginx + traefik örnekler)
- External Secrets entegrasyonu
- Upgrading / Uninstalling
- Configuration reference table

---

## Kurulum Örnekleri (README'de yer alacak)

### Minimal (port-forward ile test)
```bash
helm repo add libredb https://libredb.github.io/libredb-studio
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

### OCI Registry ile kurulum
```bash
helm install libredb oci://ghcr.io/libredb/charts/libredb-studio \
  --version 0.1.0 \
  --set secrets.jwtSecret=$(openssl rand -base64 32) \
  --set secrets.adminPassword=MyAdmin123 \
  --set secrets.userPassword=MyUser123
```

---

## Önemli Tasarım Kararları

1. **readOnlyRootFilesystem + emptyDir**: Next.js `.next/cache`'e runtime'da yazıyor. emptyDir mount ile çözüldü. ISR cache pod başına ephemeral — LibreDB Studio session-based olduğu için sorun değil.

2. **SQLite + multi-replica uyarısı**: SQLite single-writer. `storageProvider=sqlite` + `replicaCount > 1` durumunda README'de uyarı var. PVC default `ReadWriteOnce` zaten tek node'a kısıtlar.

3. **PostgreSQL subchart auto-wiring**: `postgresql.enabled=true` ise ConfigMap `STORAGE_PROVIDER=postgres` yapar, Deployment subchart secret'tan password okur, URL otomatik hesaplanır.

4. **existingSecret pattern**: Production'da Vault/Sealed Secrets/External Secrets Operator ile entegrasyon. Helm plaintext secret yönetmez.

5. **Dual distribution**: GitHub Pages (classic Helm repo) + OCI (ghcr.io, modern yöntem). İkisi de ArtifactHub tarafından desteklenir.

---

## Doğrulama (Verification)

### Local test
```bash
# 1. Lint
helm lint charts/libredb-studio

# 2. Template render (dry-run)
helm template test charts/libredb-studio \
  --set secrets.jwtSecret=test-secret-32-chars-minimum-here \
  --set secrets.adminPassword=test123 \
  --set secrets.userPassword=test123 | kubectl apply --dry-run=client -f -

# 3. Schema validation
helm lint charts/libredb-studio --strict

# 4. Kind cluster install test
kind create cluster
helm install test charts/libredb-studio \
  --set secrets.jwtSecret=test-secret-32-chars-minimum-here \
  --set secrets.adminPassword=test123 \
  --set secrets.userPassword=test123
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=libredb-studio --timeout=120s
kubectl port-forward svc/test-libredb-studio 3000:80
# Browser: http://localhost:3000 → login page
# curl http://localhost:3000/api/db/health → {"status":"healthy"}
helm uninstall test
kind delete cluster
```

### CI test (GitHub Actions)
- Push to main with `charts/` changes → `helm-release.yml` triggers
- `ct lint` + `ct install` on kind cluster
- chart-releaser publishes to GitHub Pages
- helm push publishes to ghcr.io OCI

---

## Uygulama Sırası

1. `charts/libredb-studio/.helmignore`
2. `charts/libredb-studio/Chart.yaml`
3. `charts/libredb-studio/values.yaml`
4. `charts/libredb-studio/values.schema.json`
5. `charts/libredb-studio/templates/_helpers.tpl`
6. `charts/libredb-studio/templates/configmap.yaml`
7. `charts/libredb-studio/templates/secret.yaml`
8. `charts/libredb-studio/templates/serviceaccount.yaml`
9. `charts/libredb-studio/templates/deployment.yaml`
10. `charts/libredb-studio/templates/service.yaml`
11. `charts/libredb-studio/templates/ingress.yaml`
12. `charts/libredb-studio/templates/hpa.yaml`
13. `charts/libredb-studio/templates/pdb.yaml`
14. `charts/libredb-studio/templates/pvc.yaml`
15. `charts/libredb-studio/templates/networkpolicy.yaml`
16. `charts/libredb-studio/templates/NOTES.txt`
17. `charts/libredb-studio/README.md`
18. `artifacthub-repo.yml` (proje kökünde)
19. `.github/workflows/helm-release.yml`
20. `helm dependency build` + `helm lint` ile doğrulama

---

## ArtifactHub Kurulum Rehberi (Kod yazıldıktan sonra yapılacak manuel adımlar)

### Ön Koşullar
- GitHub hesabı (mevcut)
- `libredb` GitHub organization (mevcut)
- Helm chart kodu tamamlanmış ve main'e push edilmiş olmalı

### Adım 1: GitHub Pages Aktifleştirme
1. GitHub repo → **Settings** → **Pages**
2. **Source**: `Deploy from a branch`
3. **Branch**: `gh-pages` / `/ (root)` → **Save**
4. `helm-release.yml` workflow'u ilk çalıştığında `gh-pages` branch'ini otomatik oluşturur
5. Sonuç: `https://libredb.github.io/libredb-studio/` adresinde Helm repo aktif olur

### Adım 2: ArtifactHub Hesap ve Organization
1. **https://artifacthub.io** → **Sign In** → **GitHub ile giriş** (OAuth, ücretsiz)
2. Sağ üst menü → **Control Panel** → **Organizations** → **Add Organization**
   - **Name**: `libredb`
   - **Display Name**: `LibreDB`
   - **Home URL**: `https://github.com/libredb`
   - **Description**: `Open-source database tools for cloud-native teams`
   - **Logo URL**: `https://raw.githubusercontent.com/libredb/libredb-studio/main/public/logo.svg`
3. **Save**

### Adım 3: Helm Repository Ekleme (GitHub Pages)
1. Control Panel → **Repositories** → **Add Repository**
   - **Kind**: Helm charts
   - **Name**: `libredb-studio`
   - **Display Name**: `LibreDB Studio`
   - **URL**: `https://libredb.github.io/libredb-studio/`
   - **Organization**: `libredb` (dropdown'dan seç)
2. **Add** → ArtifactHub ~30 dakika içinde tarar ve chart'ı listeler

### Adım 4: OCI Repository Ekleme (opsiyonel, ek kanal)
1. Control Panel → **Repositories** → **Add Repository**
   - **Kind**: Helm charts
   - **Name**: `libredb-studio-oci`
   - **URL**: `oci://ghcr.io/libredb/charts/libredb-studio`
   - **Organization**: `libredb`
2. **Add**

### Adım 5: Verified Publisher Badge
1. `artifacthub-repo.yml` dosyası GitHub Pages'ta `index.yaml` ile aynı seviyede olmalı
2. chart-releaser-action bunu otomatik yapar
3. ArtifactHub bir sonraki taramada `repositoryID`'yi doğrular → **Verified Publisher** badge'i otomatik aktif olur

### Adım 6: Official Status (opsiyonel, ilerisi için)
1. Verified Publisher badge aktif olduktan sonra
2. Control Panel → Organization → **Request Official Status**
3. ArtifactHub ekibi manuel onaylar (yazılımın sahibi olduğunuzu doğrular)

### Sonuç
Chart şu adreslerde erişilebilir olacak:
- **ArtifactHub**: `https://artifacthub.io/packages/helm/libredb-studio/libredb-studio`
- **Helm Repo**: `helm repo add libredb https://libredb.github.io/libredb-studio`
- **OCI**: `helm install libredb oci://ghcr.io/libredb/charts/libredb-studio`

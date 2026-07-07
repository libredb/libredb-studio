# LibreDB Studio on Rancher

LibreDB Studio ships a Helm chart that installs with **default values** on
Rancher-managed Kubernetes clusters: no values are required for a working
instance, and first-run admin credentials are generated automatically. This
document describes the supported Rancher, Kubernetes, and distribution
versions, how to install through Rancher, and the combinations we validate.

## Supported versions

| Component | Supported |
|-----------|-----------|
| Rancher | 2.9 or later |
| Kubernetes | 1.26 or later (chart `kubeVersion: >=1.26.0-0`) |
| Distributions | K3s, RKE2, and other CNCF-conformant Kubernetes distributions |
| Architectures | linux/amd64, linux/arm64 |

The chart uses only core Kubernetes APIs (`apps/v1`, `networking.k8s.io/v1`,
`autoscaling/v2`, `policy/v1`) and carries no distribution-specific
dependencies; the version floor is set by the chart's `kubeVersion`
constraint, not by distribution features.

## Installing via Rancher Apps

1. In the Rancher UI, choose your cluster and open **Apps → Charts**.
2. Select the **Partners** repository and search for **LibreDB Studio**.
3. Click **Install**. The default values deploy a working instance — no
   values are required.
4. Retrieve the generated admin credentials from the pod log (also shown in
   the post-install notes):

   ```bash
   kubectl --namespace <namespace> logs deployment/<release>-libredb-studio | grep -A 4 "generated admin credentials"
   ```

5. Expose the UI with a port-forward (or enable `ingress.*` values):

   ```bash
   kubectl --namespace <namespace> port-forward svc/<release>-libredb-studio 3000:80
   # open http://localhost:3000
   ```

The default install is admin-only; set `secrets.userPassword` to enable the
second, non-admin account. Generated credentials survive container restarts
but are regenerated when the pod is recreated — set `persistence.enabled=true`
or provide your own `secrets.*` values for stable credentials. For production
installs prefer explicit secrets, or strict mode
(`config.authBootstrap=off`), which requires `secrets.jwtSecret` and
`secrets.adminPassword` and fails fast when either is missing. See the [chart README](../charts/libredb-studio/README.md) for the
full values reference.

## Installing with Helm

```bash
helm repo add libredb https://libredb.org/libredb-studio/
helm repo update
helm install libredb libredb/libredb-studio
```

## Validating an install

The checks we run on every validated combination, usable on any cluster:

```bash
# 1. Install with default values; wait for the pod to become Ready
helm install libredb libredb/libredb-studio --wait --timeout 6m

# 2. Read the generated credentials from the first-run banner
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"

# 3. Health and login checks
kubectl port-forward svc/libredb-libredb-studio 3000:80 &
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/db/health   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' \
  -d '{"email":"<email from banner>","password":"<password from banner>"}' \
  http://localhost:3000/api/auth/login                                          # expect 200

# 4. Pod recreation regenerates credentials (documented emptyDir behavior)
kubectl delete pod -l app.kubernetes.io/instance=libredb
kubectl logs deployment/libredb-libredb-studio | grep -A 4 "generated admin credentials"  # new password
```

## Validated combinations

Validated with the chart source in this repository (appVersion 0.9.49). Every
row passed the full check list above, plus: strict-mode regression
(`config.authBootstrap=off` with no secrets fails the install with a clear
`required` error), credentials surviving a container restart, and invalidated
old credentials after pod recreation.

| Distribution | Kubernetes | Validated on | Notes |
|--------------|------------|--------------|-------|
| K3s v1.31.14+k3s1 | v1.31.14 | 2026-07-07 | k3d v5.9.0, containerd 2.1.5 |
| K3s v1.35.5+k3s1 | v1.35.5 | 2026-07-07 | k3d v5.9.0, containerd 2.2.3 |

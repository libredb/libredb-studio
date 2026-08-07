# LibreDB Studio on Rancher

LibreDB Studio ships a Helm chart that installs with **default values** on
Rancher-managed Kubernetes clusters: no values are required for a working
instance, and first-run admin credentials are generated automatically. This
document describes the supported Rancher, Kubernetes, and distribution
versions, how to install through Rancher, and the combinations we validate.

LibreDB Studio is listed in the SUSE Partner Certification & Solutions
Catalog: [LibreDB Studio](https://www.suse.com/pcsc/viewVersionPage?versionID=26969),
where the listing records the platform as SUSE Rancher and the certification
as SUSE Ready.

## Supported versions

These are the SUSE Rancher and Rancher Kubernetes distribution versions
LibreDB Studio is supported on, and the versions Sekoya provides
[commercial support](#commercial-support) for.

| Component | Supported | Validated |
|-----------|-----------|-----------|
| SUSE Rancher Prime and Rancher (community) | 2.9 or later | 2.14.3 (community build) |
| SUSE K3s | 1.26 or later | v1.31.14+k3s1, v1.35.5+k3s1 |
| SUSE RKE2 | 1.26 or later | — |
| Kubernetes | 1.26 or later (chart `kubeVersion: >=1.26.0-0`) | v1.31.14, v1.35.5 |
| Distributions | any CNCF-conformant Kubernetes distribution | — |
| Architectures | linux/amd64, linux/arm64 | linux/amd64 |

The chart uses only core Kubernetes APIs (`apps/v1`, `networking.k8s.io/v1`,
`autoscaling/v2`, `policy/v1`) and carries no distribution-specific
dependencies; the version floor is set by the chart's `kubeVersion`
constraint, not by distribution features. Support for a Rancher or
distribution version is not withdrawn while that version is itself supported
upstream.

## Commercial support

LibreDB Studio is developed and maintained by **Sekoya Grup Bilişim ve
Teknoloji Ltd. Şti.** (Istanbul, Türkiye), trading publicly as **LibreDB**.
Sekoya is the primary developer and maintainer of the software.

**Sekoya provides commercial support for LibreDB Studio on every Rancher,
K3s, RKE2 and Kubernetes version declared in the table above**, covering Helm
chart installation and upgrades, configuration, defect triage and fixes, and
security patches.

| Need | Channel |
|------|---------|
| Commercial support enquiries | <info@sekoya.tech> |
| Security vulnerabilities | [`SECURITY.md`](../SECURITY.md) — do not open a public issue |
| Community questions and bug reports | <https://github.com/libredb/libredb-studio/issues> |

LibreDB Studio is released under the [MIT license](../LICENSE) and follows a
regular tagged release cadence; critical vulnerabilities are patched promptly
and serious defects are disclosed in the release notes.

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

   The banner is printed once, by the container that ran the first start. If it
   is not in the current log, add `--previous`, or read the file the app stored
   the credentials in:

   ```bash
   kubectl --namespace <namespace> exec deploy/<release>-libredb-studio -- cat /app/data/auth-bootstrap.json
   ```

5. Expose the UI with a port-forward (or enable `ingress.*` values):

   ```bash
   kubectl --namespace <namespace> port-forward svc/<release>-libredb-studio 3000:80
   # open http://localhost:3000
   ```

For production installs prefer explicit secrets, or strict mode
(`config.authBootstrap=off`). What the bootstrap generates, how long it lasts and
what strict mode requires per auth provider is documented once, in the
[chart README](../charts/libredb-studio/README.md#auth-bootstrap-zero-config-vs-strict);
that section is canonical, and the same README carries the
[full values reference](../charts/libredb-studio/README.md#configuration-reference).

> **Persistence needs a StorageClass.** `persistence.enabled=true` creates a PVC,
> so the cluster must offer a StorageClass — standard on K3s and RKE2 (the
> `local-path` provisioner), but absent in Rancher's built-in `local` cluster
> when Rancher runs as a single Docker container. If you fall back to a
> statically provisioned `hostPath` PersistentVolume there, note that the
> kubelet does not apply the pod's `fsGroup` to hostPath volumes: either make the
> host directory writable for uid/gid 1001 yourself, or set
> `persistence.fixPermissions=true`, which chowns the volume in a short root init
> container before the app starts.

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

Every row passed the full check list above, plus: strict-mode regression
(`config.authBootstrap=off` with no secrets fails the install with a clear
`required` error), credentials surviving a container restart, and — for the
default non-persistent (emptyDir) install — old credentials being invalidated
after pod recreation. With `persistence.enabled=true` credentials survive pod
recreation instead, as covered by the persistence scenario in the Rancher row.

| Distribution | Kubernetes | Validated on | Chart | Notes |
|--------------|------------|--------------|-------|-------|
| Rancher v2.14.3 (single-node Docker install) | v1.35.5 | 2026-07-07 | 0.1.9 | bundled K3s v1.35.5+k3s1; chart served to the Rancher Apps catalog via a `ClusterRepo`; validated with a nine-scenario matrix (zero-config default, explicit secrets, strict-mode refusal, strict + optional user account, `existingSecret`, multi-replica guard refusal and shared-secret multi-replica, persistence across pod recreation, chart upgrade 0.1.8 to 0.1.9), including Rancher UI evidence |
| K3s v1.31.14+k3s1 | v1.31.14 | 2026-07-07 | 0.1.8 (appVersion 0.9.49) | k3d v5.9.0, containerd 2.1.5 |
| K3s v1.35.5+k3s1 | v1.35.5 | 2026-07-07 | 0.1.8 (appVersion 0.9.49) | k3d v5.9.0, containerd 2.2.3 |

Rows are the combinations we exercise end-to-end. Versions listed under
[Supported versions](#supported-versions) that do not yet appear here are
supported on the same terms — the chart is distribution-agnostic — and rows
are added as each release is validated.

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
| SUSE Rancher Prime and Rancher (community) | 2.12 or later | 2.15.2, 2.14.3 (community builds) |
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

The Rancher range follows [SUSE's lifecycle](https://www.suse.com/lifecycle/): 2.9 to 2.11 are end of life, so 2.12 is the oldest line declared.
Rancher publishes community builds of 2.12, 2.13 and 2.14 only up to v2.12.3, v2.13.3 and v2.14.3; the later patches of those lines are Rancher Prime builds, which we cannot run.
On those lines we test the last community build, and support for their later patches rests on it.

## Commercial support

LibreDB Studio is developed and maintained by
**SEKOYA GRUP BİLİŞİM VE TEKNOLOJİ LİMİTED ŞİRKETİ** (Istanbul, Türkiye),
trading publicly as **LibreDB**.
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

   Set `LIBREDB_NO_BANNER=1` (or `true`) to suppress the startup banner entirely.

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
| Rancher v2.15.2 (single-node Docker install, imported downstream cluster) | v1.35.5 | 2026-10-28 | 0.1.106 (appVersion 1.1.0) | downstream K3s v1.35.5+k3s1 in k3d v5.9.0, containerd 2.2.3, imported into Rancher; chart installed from the live Helm repository with default values; the check list above, strict-mode refusal, credentials surviving a container restart and regenerated after pod recreation |
| Rancher v2.14.3 (single-node Docker install) | v1.35.5 | 2026-07-07 | 0.1.9 | bundled K3s v1.35.5+k3s1; chart served to the Rancher Apps catalog via a `ClusterRepo`; validated with a nine-scenario matrix (zero-config default, explicit secrets, strict-mode refusal, strict + optional user account, `existingSecret`, multi-replica guard refusal and shared-secret multi-replica, persistence across pod recreation, chart upgrade 0.1.8 to 0.1.9), including Rancher UI evidence |
| K3s v1.31.14+k3s1 | v1.31.14 | 2026-07-07 | 0.1.8 (appVersion 0.9.49) | k3d v5.9.0, containerd 2.1.5 |
| K3s v1.35.5+k3s1 | v1.35.5 | 2026-07-07 | 0.1.8 (appVersion 0.9.49) | k3d v5.9.0, containerd 2.2.3 |

Rows are the combinations we exercise end-to-end. Versions listed under
[Supported versions](#supported-versions) that do not yet appear here are
supported on the same terms — the chart is distribution-agnostic — and rows
are added as each release is validated.

## Embedding in Rancher

Inside Rancher Manager, Studio can serve one downstream cluster as its database tool.
People sign in with their Rancher identity, see the CloudNativePG databases of the namespaces a cluster owner chose, and open only those their own Rancher roles let them read; no database password is typed or shown.
This is Rancher mode: a set of chart values that a default install leaves off.
It needs the first Studio release after 1.1.0, because the 1.1.0 image has neither the Kubernetes access review nor Kubernetes discovery and ignores their settings.

### How the pieces fit

- **Identity.** Rancher's OIDC provider signs people in, with an `OIDCClient` for Studio; the username is the Rancher user id, and Rancher's access token is dropped ([OIDC.md, Rancher](OIDC.md#rancher)).
- **Discovery.** An exporter with a ServiceAccount of its own reads the credential Secret of each CloudNativePG `Cluster` in the chosen namespaces and hands the result to Studio as a mounted Secret, so Studio's own pod never holds a token that can read a database Secret ([SEED_CONNECTIONS.md, Platform discovery (Kubernetes)](SEED_CONNECTIONS.md#platform-discovery-kubernetes)).
- **Access.** For every discovered database, Studio asks the cluster through a SubjectAccessReview whether the signed-in Rancher user may `get` its credential Secret, on every list and every open; a denied database answers exactly like an unknown one ([SEED_CONNECTIONS.md, Kubernetes access review](SEED_CONNECTIONS.md#kubernetes-access-review)).
- **Admin.** A Studio admin is whoever may `update` Studio's own Deployment, which in a default Rancher install is the administrator and the cluster's owners; no group claim and no password makes an admin ([SEED_CONNECTIONS.md, Admin](SEED_CONNECTIONS.md#admin)).
- **Sign-in.** Only a member of the cluster signs in, by default whoever may list its `NavLink`s, so a Rancher user with no role in the cluster is refused ([SEED_CONNECTIONS.md, Sign-in](SEED_CONNECTIONS.md#sign-in)).
- **Navigation.** A `NavLink` puts LibreDB Studio in the cluster's menu, and Studio opens in a new browser tab on its own HTTPS host; it is never framed into Rancher.
- **Containment.** Custom connections are off, so a user reaches only the databases the review allows, and MCP and the agent stay off while the review is on ([SEED_CONNECTIONS.md, What the review switches off](SEED_CONNECTIONS.md#what-the-review-switches-off)).

### Setting it up

1. As a Rancher administrator, turn on the `oidc-provider` feature flag, which restarts Rancher, and create the `OIDCClient` with Studio's callback URL ([OIDC.md, Rancher](OIDC.md#rancher) has the manifest and the scope each Rancher line accepts).
2. As the cluster's owner, create a namespace for Studio outside every Rancher project, so project members cannot read its Secrets, and write the client id and secret into a Secret there as `oidc-client-id` and `oidc-client-secret`.
3. When Rancher's certificate comes from a private CA, give Studio that CA ([chart README, Trusting a private CA](../charts/libredb-studio/README.md#trusting-a-private-ca)).
4. Install the chart into that namespace with the Rancher-mode values, through Helm or Rancher's Apps page, whose form covers them and takes the ingress host in its YAML view ([chart README, Rancher mode values](../charts/libredb-studio/README.md#rancher-mode-values); the reasons behind each value are in [HELM_CHART.md, Rancher mode](HELM_CHART.md#12-rancher-mode)).
   The discovered namespaces must exist first, and the access review's ClusterRole and the `NavLink` need a cluster owner.
5. Open LibreDB Studio from the cluster's menu.

### What we measured

On community Rancher v2.15.2 with an imported K3s v1.35.5 cluster, CloudNativePG 1.30.1 and local Rancher users, on 2026-10-28:

- With a live Rancher session, Studio signs in without a form, and a link that names a database keeps it through Rancher's sign-in page.
- The administrator and the cluster owner sign in as Studio admins; a project member signs in as a user and sees only the database of the project they may read; a Rancher user with no role in the cluster is refused.
- Compared with Rancher's own answers for local users, the review never allowed more; it denied only Secrets that Rancher grants through `system:authenticated` or `system:cattle:authenticated` alone (see Limits).
- A Rancher role removed or granted reached the cluster within about a second in that lab; Studio follows within the review cache lifetime (`accessReview.cacheSeconds`, 15 in the chart README's Rancher-mode example, 30 when unset), and an open tab's list within that plus the list refresh (`seedConnections.cacheTTL`).
  A loaded Rancher or many clusters can be slower, so the bound is Rancher's own propagation plus those two times.
- A changed export Secret reached Studio's pod in 41 to 85 seconds, the kubelet's sync delay, so a new database appears within the exporter's interval plus that delay.
- Signing out of Rancher does not end a Studio session; it lasts until the session lifetime, at most 900 seconds with the review on, after which Studio sends the browser back to Rancher.

### Not tested yet

- Access bound to the group principals of an external identity provider connected to Rancher; only local users were compared.
- Rancher's project network isolation: whether Studio, in a namespace outside every project, still reaches the database Services of project namespaces.
- Rancher mode end to end on 2.14.3; there only the OIDC exchange was measured, and it answered as 2.15.2 does.
- Rancher Prime builds.

### Limits

- One Studio serves one cluster, with one replica, because the review's records and caches live in one process.
- A Secret that Rancher grants only through `system:authenticated` or `system:cattle:authenticated` is denied in Studio, the safe direction.
- Rancher mode is not offered through the OLM operator in this release ([DISTRIBUTION.md, OpenShift operator](DISTRIBUTION.md#openshift-operator-operatorhub)).

### The LibreDB Rancher extension

A Rancher UI extension that adds a Databases page, an "Open in LibreDB Studio" action and a setup wizard is in development in [libredb/libredb-studio-rancher-extension](https://github.com/libredb/libredb-studio-rancher-extension).
It is not released or listed yet, so set Rancher mode up with the steps above.

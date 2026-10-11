# Kubernetes test clusters

Throwaway k3s clusters, run by k3d, for the Kubernetes provider's live acceptance and for the fixtures under `tests/fixtures/kubernetes/`.
A Kubernetes cluster is not a compose service, so `database-compose.yml` has none and points here instead.
Nothing here is needed to run `bun run test`: the tests replay the captured fixtures.

## The clusters

| name | image | API server |
| --- | --- | --- |
| `k8s-probe` | `mirror.gcr.io/rancher/k3s:v1.35.5-k3s1` | `https://127.0.0.1:26443` |
| `k8s-floor` | `mirror.gcr.io/rancher/k3s:v1.30.14-k3s2` | `https://127.0.0.1:26444` |
| `k8s-best-effort` | `mirror.gcr.io/rancher/k3s:v1.29.15-k3s1` | `https://127.0.0.1:26445` |

`k8s-probe` is the current release, `k8s-floor` the oldest version Studio documents, and `k8s-best-effort` a version Studio reads on a best-effort basis, recorded and not gated.

## Make one

`K8S_ENV_DIR` is an absolute directory outside the repository, because it will hold tokens and a client key.

```bash
export K8S_ENV_DIR=/absolute/path/outside/the/repository
docker/kubernetes/create-cluster.sh k8s-probe mirror.gcr.io/rancher/k3s:v1.35.5-k3s1 26443
docker/kubernetes/create-cluster.sh k8s-floor mirror.gcr.io/rancher/k3s:v1.30.14-k3s2 26444
docker/kubernetes/create-cluster.sh k8s-best-effort mirror.gcr.io/rancher/k3s:v1.29.15-k3s1 26445
docker/kubernetes/seed.sh k8s-probe
docker/kubernetes/seed.sh k8s-floor
docker/kubernetes/seed.sh k8s-best-effort
```

`create-cluster.sh` never updates or switches the default kubeconfig, binds the API server to 127.0.0.1 alone, writes the cluster's admin kubeconfig to `$K8S_ENV_DIR/<name>/admin.yaml`, and refuses a cluster that already exists.
`seed.sh` applies `sample.yaml`, `widgets.yaml` and `studio-reader.yaml` with that admin kubeconfig, waits for the workloads, and writes one kubeconfig per persona beside it.
Every kubectl call in both scripts names the cluster's own kubeconfig and context, so a kubeconfig of your own is never read.
`seed.sh` also turns off kuberc (`KUBECTL_KUBERC=false`) and keeps kubectl's discovery cache under `$K8S_ENV_DIR/<name>/`, so neither your `~/.kube/kuberc` preferences nor its default cache are read or written.
Docker Hub images are pulled through `mirror.gcr.io` (`registries.yaml`).

## The personas

| kubeconfig | identity | what it may do |
| --- | --- | --- |
| `admin.yaml` | k3d's admin, a client certificate | everything |
| `viewer.yaml` | ServiceAccount `probe-auth/viewer` | the built-in `view` ClusterRole everywhere: no Secrets, most cluster-scoped kinds locked |
| `shop-only.yaml` | ServiceAccount `probe-auth/shop-only` | `view` in the namespace `shop` only: it may not list namespaces |
| `reader.yaml` | ServiceAccount `probe-auth/reader` | get, list and watch on every resource, Secrets included |
| `studio-reader.yaml` | ServiceAccount `libredb-studio/studio-reader` | the `studio-reader` recipe of `docs/providers/kubernetes.md` |

The token personas default to the namespace `shop`, and their tokens last 72 hours; run `seed.sh` again for fresh ones.

## The sample data

`sample.yaml` holds the namespaces `shop`, `analytics`, `restricted` and `probe-auth`, workloads in every state the tree draws (running, pending, crash-looping, completed), a Service, an Ingress, a ConfigMap, Secrets, a custom resource definition and its two Widgets (`widgets.yaml`).
Every value and key holding `k8s-marker-` is a planted fake marker, named in `tests/helpers/kubernetes-markers.ts`: the tests assert that a Secret value reaches no surface and that no marker reaches a machine surface.

## Capture the fixtures

```bash
bun tests/live/kubernetes-evidence.ts --set v1.35.5 --env "$K8S_ENV_DIR"
bun tests/live/kubernetes-evidence.ts --set v1.30.14 --env "$K8S_ENV_DIR"
bun tests/live/kubernetes-evidence.ts --set v1.29.15 --env "$K8S_ENV_DIR"
```

`tests/fixtures/kubernetes/README.md` says what each set holds and how the scrub treats it.

## Tear down

`k3d cluster delete <name>` removes a cluster; delete `$K8S_ENV_DIR/<name>/` with it.

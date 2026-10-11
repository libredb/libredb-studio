#!/usr/bin/env bash
# Seeds a cluster made by create-cluster.sh with the sample data and writes one kubeconfig per persona
# (docker/kubernetes/README.md). Usage:
#   K8S_ENV_DIR=/abs/dir/outside/the/repo docker/kubernetes/seed.sh <name>
# Every kubectl call names the cluster's own admin kubeconfig and context, so the default kubeconfig is never read;
# it reads no kuberc preferences and keeps its discovery cache under K8S_ENV_DIR/<name>/, never under ~/.kube.
# The persona tokens last 72 hours; run it again for fresh ones, which re-applies the sample data unchanged.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: K8S_ENV_DIR=<dir> $0 <name>" >&2
  exit 2
fi
NAME="$1"
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${K8S_ENV_DIR:?set K8S_ENV_DIR to the directory create-cluster.sh wrote}"
DIR="$K8S_ENV_DIR/$NAME"
ADMIN="$DIR/admin.yaml"
[ -f "$ADMIN" ] || { echo "no admin kubeconfig at $ADMIN: run create-cluster.sh first" >&2; exit 2; }

k() { KUBECTL_KUBERC=false kubectl --kubeconfig="$ADMIN" --context="k3d-$NAME" --cache-dir="$DIR/.kube-cache" "$@"; }

k apply -f "$HERE/sample.yaml"
k wait --for=condition=Established crd/widgets.probe.libredb.dev --timeout=120s
k apply -f "$HERE/widgets.yaml"
k apply -f "$HERE/studio-reader.yaml"
k -n shop rollout status deployment/web --timeout=300s
k -n shop rollout status deployment/logger --timeout=300s
k -n shop wait --for=condition=complete job/migrate --timeout=300s

SERVER="$(k config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
CA="$(k config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"

umask 077
persona() {
  local name="$1" namespace="$2" account="$3"
  local token
  token="$(k -n "$namespace" create token "$account" --duration=72h)"
  cat > "$DIR/$name.yaml" <<KUBECONFIG
apiVersion: v1
kind: Config
current-context: $name
clusters:
  - name: k3d-$NAME
    cluster:
      server: $SERVER
      certificate-authority-data: $CA
users:
  - name: $name
    user:
      token: $token
contexts:
  - name: $name
    context:
      cluster: k3d-$NAME
      user: $name
      namespace: shop
KUBECONFIG
}

persona viewer probe-auth viewer
persona shop-only probe-auth shop-only
persona reader probe-auth reader
persona studio-reader libredb-studio studio-reader
echo "seeded $NAME; persona kubeconfigs in $DIR"

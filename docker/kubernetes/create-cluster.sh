#!/usr/bin/env bash
# Creates a throwaway k3s cluster for the Kubernetes provider's live acceptance and fixture capture
# (docker/kubernetes/README.md). Usage:
#   K8S_ENV_DIR=/abs/dir/outside/the/repo docker/kubernetes/create-cluster.sh <name> <k3s image> <API port>
# It never touches the default kubeconfig: no default-kubeconfig update, no context switch, and the admin kubeconfig
# is written under K8S_ENV_DIR/<name>/ only. The API server listens on 127.0.0.1 alone. A cluster that already
# exists is refused, never replaced: deleting one is its owner's decision.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: K8S_ENV_DIR=<dir> $0 <name> <k3s image> <API port>" >&2
  exit 2
fi
NAME="$1"
IMAGE="$2"
PORT="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
: "${K8S_ENV_DIR:?set K8S_ENV_DIR to an absolute directory outside the repository}"
case "$K8S_ENV_DIR" in
  /*) ;;
  *) echo "K8S_ENV_DIR must be an absolute path" >&2; exit 2 ;;
esac
case "$K8S_ENV_DIR/" in
  "$REPO"/*) echo "K8S_ENV_DIR must be outside the repository: it will hold tokens and keys" >&2; exit 2 ;;
esac
if k3d cluster get "$NAME" >/dev/null 2>&1; then
  echo "a cluster named $NAME exists: run seed.sh on it, or have its owner delete it first" >&2
  exit 3
fi

k3d cluster create "$NAME" \
  --image "$IMAGE" \
  --servers 1 --agents 0 --no-lb \
  --api-port "127.0.0.1:$PORT" \
  --k3s-arg "--disable=traefik@server:0" \
  --registry-config "$HERE/registries.yaml" \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --wait --timeout 300s

umask 077
mkdir -p "$K8S_ENV_DIR/$NAME"
k3d kubeconfig get "$NAME" > "$K8S_ENV_DIR/$NAME/admin.yaml"
echo "created $NAME on 127.0.0.1:$PORT; admin kubeconfig in $K8S_ENV_DIR/$NAME/admin.yaml"

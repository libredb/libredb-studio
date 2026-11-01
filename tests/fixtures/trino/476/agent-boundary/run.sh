#!/usr/bin/env bash
# Re-records every capture in this directory on a digest-pinned trinodb/trino:476 coordinator with a PostgreSQL
# catalog whose credential can write, once per access control:
#
#   tests/fixtures/trino/476/agent-boundary/run.sh
#
# The four access controls, each a fresh coordinator with catalog.management=dynamic:
#
#   allow-all        no access control configured, Trino's default
#   read-only        access-control.name=read-only
#   file-nofn        file-based rules granting every catalog and no function
#   file-fn-query    file-based rules granting every catalog, EXECUTE on the query table function and the execute
#                    procedure, the operator setting the agent profile refuses
#
# Each coordinator has three catalogs over the same PostgreSQL database, pg and pg2 (the postgresql connector, whose
# credential owns the database) and memory, plus Trino's own system catalog. PostgreSQL has dblink installed, so a
# pass-through query can write through it. Before every coordinator the table public.rp_t is reset to the one row 1,
# so each capture's last read shows which of its writes landed. The PostgreSQL password is generated here for the run,
# written only into the catalog files of a temporary directory removed at exit, and never printed; Trino runs with no
# authentication, so the captures carry no credential at all. Containers and the network carry the TRINO_PROJECT
# prefix, default libredb-trino-agent, and are removed when the run ends. 03 runs on allow-all and read-only only.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
project="${TRINO_PROJECT:-libredb-trino-agent}"
network="$project-net"
postgres="$project-pg"
trino_image='trinodb/trino:476@sha256:00125e40d063bc4816d165482f6044872b18b56026fb959d3b28ce1f96ffbbee'
postgres_image='postgres:17@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
work="$(mktemp -d)"
password="$(openssl rand -hex 16)"
coordinator=""

cleanup() {
  [ -n "$coordinator" ] && docker rm -f "$coordinator" >/dev/null 2>&1 || true
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

psql() { docker exec "$postgres" psql -qtA -U postgres -c "$1"; }

docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" -e POSTGRES_PASSWORD="$password" "$postgres_image" >/dev/null
until docker exec "$postgres" pg_isready -U postgres -q; do sleep 1; done
sleep 2
psql "CREATE TABLE public.rp_t (a int); CREATE SEQUENCE public.rp_seq; CREATE EXTENSION dblink;" >/dev/null

start() {
  local access="$1" etc="$work/$1"
  mkdir -p "$etc/catalog"
  for catalog in pg pg2; do
    printf 'connector.name=postgresql\nconnection-url=jdbc:postgresql://%s:5432/postgres\nconnection-user=postgres\nconnection-password=%s\n' \
      "$postgres" "$password" >"$etc/catalog/$catalog.properties"
  done
  printf 'connector.name=memory\n' >"$etc/catalog/memory.properties"
  local mounts=(-e CATALOG_MANAGEMENT=dynamic -v "$etc/catalog:/etc/trino/catalog")
  case "$access" in
    allow-all) ;;
    read-only) printf 'access-control.name=read-only\n' >"$etc/access-control.properties" ;;
    file-nofn)
      printf 'access-control.name=file\nsecurity.config-file=/etc/trino/rules.json\n' >"$etc/access-control.properties"
      echo '{"catalogs":[{"allow":"all"}]}' >"$etc/rules.json" ;;
    file-fn-query)
      printf 'access-control.name=file\nsecurity.config-file=/etc/trino/rules.json\n' >"$etc/access-control.properties"
      echo '{"catalogs":[{"allow":"all"}],"functions":[{"schema":"system","function":"query","privileges":["EXECUTE"]}],"procedures":[{"procedure":"execute","privileges":["EXECUTE"]}]}' >"$etc/rules.json" ;;
  esac
  [ -f "$etc/access-control.properties" ] && mounts+=(-v "$etc/access-control.properties:/etc/trino/access-control.properties:ro")
  [ -f "$etc/rules.json" ] && mounts+=(-v "$etc/rules.json:/etc/trino/rules.json:ro")
  # The image runs as uid 1000, and the dynamic catalog store writes into the catalog directory.
  chmod -R a+rwX "$etc"
  coordinator="$project-$access"
  docker run -d --name "$coordinator" --network "$network" -p 127.0.0.1::8080 "${mounts[@]}" "$trino_image" >/dev/null
  until docker logs "$coordinator" 2>&1 | grep -q "SERVER STARTED"; do sleep 2; done
  url="http://127.0.0.1:$(docker port "$coordinator" 8080 | head -1 | cut -d: -f2)"
  # The coordinator answers SELECT a little after it logs that it started.
  until node -e 'fetch(process.argv[1] + "/v1/info").then(async (r) => process.exit((await r.json()).starting ? 1 : 0), () => process.exit(1))' "$url"; do sleep 2; done
}

stop() {
  docker rm -f "$coordinator" >/dev/null
  coordinator=""
}

for access in allow-all read-only file-nofn file-fn-query; do
  psql "TRUNCATE public.rp_t; INSERT INTO public.rp_t VALUES (1); ALTER SEQUENCE public.rp_seq RESTART;" >/dev/null
  start "$access"
  for plan in 00-catalogs-and-functions 01-proof-probes 02-writes; do
    node "$dir/probe.mjs" "$url" "$dir/$plan.json" >"$dir/$plan-$access.txt"
  done
  case "$access" in
    allow-all | read-only) node "$dir/probe.mjs" "$url" "$dir/03-transactions.json" >"$dir/03-transactions-$access.txt" ;;
  esac
  stop
done

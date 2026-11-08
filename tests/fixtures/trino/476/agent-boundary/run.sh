#!/usr/bin/env bash
# Re-records every capture in this directory on a digest-pinned trinodb/trino:476 coordinator with a PostgreSQL
# catalog whose credential can write, once per access control:
#
#   tests/fixtures/trino/476/agent-boundary/run.sh          re-record every capture, then remove everything
#   tests/fixtures/trino/476/agent-boundary/run.sh up       start the six coordinators and leave them running,
#                                                           printing each one's access control and URL, for
#                                                           tests/live/trino-agent-boundary.ts
#   tests/fixtures/trino/476/agent-boundary/run.sh down     remove what `up` started
#
# The six access controls, each a fresh coordinator with catalog.management=dynamic:
#
#   file-owner-fn    file-based rules granting every catalog, and EXECUTE and GRANT_EXECUTE on the pg query table
#                    function to the user "owner" alone, so the connection's user "studio" holds no function
#   allow-all        no access control configured, Trino's default
#   read-only        access-control.name=read-only
#   read-only-file   the read-only access control and the file-owner-fn rules together (access-control.config-files)
#   file-nofn        file-based rules granting every catalog and no function
#   file-fn-query    file-based rules granting every catalog, EXECUTE on the query table function and the execute
#                    procedure, the operator setting the agent profile refuses
#
# Each coordinator has four catalogs, pg and pg2 (the postgresql connector, whose credential owns the database),
# memory, and lake (the hive connector on a file metastore in a directory every coordinator mounts, so a view one
# coordinator stores is read by the others), plus Trino's own system catalog. PostgreSQL has dblink installed, so a
# pass-through query can write through it. On file-owner-fn, which runs first, the user "owner" stores in lake a
# SECURITY DEFINER view over a pass-through dblink write (06-definer-view-setup); every coordinator then reads it as
# "studio" (06). Before every coordinator the table public.rp_t is reset to the one row 1, so each capture's last read
# shows which of its writes landed. The PostgreSQL password is generated here for the run, written only into the
# catalog files of a temporary directory removed at exit, and never printed; Trino runs with no authentication, so the
# captures carry no credential at all. Containers and the network carry the TRINO_PROJECT prefix, default
# libredb-trino-agent, and are removed when the run ends. 03 runs on allow-all and read-only only.
# `up` keeps the catalog files in TRINO_WORK, default ${TMPDIR:-/tmp}/<prefix>-work, until `down` removes it.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
project="${TRINO_PROJECT:-libredb-trino-agent}"
network="$project-net"
postgres="$project-pg"
trino_image='trinodb/trino:476@sha256:00125e40d063bc4816d165482f6044872b18b56026fb959d3b28ce1f96ffbbee'
postgres_image='postgres:17@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe'
mode="${1:-capture}"
work="${TRINO_WORK:-${TMPDIR:-/tmp}/$project-work}"
password="$(openssl rand -hex 16)"
coordinator=""
accesses=(file-owner-fn allow-all read-only read-only-file file-nofn file-fn-query)

cleanup() {
  [ -n "$coordinator" ] && docker rm -f "$coordinator" >/dev/null 2>&1 || true
  for access in "${accesses[@]}"; do docker rm -f "$project-$access" >/dev/null 2>&1 || true; done
  docker rm -f "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}
case "$mode" in
  down) cleanup; exit 0 ;;
  up) ;;
  capture) trap cleanup EXIT ;;
  *) echo "usage: $0 [up|down]" >&2; exit 2 ;;
esac
rm -rf "$work"
mkdir -p "$work/lake"
# The image runs as uid 1000, and the hive connector writes its metastore and schema directories here.
chmod a+rwX "$work/lake"

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
  printf 'connector.name=hive\nhive.metastore=file\nhive.metastore.catalog.dir=local:///metastore\nfs.native-local.enabled=true\nlocal.location=/lake\n' \
    >"$etc/catalog/lake.properties"
  local mounts=(-e CATALOG_MANAGEMENT=dynamic -v "$etc/catalog:/etc/trino/catalog" -v "$work/lake:/lake")
  local owner_rules='{"catalogs":[{"allow":"all"}],"functions":[{"user":"owner","catalog":"pg","schema":"system","function":"query","privileges":["EXECUTE","GRANT_EXECUTE"]}]}'
  case "$access" in
    allow-all) ;;
    read-only) printf 'access-control.name=read-only\n' >"$etc/access-control.properties" ;;
    file-owner-fn)
      printf 'access-control.name=file\nsecurity.config-file=/etc/trino/rules.json\n' >"$etc/access-control.properties"
      echo "$owner_rules" >"$etc/rules.json" ;;
    read-only-file)
      # The image's config.properties, as 476 ships it, with the two access controls added.
      printf 'coordinator=true\nnode-scheduler.include-coordinator=true\nhttp-server.http.port=8080\ndiscovery.uri=http://localhost:8080\ncatalog.management=${ENV:CATALOG_MANAGEMENT}\naccess-control.config-files=/etc/trino/read-only.properties,/etc/trino/file.properties\n' \
        >"$etc/config.properties"
      printf 'access-control.name=read-only\n' >"$etc/read-only.properties"
      printf 'access-control.name=file\nsecurity.config-file=/etc/trino/rules.json\n' >"$etc/file.properties"
      echo "$owner_rules" >"$etc/rules.json"
      mounts+=(-v "$etc/config.properties:/etc/trino/config.properties:ro" -v "$etc/read-only.properties:/etc/trino/read-only.properties:ro"
        -v "$etc/file.properties:/etc/trino/file.properties:ro") ;;
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

if [ "$mode" = up ]; then
  psql "INSERT INTO public.rp_t VALUES (1);" >/dev/null
  for access in "${accesses[@]}"; do
    start "$access"
    [ "$access" = file-owner-fn ] && node "$dir/probe.mjs" "$url" "$dir/06-definer-view-setup.json" >/dev/null
    echo "$access $url"
    coordinator=""
  done
  exit 0
fi

for access in "${accesses[@]}"; do
  psql "TRUNCATE public.rp_t; INSERT INTO public.rp_t VALUES (1); ALTER SEQUENCE public.rp_seq RESTART;" >/dev/null
  start "$access"
  [ "$access" = file-owner-fn ] &&
    node "$dir/probe.mjs" "$url" "$dir/06-definer-view-setup.json" >"$dir/06-definer-view-setup-$access.txt"
  for plan in 00-catalogs-and-functions 01-proof-probes 02-writes 04-unlisted-functions 05-access-control-probe \
    06-definer-view; do
    node "$dir/probe.mjs" "$url" "$dir/$plan.json" >"$dir/$plan-$access.txt"
  done
  case "$access" in
    allow-all | read-only) node "$dir/probe.mjs" "$url" "$dir/03-transactions.json" >"$dir/03-transactions-$access.txt" ;;
  esac
  stop
done

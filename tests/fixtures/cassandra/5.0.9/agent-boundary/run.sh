#!/usr/bin/env bash
# Re-records every capture in this directory in one run, in file order, against four fresh containers:
#
#   IMAGE=cassandra:5.0.9@sha256:ae4cc2e4b62a5b2a2dd1645ba827cb50c589cc7531bcffe8b8b60ac3b1adc79d
#   # PasswordAuthenticator and CassandraAuthorizer, with the materialized views, user-defined functions and
#   # dynamic data masking the image ships disabled turned on, so the code a SELECT can reach is measurable:
#   docker run -d --name <auth> -p <auth-port>:9042 -e MAX_HEAP_SIZE=2G --entrypoint bash "$IMAGE" -c \
#     "sed -i -e 's/^authenticator:.*/authenticator: PasswordAuthenticator/' \
#       -e 's/^authorizer:.*/authorizer: CassandraAuthorizer/' \
#       -e 's/^materialized_views_enabled:.*/materialized_views_enabled: true/' \
#       -e 's/^user_defined_functions_enabled:.*/user_defined_functions_enabled: true/' \
#       -e 's/^# dynamic_data_masking_enabled:.*/dynamic_data_masking_enabled: true/' \
#       /etc/cassandra/cassandra.yaml && exec docker-entrypoint.sh cassandra -f"
#   # PasswordAuthenticator with the stock AllowAllAuthorizer:
#   docker run -d --name <allow> -p <allow-port>:9042 -e MAX_HEAP_SIZE=1G --entrypoint bash "$IMAGE" -c \
#     "sed -i -e 's/^authenticator:.*/authenticator: PasswordAuthenticator/' /etc/cassandra/cassandra.yaml \
#       && exec docker-entrypoint.sh cassandra -f"
#   # The stock image, which authenticates and authorizes nothing:
#   docker run -d --name <stock> -p <stock-port>:9042 -e MAX_HEAP_SIZE=1G "$IMAGE"
#   docker run -d --name <scylla> -p <scylla-port>:9042 \
#     scylladb/scylla:2026.2.4@sha256:b824cac83843095351dab61425effcb49cf567682c650f366043a6431f9a798d \
#     --smp 1 --memory 1G --overprovisioned 1 --developer-mode 1
#   tests/fixtures/cassandra/5.0.9/agent-boundary/run.sh 127.0.0.1:<auth-port> 127.0.0.1:<allow-port> \
#     127.0.0.1:<stock-port> 127.0.0.1:<scylla-port>
#
# Run it from the repository root once `nodetool status` reports UN on each Cassandra node and the default superuser
# signs in, so probe.mjs resolves cassandra-driver from the root node_modules. Every role's password is
# not-a-real-password; the image's superuser is cassandra/cassandra. 01 to 05, 10 and 12 depend on 00, and 12 on 11; 13 and 14 make and drop their own.
set -euo pipefail
auth="$1"
allow="$2"
stock="$3"
scylla="$4"
dir="$(cd "$(dirname "$0")" && pwd)"
pw="not-a-real-password"
run() {
  local contact="$1" role="$2" password="$3" file="$4" keyspace="${5:-}"
  node "$dir/probe.mjs" "$contact" "$role" "$password" "$dir/$file.cql" $keyspace > "$dir/$file.txt"
}
run "$auth" cassandra cassandra 00-setup-as-cassandra
run "$auth" agent_ro "$pw" 01-self-listing-as-agent-ro probe
# 5.0.9 lets a role change its password once per 5000ms from its creation on (code 4097), so 02 waits that out.
sleep 6
run "$auth" agent_ro "$pw" 02-writes-and-code-as-agent-ro probe
: > "$dir/03-own-listing-as-each-role.txt"
for role in agent_ro agent_table agent_modify agent_super agent_allks agent_exec agent_unmask agent_inherit \
  agent_inherit_super agent_mixed agent_none agent_describe; do
  sed "s/@ROLE@/$role/g" "$dir/03-own-listing-as-each-role.cql" > "$dir/.03-$role.cql"
  { echo "== as $role"; node "$dir/probe.mjs" "$auth" "$role" "$pw" "$dir/.03-$role.cql"; } \
    >> "$dir/03-own-listing-as-each-role.txt"
  rm "$dir/.03-$role.cql"
done
run "$auth" agent_ro "$pw" 04-check-as-agent-ro probe
node "$dir/05-permission-cache-window.mjs" "$auth" > "$dir/05-permission-cache-window.txt"
run "$allow" cassandra cassandra 06-setup-allow-all-authorizer-as-cassandra
run "$allow" agent_ro "$pw" 07-allow-all-authorizer-as-agent-ro
run "$stock" "" "" 08-stock-server-no-credential
run "$scylla" "" "" 09-scylla-no-credential
run "$auth" agent_modify "$pw" 10-modify-second-keyspace-as-agent-modify
run "$auth" cassandra cassandra 11-setup-built-in-names-as-cassandra
run "$auth" agent_ro "$pw" 12-built-in-names-as-agent-ro probe
node "$dir/13-fence-grammar-and-check-paging.mjs" "$auth" > "$dir/13-fence-grammar-and-check-paging.txt"
node "$dir/14-line-comment-carriage-return.mjs" "$auth" > "$dir/14-line-comment-carriage-return.txt"

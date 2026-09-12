#!/bin/bash
# Object-browser fixture for the Couchbase provider (issue #789).
#
# Couchbase has no /docker-entrypoint-initdb.d: a fresh node has no cluster, no
# bucket and no index, so everything is applied by the couchbase-init sidecar in
# database-compose.yml, which runs this script after cluster-init, bucket-create
# and the bucket-level CREATE PRIMARY INDEX. The sidecar mounts this directory,
# so an edit here takes effect on the next `docker compose up couchbase-init`
# without recreating the data node. The commands for applying it to a container
# that is already running by hand are in docs/providers/couchbase.md.
#
# It is re-runnable: every statement is IF NOT EXISTS or tolerates "already
# exists", because the sidecar runs on every `up`.
#
# Every object below exists to make one claim about the ENGINE re-measurable
# rather than merely plausible. Measured on Couchbase Server 8.0.2 Community.
#
#  1. `inventory` is a user SCOPE, so the declared `schema` container level has
#     something in it besides `_default`. The engine refuses a user scope whose
#     name begins with `_` or `%` ("First character must not be _ or %",
#     measured), which is why the `_system` exclusion is written as an exact
#     name and cannot be shadowed by anything a person creates.
#  2. `ix_name` is created on BOTH `inventory.airline` AND `inventory.hotel`, and
#     both succeed. Creating it TWICE on one collection is refused ("The index
#     ix_name already exists."). So an index name is unique per COLLECTION and
#     not per scope, which is why the `index` kind declares
#     `attachedTo: "collection"` and its path carries the collection segment.
#  3. `discount` is created in BOTH the `inventory` and the `_default` scope, and
#     both succeed. Creating a second `discount` in ONE scope is refused
#     ("Function 'discount' already exists"), and it is refused on ARITY as well
#     as on name: `discount(price)` collides with `discount(price, pct)`. So a
#     SQL++ user-defined function has no overloading and its bare NAME is unique
#     within its scope, which is what lets the path's last segment be the name
#     itself rather than PostgreSQL's argument-type list.
#  4. `celsius` is a GLOBAL (namespace-level) function. It belongs to `default:`,
#     above every bucket, so it has no container in a bucket/scope tree and is
#     deliberately absent from the object surface. The provider excludes it
#     STRUCTURALLY, by the row carrying no bucket and no scope, rather than by
#     matching `identity.type`, so a future third identity type is placed by
#     where it says it lives instead of falling out of the tree unnoticed.
#  5. `_design/dev_legacy` is a legacy map-reduce VIEW, deprecated since Couchbase
#     7.0 and still not removed. It is created over the CAPI port (8092), and it
#     is invisible to every query-service system keyspace: measured, a LIKE over
#     ENCODE_JSON of system:all_keyspaces, system:all_indexes, system:functions,
#     system:buckets and system:all_scopes finds zero rows mentioning it, and it
#     is not a document in `_default`.`_default` either. That is the measurement
#     behind declaring no `view` kind, together with SQL++ having no CREATE VIEW
#     statement at all (`CREATE VIEW v AS SELECT 1` is error 3000, "syntax error
#     ... at: VIEW (reserved word)").
#  6. `airline` holds documents so INFER has a sample to answer describeObject's
#     columns from, and `hotel` and `bookings` are left EMPTY on purpose: INFER
#     answers error 7014 "No documents found, unable to infer schema" on an empty
#     collection, which is an ordinary state the object surface must render as a
#     collection with no columns rather than fail on.
#  7. `_default`.`airline` carries the SAME collection name as `inventory`.`airline`, with
#     an index of the same name over a DIFFERENT key, so a scope-blind filter on a
#     collection's indexes reports the wrong keys rather than merely the wrong count.
#
# The `_system` scope and its collections (`_mobile`, `_query`) are the server's
# own and are created by it, not here. They are what the `_system` exclusion is
# measured against: system:all_keyspaces answers THREE rows more than
# system:keyspaces for this bucket, that scope's two collections plus a duplicate
# scoped row for `_default`.`_default`. The excess is three whatever this script
# creates; the totals move every time it gains a collection, so they are counted
# in docs/providers/couchbase.md section 6a.8 and not restated here.
set -eu

HOST="${COUCHBASE_HOST:-couchbase}"
USER="${COUCHBASE_USER:-Administrator}"
PASS="${COUCHBASE_PASSWORD:-password123}"
BUCKET="${COUCHBASE_BUCKET:-travel}"

# One SQL++ statement. A statement that fails because the object already exists
# is reported and tolerated; anything else stops the script.
n1ql() {
  local out
  # `-s` and NOT `-sf`: the query service answers HTTP 500 for a failed DDL
  # statement (measured on `CREATE PRIMARY INDEX` over an existing index), and
  # `-f` would throw the body away, leaving the case below nothing to read.
  out=$(curl -s -u "$USER:$PASS" "http://$HOST:8093/query/service" \
    --data-urlencode "statement=$1" --data-urlencode "timeout=75s")
  # The query service pretty-prints its envelope, so the status is matched with
  # the whitespace the wire actually carries rather than with none.
  case "$out" in
    *'"status":'*'"success"'*) return 0 ;;
    *'already exists'*) echo "fixture: already present - $1" ; return 0 ;;
    *) echo "fixture: FAILED - $1" >&2 ; echo "$out" >&2 ; return 1 ;;
  esac
}

# 1. A user scope beside the built-in `_default`.
n1ql "CREATE SCOPE \`$BUCKET\`.\`inventory\` IF NOT EXISTS"

# Collections. `_default`.`_default` needs no statement: every bucket has it, and
# the query service reports it as the bucket-level system:keyspaces row that
# carries no \`bucket\` and no \`scope\` field at all.
n1ql "CREATE COLLECTION \`$BUCKET\`.\`inventory\`.\`airline\` IF NOT EXISTS"
n1ql "CREATE COLLECTION \`$BUCKET\`.\`inventory\`.\`hotel\` IF NOT EXISTS"
n1ql "CREATE COLLECTION \`$BUCKET\`.\`_default\`.\`bookings\` IF NOT EXISTS"
# 7. `airline` AGAIN, in the OTHER scope. A collection name is unique per SCOPE and not
#    per bucket, so `_default`.`airline` and `inventory`.`airline` coexist, and each has
#    its own `ix_name`. A provider filtering a collection's indexes on the collection name
#    alone would hand one of them the other's.
n1ql "CREATE COLLECTION \`$BUCKET\`.\`_default\`.\`airline\` IF NOT EXISTS"

# The query service needs a moment after CREATE COLLECTION before an index on it
# is accepted, so the index statements are retried rather than assumed.
for _ in $(seq 1 15); do
  if n1ql "CREATE PRIMARY INDEX IF NOT EXISTS ON \`$BUCKET\`.\`inventory\`.\`airline\`"; then break; fi
  sleep 2
done

# 2. One index NAME on two collections of one scope: the per-collection
#    uniqueness measurement the `attachedTo: "collection"` declaration rests on.
n1ql "CREATE INDEX \`ix_name\` IF NOT EXISTS ON \`$BUCKET\`.\`inventory\`.\`airline\`(\`name\`)"
n1ql "CREATE INDEX \`ix_name\` IF NOT EXISTS ON \`$BUCKET\`.\`inventory\`.\`hotel\`(\`name\`)"
n1ql "CREATE INDEX \`ix_name\` IF NOT EXISTS ON \`$BUCKET\`.\`_default\`.\`airline\`(\`code\`)"

# 3. One function NAME in two scopes. INLINE is the only language Community
#    Edition accepts: "Functions of type javascript are only supported in
#    Enterprise Edition", measured, which is why the provider never classifies on
#    definition.`#language`.
n1ql "CREATE OR REPLACE FUNCTION \`$BUCKET\`.\`inventory\`.\`discount\`(price, pct) { price - (price * pct / 100) }"
n1ql "CREATE OR REPLACE FUNCTION \`$BUCKET\`.\`_default\`.\`discount\`(x) { x }"

# 4. A GLOBAL function, which must never reach the tree.
n1ql "CREATE OR REPLACE FUNCTION \`celsius\`(f) { (f - 32) / 1.8 }"

# 6. Documents for INFER. `hotel` and `bookings` stay empty on purpose.
n1ql "UPSERT INTO \`$BUCKET\`.\`inventory\`.\`airline\` (KEY, VALUE) VALUES
      (\"airline::1\", {\"name\": \"Anatolia Air\", \"country\": \"TR\", \"fleet\": 12}),
      (\"airline::2\", {\"name\": \"Aegean Wings\", \"country\": \"GR\", \"fleet\": 7})"

# 5. The legacy map-reduce view, over the CAPI port. Not idempotent by flag, but
#    a PUT of the same body is a no-op update, so re-running is harmless.
curl -sf -u "$USER:$PASS" -X PUT "http://$HOST:8092/$BUCKET/_design/dev_legacy" \
  -H 'Content-Type: application/json' \
  -d '{"views":{"by_city":{"map":"function (doc, meta) { emit(doc.city, null); }"}}}' >/dev/null \
  || echo "fixture: the CAPI port refused the design document; the view claim is unmeasured on this node" >&2

echo "couchbase fixture applied to bucket $BUCKET"

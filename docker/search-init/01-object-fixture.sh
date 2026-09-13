#!/usr/bin/env bash
# Object-browser fixture for the Elasticsearch / OpenSearch provider (issue #789).
#
# Neither image has an init-script directory, and neither product has DDL: an index,
# an alias, an ingest pipeline, an index template and a data stream are all created
# over REST, so the fixture is this script rather than a file the entrypoint runs.
# database-compose.yml mounts this directory read-only into BOTH services at
# /opt/search-init, so it can be applied from the repo or from inside the container:
#
#   SEARCH_URL=http://localhost:9200 bash docker/search-init/01-object-fixture.sh
#   docker exec libredb-elasticsearch bash /opt/search-init/01-object-fixture.sh
#   docker exec libredb-opensearch    bash /opt/search-init/01-object-fixture.sh
#
# Both images ship curl (their own healthchecks use it) and neither ships jq, so
# this script uses curl and nothing else. It is re-runnable: every call is a PUT or
# an idempotent alias action, and the data stream creation tolerates an existing one.
#
# It applies UNCHANGED to both products, and that is a measured claim rather than a
# convenience: every endpoint below answered identically on Elasticsearch 9.1.4 and
# OpenSearch 3.8.0 on 2026-09-11. The ONE difference the two products showed under
# this fixture is not in what it creates, it is in what the cluster already holds:
# see docs/providers/elasticsearch.md and docs/providers/opensearch.md.
#
# Every object exists to make one claim about the ENGINE re-measurable:
#
#  1. `probe_orders` is the index kind, and its mapping carries the four shapes the
#     schema reader turns on: a scalar, a `text` field with a `keyword` multi-field,
#     an `object` container and its sub-field. One document, so `_cat/indices`
#     reports a non-null count.
#  2. `probe_orders_alias` is the alias kind, and it is a RELATION rather than a
#     config object because `SELECT customer FROM probe_orders_alias` answers rows
#     on both products (measured). An alias cannot take the name of an existing
#     index: "an index or data stream exists with the same name as the alias",
#     refused on both, which is why index, alias and data stream paths cannot
#     collide across kinds.
#  3. `probe_pipeline` is the ingest pipeline kind. It is the object that proves the
#     one measured product difference: with NO user pipeline, `GET /_ingest/pipeline`
#     answers HTTP 404 on a stock OpenSearch node (which ships none) and HTTP 200
#     with 21 managed pipelines on a stock Elasticsearch node. So a stock OpenSearch
#     cluster answers 404 for "there are none", which the transport reads as empty.
#  4. `probe_template` is the COMPOSABLE index template kind, read from
#     `_index_template`. The legacy `_template` API is deliberately not a kind: a
#     legacy template and a composable template may carry the SAME name (measured,
#     `PUT _template/probe_template` succeeds while `probe_template` already exists
#     as a composable template, on both products), so merging the two endpoints into
#     one kind would produce two objects at one path.
#  5. `probe_stream` is the data stream kind, and it is a kind rather than a property
#     of an index because its backing indices are `.ds-`-prefixed, which the
#     provider's own system-index rule hides: without this kind the tree can reach a
#     data stream's data through nothing at all. `SELECT * FROM probe_stream`
#     answers a column list on both products (measured).
#  6. `probe_json_edges` is a second ingest pipeline, and it exists for the SOURCE read
#     (#789) rather than for the listing. Its three `set` processors carry the values a
#     JSON re-serialisation changes: a long past 2^53, a map with integer-like keys as
#     one processor's `value`, and a value the server prints in exponent form. Measured
#     on Elasticsearch 9.1.4 on 2026-09-13, the cluster answers `9223372036854775807` and
#     JSON.parse plus JSON.stringify renders `9223372036854776000`, the map arrives keyed
#     `zz, 10, 2, aa` and comes back keyed `2, 10, zz, aa`, and `1.0E30` becomes `1e+30`.
#     Both provider docs record those three as what this product's renderer does to the
#     cluster's own bytes, and this object is what makes the claim re-runnable.
#     The integer-like keys live inside a `set` processor's VALUE rather than in the
#     pipeline's `_meta`, where the shorter spelling would have put them, and that is a
#     measured product difference rather than a style choice: OpenSearch 3.8.0 refuses
#     `_meta` on an ingest pipeline outright ("pipeline [probe_json_edges] doesn't support
#     one or more provided configuration parameters [_meta]", HTTP 400) while
#     Elasticsearch 9.1.4 accepts it, and this script's claim to apply unchanged to both
#     is worth more than the shorter spelling. So this fixture writes no `_meta` at all.
#  7. `probe pipe/slash` is an ingest pipeline whose NAME holds a space and a slash, which
#     both products accept. It is the object that makes the source read's percent-encoding
#     non-vacuous: measured, `GET /_ingest/pipeline/probe%20pipe%2Fslash` answers the
#     pipeline and the same request with the slash unencoded is HTTP 400, "no handler
#     found for uri". A template name may NOT hold a space (HTTP 400,
#     `invalid_index_template_exception`), so the pipeline endpoint is the only one where
#     an adversarial name can live at all.
set -euo pipefail

SEARCH_URL="${SEARCH_URL:-http://localhost:9200}"

put() {
  curl -s -S -X PUT -H 'Content-Type: application/json' "${SEARCH_URL}$1" ${2:+--data "$2"}
  echo
}

post() {
  curl -s -S -X POST -H 'Content-Type: application/json' "${SEARCH_URL}$1" --data "$2"
  echo
}

echo "Waiting for the cluster to answer..."
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "${SEARCH_URL}/_cluster/health?wait_for_status=yellow&timeout=3s"; then break; fi
  sleep 2
done

echo "1. index probe_orders"
put /probe_orders '{
  "mappings": {
    "properties": {
      "id": { "type": "long" },
      "customer": { "type": "keyword" },
      "total": { "type": "double" },
      "note": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "address": { "properties": { "city": { "type": "keyword" } } }
    }
  }
}' || true
post '/probe_orders/_doc?refresh=true' '{"id":1,"customer":"acme","total":9.5,"note":"hi","address":{"city":"ankara"}}'

echo "2. alias probe_orders_alias"
post /_aliases '{"actions":[{"add":{"index":"probe_orders","alias":"probe_orders_alias"}}]}'

echo "3. ingest pipeline probe_pipeline"
put /_ingest/pipeline/probe_pipeline '{
  "description": "libredb object-surface fixture (#789)",
  "processors": [ { "set": { "field": "seen", "value": "yes" } } ]
}'

echo "4. composable index template probe_template"
put /_index_template/probe_template '{
  "index_patterns": ["probe-template-*"],
  "template": { "mappings": { "properties": { "id": { "type": "long" } } } }
}'

echo "5. data stream probe_stream, and the template that admits it"
put /_index_template/probe_stream_template '{
  "index_patterns": ["probe_stream*"],
  "data_stream": {},
  "template": { "mappings": { "properties": { "@timestamp": { "type": "date" } } } }
}'
put /_data_stream/probe_stream || true

echo "6. ingest pipeline probe_json_edges, the renderer-fidelity object"
put /_ingest/pipeline/probe_json_edges '{
  "description": "libredb source-render fidelity fixture (#789)",
  "processors": [
    { "set": { "field": "big", "value": 9223372036854775807 } },
    { "set": { "field": "sci", "value": 1e30 } },
    { "set": { "field": "keys", "value": { "zz": 1, "10": "ten", "2": "two", "aa": 2 } } }
  ]
}'

echo "7. ingest pipeline 'probe pipe/slash', the percent-encoding object"
put '/_ingest/pipeline/probe%20pipe%2Fslash' '{
  "description": "libredb source-read escaping fixture (#789)",
  "processors": [ { "set": { "field": "escaped", "value": "yes" } } ]
}'

echo "Done."

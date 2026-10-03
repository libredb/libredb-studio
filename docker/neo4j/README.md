# Neo4j fixture

The live Neo4j server of `database-compose.yml`, and the graph that seeds it.
The Neo4j provider's captures, its integration test and every hand pass run against this server.

## The server

| Service | Profile | From the host | Transport and authentication |
|---|---|---|---|
| `neo4j` | none | Bolt `127.0.0.1:7687`, HTTP `127.0.0.1:7474` | Plaintext, user `neo4j`, password `password123` |

The server runs `neo4j:5.26.31-community`, pinned by the digest `sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255` (pulled on 2026-10-03).
Bolt is the provider's transport; HTTP is published for the health probe and for the Neo4j Browser a developer may open by hand.
The password follows the clickhouse and couchbase services, since Neo4j refuses one shorter than 8 characters.
Both ports are bound to the loopback address only, and the container is bounded at 1 GB of memory with no swap, a 512 MB heap and a 128 MB page cache.
Bolt telemetry is off.
There is no data volume: removing the container resets the server.

## Bringing it up

```sh
docker compose -f database-compose.yml up -d --wait neo4j
docker exec -i libredb-neo4j cypher-shell -u neo4j -p password123 < docker/neo4j/seed.cypher
docker exec libredb-neo4j cypher-shell -u neo4j -p password123 'MATCH (n) RETURN count(n)'
```

The last command answers `30`.
The seed may run again: its first statement deletes every node, and the index and the constraint are created with `IF NOT EXISTS`, so a second load gives the same graph.

## The graph

The seed is a graph written for this repository: 30 nodes and 40 relationships.
The official Movies example graph is not used, because it carries no licence file.

| Label | Nodes | What it is for |
|---|---|---|
| `Team` | 4 | Teams with a `DATE` founding day |
| `Person` | 10 | People with `STRING`, `INTEGER`, `BOOLEAN` and `LIST` properties, some names with non-ASCII letters |
| `Service` | 8 | Services; the one with `id: 'types'` holds one property of every value type below |
| `Weird Label` | 2 | A label with a space in its name |
| ``Back`tick`` | 2 | A label with a backtick in its name |
| `Shared` | 2 | A label that has the same name as a relationship type |
| `Marker` | 2 | A label whose nodes carry no property at all |

| Relationship type | Count | Between |
|---|---|---|
| `MEMBER_OF` | 16 | `Person` to `Team` (some people in two teams, with `since` and `role`), and one ``Back`tick`` to `Weird Label` |
| `OWNS` | 9 | `Team` to `Service`, and one `Weird Label` to ``Back`tick`` |
| `DEPENDS_ON` | 14 | `Service` to `Service` with a `critical` flag and a cycle among `checkout`, `ledger` and `auth`, plus the two quoted labels to `gateway` |
| `Shared` | 1 | `Shared` to `Shared` |

The `types` service holds:

| Property | Type | Value |
|---|---|---|
| `aString` | `STRING` | `'plain text'` |
| `anInteger` | `INTEGER` | `42` |
| `beyondDoubles` | `INTEGER` | `9007199254740993`, which a JavaScript number cannot hold |
| `minInteger` | `INTEGER` | `-9223372036854775808`, the smallest 64-bit integer |
| `aFloat` | `FLOAT` | `0.1` |
| `notANumber` | `FLOAT` | `NaN` |
| `aBoolean` | `BOOLEAN` | `false` |
| `aList` | `LIST<INTEGER>` | `[1, 2, 3]` |
| `aDate` | `DATE` | `2026-10-03` |
| `aLocalTime` | `LOCAL TIME` | `13:45:30.123456789` |
| `aTime` | `ZONED TIME` | `13:45:30.123456789+03:00` |
| `aLocalDateTime` | `LOCAL DATETIME` | `2026-10-03T13:45:30.123456789` |
| `aDateTime` | `ZONED DATETIME` | `2026-10-03T13:45:30.123456789+03:00[Europe/Istanbul]` |
| `aDuration` | `DURATION` | `P1Y2M3DT4H5M6.789S` |
| `aCartesianPoint` | `POINT` | cartesian, SRID 7203, `x: 1.5, y: -2.25` |
| `aWgs84Point` | `POINT` | WGS-84, SRID 4326, longitude `28.9784`, latitude `41.0082` |

A byte array is not seeded: no core Cypher function produces one, and the APOC plugin is not installed on this image.

The schema holds a `RANGE` index `person_name` on `Person(name)` and a uniqueness constraint `service_id` on `Service(id)`, besides the two `LOOKUP` indexes every database has.

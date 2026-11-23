# Provider import census

This record lists every import that crosses the boundary of the provider directory `src/lib/db/providers/`, in both directions, and gives each shared module a destination in the provider plugin program.
It is the census the SDK of PR 9 is sized from, and the guard that keeps core from gaining new imports into a provider directory.
It was measured on 2026-11-23 at commit f3963abd6.

The scanner is `tests/unit/lib/db/provider-imports/scan.ts`, and its docblock says what it reads.
In short: every source file git lists under `src/`, `bin/`, `scripts/` and `vscode-extension/src/`, with its specifiers read by the TypeScript compiler's `preProcessFile`, so a type-only import counts like any other and a path in a comment or a string does not.
Core is every such file outside the provider directory; tests are not core, and they move with their provider.

Two of the tables below are held to the source by `tests/unit/lib/db/provider-imports.test.ts`: the outward table ("Core modules provider code imports") and the inward table ("Imports from core into provider directories").
Every other number here is a dated snapshot of the measurement commit.

## The census

| Measure | Value |
|---|---|
| Core files importing a provider module | 86 (85 under `src/`, 1 under `scripts/`) |
| Import statements from core into provider directories | 464, of which 44 are dynamic imports in `src/lib/db/factory.ts` |
| Distinct (core file, provider module) pairs | 462 |
| Distinct provider modules core reaches | 421 |
| Import statements from provider code to core modules | 1875 |
| Distinct core modules provider code imports | 102 |
| Import statements between two provider units | 96 |
| Import statements from provider code to packages and builtins | 142 |

A unit is one provider's code: its directory, or its flat file with the files that share its name as a prefix.
The readers that the agent admissions and the confirmation gate import from provider directories drag a closure of about 30,000 lines over more than 100 provider modules with them, which is why the moves are sliced (see "Slices of PR 8").

## Destinations

Each core module provider code imports gets one destination of three kinds.

- `SDK /<subpath>`: pure code or types a provider needs to compute its own answers, the same for every provider, with no I/O, no process-wide state, no environment or working directory and no host policy. The subpath is the one it is proposed under, and PR 9 fixes it.
- `host service: <name>`: code that carries host policy, process-wide state or I/O the host owns, such as egress and transports, trust material, files, logging, ambient credentials, the run registry and in-flight bounds, and the secret scrub. A provider reaches it through the context the host passes.
- `core only`: code that holds a core decision or reads a core registry. A provider's import of it is a reverse dependency the named slice removes, and the provider receives the value through the contract instead.

The destination is that of what provider code imports from the module.
Where that part mixes pure code with host state, the destination is the stricter one, and the reason names the split PR 9 makes.

## Core modules provider code imports

| Module | Destination | Reason |
|---|---|---|
| `src/lib/api/error-codes.ts` | SDK /errors | The API error code enumeration is pure data, and a provider error that carries a code names one of its values. |
| `src/lib/app-version.ts` | host service: build identity | The version is what the host build injected into its environment, so a provider reads it from the context rather than from the environment. |
| `src/lib/connection-string-parser.ts` | core only | It reads core's connection string registry; db2 parses a paste through its own connection string row instead. |
| `src/lib/db/auth/aws/sigv4.ts` | SDK /auth | The SigV4 core is pure computation over `node:crypto`, with the signing policy passed in by the caller. |
| `src/lib/db/auth/google/credentials.ts` | host service: ambient credentials | It reads the server's own identity in Application Default Credentials order, credentials the host owns. |
| `src/lib/db/auth/google/token-source.ts` | host service: ambient credentials | It signs, fetches and refreshes access tokens over the host's guarded egress. |
| `src/lib/db/base-provider.ts` | core only | The base class of the legacy provider bridge reads core registries (the engine facets and the driver error rows); a native provider is declared through the SDK's contract instead. |
| `src/lib/db/connection-fingerprint.ts` | host service: connection fingerprint | Which fields name the server a plan was made against is a host decision the apply step checks, so the host computes the fingerprint and passes it. |
| `src/lib/db/connection-string/shared.ts` | SDK /manifest | Pure parsing helpers a connection string row composes. |
| `src/lib/db/connection-string/types.ts` | SDK /manifest | The connection string row contract. |
| `src/lib/db/console/bounds.ts` | SDK /console | Pure UTF-8 length arithmetic, the unit every console bound is stated in. |
| `src/lib/db/console/completion.ts` | SDK /console | Pure code of the shared console layer, the same for every console provider. |
| `src/lib/db/console/dialect.ts` | SDK /console | A console dialect as data, the contract a console provider fills in. |
| `src/lib/db/console/format.ts` | SDK /console | Pure code of the shared console layer, the same for every console provider. |
| `src/lib/db/console/guard.ts` | SDK /console | Pure code of the shared console layer, the same for every console provider. |
| `src/lib/db/console/parser.ts` | SDK /console | Pure code of the shared console layer, the same for every console provider. |
| `src/lib/db/console/shell-words.ts` | SDK /console | Pure POSIX shell word reading, shipped to the browser as well. |
| `src/lib/db/console/tagged-json.ts` | SDK /console | The pure JSON value form a console body is read into. |
| `src/lib/db/credential-warnings.ts` | core only | The seed credential refusal is a core check over a core table keyed by type-id; core runs it before it builds the provider, as FND-2 did for the other connection checks. |
| `src/lib/db/destructive-vocabulary.ts` | core only | The shape of the confirmation gate's rows, which move into core statement-language family modules in PR 8b and the language slices, so no provider declares one. |
| `src/lib/db/editor-language/types.ts` | SDK /manifest | The editor language row contract; its Monaco types go with the browser catalog of phase 3. |
| `src/lib/db/engine-facets/types.ts` | SDK /manifest | The engine facets row contract. |
| `src/lib/db/errors.ts` | SDK /errors | The error classes a provider raises and core classifies by kind, the same for every provider. |
| `src/lib/db/execution-ui/shared.ts` | SDK /manifest | A constant execution UI rows share. |
| `src/lib/db/execution-ui/types.ts` | SDK /manifest | The execution UI row contract. |
| `src/lib/db/graph-policy-profiles.ts` | core only | Core's table of graph policy profiles by type-id, which itself imports the neo4j profile; neo4j's editor language reads its own profile instead. |
| `src/lib/db/graph/bolt/bolt-client.ts` | host service: Bolt transport | The one audited neo4j-driver-lite client opens sockets and reads trust files, I/O the host owns. |
| `src/lib/db/graph/bolt/client.ts` | SDK /graph | The pure `GraphClient` interface and its error type, the graph layer's I/O seam. |
| `src/lib/db/graph/bolt/uri.ts` | SDK /graph | Pure derivation of one Bolt endpoint from a saved connection's fields. |
| `src/lib/db/graph/cypher/lexer.ts` | SDK /graph | The pure Cypher lexer, shipped to the browser as well. |
| `src/lib/db/graph/cypher/quote.ts` | SDK /graph | Pure Cypher name quoting. |
| `src/lib/db/graph/cypher/read-policy.ts` | SDK /graph | The pure Cypher read policy over tokens and a profile. |
| `src/lib/db/graph/graph-base-provider.ts` | core only | The graph half of the legacy provider bridge, extending `BaseDatabaseProvider`; a native graph provider declares the contract instead. |
| `src/lib/db/graph/objects.ts` | SDK /graph | The pure graph object surface. |
| `src/lib/db/graph/profile.ts` | SDK /graph | The pure half of a graph engine profile. |
| `src/lib/db/grpc/channel.ts` | host service: gRPC transport | The one gRPC channel the host opens, with its option set, deadlines and cancellation. |
| `src/lib/db/grpc/tls.ts` | host service: gRPC transport | It turns the TLS panel into trust material and a client identity for the host's channel. |
| `src/lib/db/http/bounded-body.ts` | SDK /net | Pure bounded UTF-8 reading of a response body. |
| `src/lib/db/http/egress-policy.ts` | host service: egress | The egress decision and the guarded DNS and HTTP agents carry host policy. |
| `src/lib/db/http/endpoint.ts` | host service: egress | It mixes pure host and port validators with the link-local and redirect refusals of the egress policy it imports; the SDK takes the pure validators when PR 9 splits it. |
| `src/lib/db/http/fetch-failure.ts` | SDK /net | Pure wording of a network failure; the TLS failure code test it reads from `node-transport.ts` moves with it when PR 9 splits that module. |
| `src/lib/db/http/node-transport.ts` | host service: egress | The shared REST transport over Node's sockets, bound to the egress policy. |
| `src/lib/db/inventory-bounds.ts` | host service: run bounds | How much one inventory read may take is a host decision the object browser and the inventory route share; a provider receives the bound. |
| `src/lib/db/map-database-error.ts` | core only | It reads core's driver error registry; the host classifies a native provider's errors through that provider's own row. |
| `src/lib/db/migration-ddl/shared.ts` | SDK /manifest | Pure statement builders a migration DDL row shares. |
| `src/lib/db/migration-ddl/types.ts` | SDK /manifest | The migration DDL row contract. |
| `src/lib/db/object-edit.ts` | SDK /objects | The pure edit text bound and position mapping. |
| `src/lib/db/object-kinds.ts` | SDK /objects | Pure derivations over a provider's object declarations. |
| `src/lib/db/object-path.ts` | SDK /objects | The pure order and spelling of object paths. |
| `src/lib/db/query-dialects.ts` | SDK /manifest | Provider code imports only the `DialectSpec` row type; the registry itself stays core and loses its kubernetes import in PR 11 editor and SQL text. |
| `src/lib/db/query-generators/shared.ts` | SDK /manifest | Pure pieces a query generator row shares. |
| `src/lib/db/query-generators/types.ts` | SDK /manifest | The query generator row contract. |
| `src/lib/db/read-allowance.ts` | host service: run bounds | The billed-read allowance is a ledger of one agent run or MCP call, which the host owns. |
| `src/lib/db/redaction/metadata-only.ts` | SDK /redaction | Pure projection helpers for the metadata-only answer mode. |
| `src/lib/db/sql-grammar/shared.ts` | SDK /manifest | Shared grammar values a SQL grammar row composes. |
| `src/lib/db/sql-grammar/types.ts` | SDK /manifest | The SQL grammar row contract. |
| `src/lib/db/sql-writing/export-shared.ts` | SDK /manifest | Pure helpers the export forms of a SQL writing row share. |
| `src/lib/db/sql-writing/shared.ts` | SDK /manifest | The literal, identifier and placeholder forms more than one SQL writing row spells alike. |
| `src/lib/db/sql-writing/types.ts` | SDK /manifest | The SQL writing row contract. |
| `src/lib/db/types.ts` | SDK /types | The provider interface types, capabilities, results and schema shapes; the core-only types it also declares stay behind when PR 9 splits it. |
| `src/lib/db/utils/admitted-file.ts` | host service: file admission | The file the host's factory admitted, read from what the host passed. |
| `src/lib/db/utils/bounded-limiter.ts` | host service: run registry | Process-wide in-flight bounds and the run registry a provider cancels by. |
| `src/lib/db/utils/catalog-sessions.ts` | SDK /util | An instance-scoped holder of per-catalog sessions with an injected clock, holding no process-wide state. |
| `src/lib/db/utils/create-directory.ts` | host service: files | It creates folders on the host's file system. |
| `src/lib/db/utils/json-integers.ts` | SDK /values | Pure handling of 64-bit integers in JSON text. |
| `src/lib/db/utils/json-repeated-key.ts` | SDK /values | Pure detection of a repeated key in JSON text. |
| `src/lib/db/utils/measured-aggregate.ts` | SDK /rows | Pure reading of a nullable aggregate. |
| `src/lib/db/utils/pool-manager.ts` | SDK /rows | Provider code imports only `formatBytes` and `formatDuration`, pure display formatting; the pool helpers stay core. |
| `src/lib/db/utils/positional-rows.ts` | SDK /rows | Pure keying of positionally read rows by column name. |
| `src/lib/db/utils/query-limiter.ts` | host service: row limit | The default and maximum row limits are host policy, and the limiter resolves a grammar through core's registry; the host applies the bound, and the grammar readers it uses go to SDK /sql. |
| `src/lib/db/utils/regular-file.ts` | host service: files | It opens and inspects files on the host's file system. |
| `src/lib/db/utils/require-trust-material.ts` | host service: trust material | It reads the operator's CA material the host built the provider with. |
| `src/lib/db/utils/require-tunnel-route.ts` | host service: tunnel route | It reads the tunnel route the host's factory decided and opened. |
| `src/lib/db/utils/result-fields.ts` | SDK /rows | Pure column naming over rows of differing shapes. |
| `src/lib/db/utils/server-text.ts` | host service: secret scrub | The one boundary a server's text crosses before Studio logs or shows it, the FND-7 scrub the host owns. |
| `src/lib/db/utils/unwritable-file.ts` | host service: files | It probes the host's file system for write access. |
| `src/lib/db/vector/count.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/vector/dense.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/vector/probe.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/vector/score.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/vector/sparse.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/vector/types.ts` | SDK /vector | Pure code of the vector family layer, in words no engine owns. |
| `src/lib/db/write-reach.ts` | SDK /manifest | The pure fold of a provider's per-path write declaration. |
| `src/lib/editor/sql-completions.ts` | core only | The editor's Monaco completion provider, which reads core's grammar registry; mongodb imports only its `SchemaCompletionCache` type, which the editor language row contract carries. |
| `src/lib/explain/bigquery-dryrun.ts` | SDK /manifest | A marker the explain strategy writes and the provider reads, which belongs in the provider's explain row. |
| `src/lib/explain/firestore-explain.ts` | SDK /manifest | A marker the explain strategy writes and the provider reads, which belongs in the provider's explain row. |
| `src/lib/is-record.ts` | SDK /util | A pure type guard. |
| `src/lib/languages/influxql/agent-statement.ts` | SDK /influxql | The agent's reader of one InfluxQL statement, pure; the influxdb provider's agent profile runs it and the admission reads it. |
| `src/lib/languages/influxql/lexer.ts` | SDK /influxql | InfluxQL read as tokens as the server's scanner reads it, pure; the provider, the editor language and the policy read it. |
| `src/lib/languages/influxql/policy.ts` | SDK /influxql | The InfluxQL read policy, pure; the provider and the confirmation gate ask the same function. |
| `src/lib/languages/oxiacli/agent-statement.ts` | SDK /oxiacli | The agent's reader of one oxia client command. |
| `src/lib/languages/oxiacli/commands.ts` | SDK /oxiacli | The oxia client command table and parser the provider and the gate read. |
| `src/lib/languages/oxiacli/constants.ts` | SDK /oxiacli | The numbers and fixed names the oxia command language reads: the CLI's default port, the internal key prefix, the list and scan limits, the text bound and the echo width. |
| `src/lib/languages/oxiacli/lexer.ts` | SDK /oxiacli | The oxia command line's tokens and shell words, read by the editor syntax and the parser. |
| `src/lib/languages/rediscli/command-text.ts` | SDK /rediscli | The Redis command line reader of the rediscli statement language family, pure code the redis provider runs and the confirmation gate reads; the SDK republishes a family's readers under the language's subpath. |
| `src/lib/logger.ts` | host service: logging | The process logger, with its level filtering and the logged-text scrub. |
| `src/lib/monitoring-cache-ratio.ts` | SDK /monitoring | Pure display text for a cache hit ratio. |
| `src/lib/sql/grammar.ts` | core only | `resolveSqlGrammar` and `readsSqlText` read core's SQL grammar registry, so a provider reads its own grammar row instead; the `SqlGrammar` type and the default grammar are SDK /sql's since the split. |
| `src/lib/sql/identifier.ts` | core only | `quoteIdentifier` reads core's SQL writing registry by type-id; a provider quotes through its own SQL writing row. |
| `src/lib/sql/leading-keyword.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/sql/operative-keyword.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/sql/result-order.ts` | core only | `hasResultOrder` resolves the grammar by type-id through core's registry; the SDK reader takes the grammar as an argument once PR 9 splits it. |
| `src/lib/sql/spans.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/sql/statement-end.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/sql/statement-splitter.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/sql/values.ts` | core only | `quoteLiteral` and `unquoteLiteral` read core's SQL writing registry by type-id; a provider spells literals through its own SQL writing row. |
| `src/lib/sql/words.ts` | SDK /sql | A pure reader that takes the grammar as an argument; it reaches no provider module, which the guard holds. |
| `src/lib/types.ts` | SDK /types | The connection record and result types a provider reads and returns; the core-only types it also declares stay behind when PR 9 splits it. |

## Imports between provider directories

These are a snapshot; they leave the provider tree only when their slice moves them.

| Imported module | Importers | Destination |
|---|---|---|
| `sql/read-only-budget.ts` | 37 units, and core | the SQL family, `src/lib/sql/`, in PR 8 sql |
| `sql/sql-base.ts` | 18 units | the legacy SQL base class, retired with the legacy bridge |
| `sql/column-types.ts` | 6 units | SDK `/sql`, as a pure column type reader |
| `sql/read-only-refusals.ts`, `sql/read-query-forms.ts`, `sql/mssql-read-only-refusals.ts` | core, and one another | the SQL family, `src/lib/sql/`, in PR 8 sql |
| `sql/pg-wire-cancel.ts` | postgres | moves into the postgres provider |
| `sql/sqlite-create-table.ts`, `sql/sqlite-int64.ts` | libsql | an SDK subpath shared by the two SQLite dialects, which PR 9 names |
| `industrial/mtconnect/xml.ts`, `industrial/mtconnect/xml-bounds.ts` | netconf | SDK `/xml`, as a pure bounded XML reader |

## Packages provider code imports

These are a snapshot as well.

- A database driver travels with its provider package: `pg`, `mysql2`, `mssql`, `oracledb`, `mongodb`, `ioredis`, `cassandra-driver`, `db2-node`, `@duckdb/node-api`, `@platformatic/kafka`, the `node-opcua` packages, `ssh2`, `mqtt-packet`, `hyparquet`, `apache-arrow` and `@libredb/libredb`.
- Helper packages travel the same way: `yaml`, `jose` and `@grpc/proto-loader`.
- `node:` builtins are part of the runtime every provider runs in: `node:crypto` in 17 units, `node:net` in 9 and `node:tls` in 5 are the most used.
- `monaco-editor` is imported by the 11 editor language rows, and goes with the browser catalog of phase 3.
- `@libredb/provider-sdk` is the contract every provider builds on, imported by name: `/values` holds the value codec that was `src/lib/db/value-codec.ts`, and `/errors` the error record's vocabulary and the driver error row contract that was `src/lib/db/driver-errors/types.ts`.
- `@libredb/provider-sdk/sql` is imported by 47 provider files, the 41 grammar rows among them, for the grammar facts' type and compatibility default.

## Imports from core into provider directories

Each row is one core file of the allowlist in `tests/unit/lib/db/provider-imports/inward-allowlist.ts`, which names its modules.
The Imports cell starts with the file's module count, and "Removed by" names the slice or slices that remove them.

| Core file | Imports | Removed by | Destination |
|---|---|---|---|
| `scripts/generate-snmp-mib-objects.ts` | 1 snmp MIB name module | snmp native PR | moves with the snmp provider package as its generator |
| `src/app/api/db/profile/route.ts` | 1 mongodb generator module (`jsonCommandAddress`, `outermostFieldPaths`) | PR 8 mongo | the mongo family, `src/lib/languages/mongo/` |
| `src/lib/agent/languages/cypher/adapter.ts` | 1 statement reader module | PR 8 cypher | the Cypher family, `src/lib/db/graph/cypher/` |
| `src/lib/agent/languages/etcdctl/adapter.ts` | 1 statement reader module | PR 8 etcdctl | the etcdctl family, `src/lib/languages/etcdctl/` |
| `src/lib/agent/languages/fsquery/adapter.ts` | 1 statement reader module | PR 8 fsquery | the fsquery family, `src/lib/languages/fsquery/` |
| `src/lib/agent/languages/kafkaread/adapter.ts` | 1 statement reader module | PR 8 kafkaread | the kafkaread family, `src/lib/languages/kafkaread/` |
| `src/lib/agent/languages/kubectl/adapter.ts` | 1 statement reader module | PR 8 kubectl | the kubectl family, `src/lib/languages/kubectl/` |
| `src/lib/agent/languages/kubectl/definitions.ts` | 1 agent fact and reader module | PR 8 kubectl | the kubectl family, `src/lib/languages/kubectl/` |
| `src/lib/agent/languages/libredbkv/adapter.ts` | 1 statement reader module | PR 8 libredbkv | the libredbkv family, `src/lib/languages/libredbkv/` |
| `src/lib/agent/languages/milvusrpc/adapter.ts` | 1 statement reader module | PR 8 milvusrpc | the milvusrpc family, `src/lib/languages/milvusrpc/` |
| `src/lib/agent/languages/modbusread/adapter.ts` | 1 statement reader module | PR 8 modbusread | the modbusread family, `src/lib/languages/modbusread/` |
| `src/lib/agent/languages/modbusread/definitions.ts` | 3 agent fact and reader modules | PR 8 modbusread | the modbusread family, `src/lib/languages/modbusread/` |
| `src/lib/agent/languages/modbusread/server.ts` | 2 agent fact and reader modules | PR 8 modbusread | the modbusread family, `src/lib/languages/modbusread/` |
| `src/lib/agent/languages/mqttread/adapter.ts` | 1 statement reader module | PR 8 mqttread | the mqttread family, `src/lib/languages/mqttread/` |
| `src/lib/agent/languages/mqttread/definitions.ts` | 3 agent fact and reader modules | PR 8 mqttread | the mqttread family, `src/lib/languages/mqttread/` |
| `src/lib/agent/languages/mqttread/mcp.ts` | 2 agent fact and reader modules | PR 8 mqttread | the mqttread family, `src/lib/languages/mqttread/` |
| `src/lib/agent/languages/mqttread/server.ts` | 2 agent fact and reader modules | PR 8 mqttread | the mqttread family, `src/lib/languages/mqttread/` |
| `src/lib/agent/languages/mtconnectread/adapter.ts` | 1 statement reader module | PR 8 mtconnectread | the mtconnectread family, `src/lib/languages/mtconnectread/` |
| `src/lib/agent/languages/mtconnectread/definitions.ts` | 2 agent fact and reader modules | PR 8 mtconnectread | the mtconnectread family, `src/lib/languages/mtconnectread/` |
| `src/lib/agent/languages/mtconnectread/mcp.ts` | 1 agent fact and reader module | PR 8 mtconnectread | the mtconnectread family, `src/lib/languages/mtconnectread/` |
| `src/lib/agent/languages/mtconnectread/server.ts` | 1 agent fact and reader module | PR 8 mtconnectread | the mtconnectread family, `src/lib/languages/mtconnectread/` |
| `src/lib/agent/languages/netconfrpc/adapter.ts` | 1 statement reader module | PR 8 netconfrpc | the netconfrpc family, `src/lib/languages/netconfrpc/` |
| `src/lib/agent/languages/netconfrpc/definitions.ts` | 1 agent fact and reader module | PR 8 netconfrpc | the netconfrpc family, `src/lib/languages/netconfrpc/` |
| `src/lib/agent/languages/netconfrpc/server.ts` | 1 agent fact and reader module | PR 8 netconfrpc | the netconfrpc family, `src/lib/languages/netconfrpc/` |
| `src/lib/agent/languages/opcuaread/adapter.ts` | 1 statement reader module | PR 8 opcuaread | the opcuaread family, `src/lib/languages/opcuaread/` |
| `src/lib/agent/languages/opcuaread/definitions.ts` | 2 agent fact and reader modules | PR 8 opcuaread | the opcuaread family, `src/lib/languages/opcuaread/` |
| `src/lib/agent/languages/opcuaread/server.ts` | 1 agent fact and reader module | PR 8 opcuaread | the opcuaread family, `src/lib/languages/opcuaread/` |
| `src/lib/agent/languages/promql/adapter.ts` | 1 statement reader module | PR 8 promql | the promql family, `src/lib/languages/promql/` |
| `src/lib/agent/languages/promql/server.ts` | 1 agent fact and reader module | PR 8 promql | the promql family, `src/lib/languages/promql/` |
| `src/lib/agent/languages/qdrantapi/adapter.ts` | 1 statement reader module | PR 8 qdrantapi | the qdrantapi family, `src/lib/languages/qdrantapi/` |
| `src/lib/agent/languages/rabbitread/adapter.ts` | 1 statement reader module | PR 8 rabbitread | the rabbitread family, `src/lib/languages/rabbitread/` |
| `src/lib/agent/languages/rediscli/adapter.ts` | 1 statement reader module | PR 8 rediscli | the rediscli family, `src/lib/languages/rediscli/` |
| `src/lib/agent/languages/s3api/adapter.ts` | 1 statement reader module | PR 8 s3api | the s3api family, `src/lib/languages/s3api/` |
| `src/lib/agent/languages/snmpget/adapter.ts` | 1 statement reader module | PR 8 snmpget | the snmpget family, `src/lib/languages/snmpget/` |
| `src/lib/agent/languages/snmpget/definitions.ts` | 1 agent fact and reader module | PR 8 snmpget | the snmpget family, `src/lib/languages/snmpget/` |
| `src/lib/agent/languages/snmpget/server.ts` | 1 agent fact and reader module | PR 8 snmpget | the snmpget family, `src/lib/languages/snmpget/` |
| `src/lib/agent/languages/sparkplugread/adapter.ts` | 1 statement reader module | PR 8 sparkplugread | the sparkplugread family, `src/lib/languages/sparkplugread/` |
| `src/lib/agent/languages/sparkplugread/definitions.ts` | 4 agent fact and reader modules | PR 8 sparkplugread | the sparkplugread family, `src/lib/languages/sparkplugread/` |
| `src/lib/agent/languages/sparkplugread/mcp.ts` | 1 agent fact and reader module | PR 8 sparkplugread | the sparkplugread family, `src/lib/languages/sparkplugread/` |
| `src/lib/agent/languages/sparkplugread/server.ts` | 2 agent fact and reader modules | PR 8 sparkplugread | the sparkplugread family, `src/lib/languages/sparkplugread/` |
| `src/lib/agent/languages/weaviateapi/adapter.ts` | 1 statement reader module | PR 8 weaviateapi | the weaviateapi family, `src/lib/languages/weaviateapi/` |
| `src/lib/connection-string-parser.ts` | 2 paste readers, re-exported (databend, snowflake) | PR 11 connection | the manifest's connection section |
| `src/lib/db/connection-form.ts` | 1 snowflake account host reader | PR 11 connection | the manifest's connection section |
| `src/lib/db/connection-string/index.ts` | 43 connection string rows | PR 11 connection | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/destructive-commands.ts` | 7 confirmation vocabulary rows | PR 8 etcdctl, PR 8 fsquery, PR 8 kubectl, PR 8 milvusrpc, PR 8 qdrantapi, PR 8 s3api, PR 8 weaviateapi | each row into its statement language's core family module |
| `src/lib/db/driver-errors/index.ts` | 7 driver error rows | PR 11 policy | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/editor-language/index.ts` | 15 editor language rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/engine-facets/index.ts` | 43 engine facets rows | PR 11 policy | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/execution-ui/index.ts` | 43 execution UI rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/factory.ts` | 42 provider entry modules, imported dynamically | PR 12 | providers loaded at runtime by the loader |
| `src/lib/db/graph-policy-profiles.ts` | 1 neo4j policy profile | PR 8 cypher | the Cypher family, `src/lib/db/graph/cypher/` |
| `src/lib/db/migration-ddl/index.ts` | 43 migration DDL rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/operations/cypher-admission.ts` | 1 statement reader module | PR 8 cypher | the Cypher family, `src/lib/db/graph/cypher/` |
| `src/lib/db/operations/descriptors.ts` | 1 mongodb envelope reader | PR 8 mongo | the mongo family, `src/lib/languages/mongo/` |
| `src/lib/db/operations/etcdctl-admission.ts` | 1 statement reader module | PR 8 etcdctl | the etcdctl family, `src/lib/languages/etcdctl/` |
| `src/lib/db/operations/fsquery-admission.ts` | 1 statement reader module | PR 8 fsquery | the fsquery family, `src/lib/languages/fsquery/` |
| `src/lib/db/operations/kafkaread-admission.ts` | 1 statement reader module | PR 8 kafkaread | the kafkaread family, `src/lib/languages/kafkaread/` |
| `src/lib/db/operations/kubectl-admission.ts` | 1 statement reader module | PR 8 kubectl | the kubectl family, `src/lib/languages/kubectl/` |
| `src/lib/db/operations/libredbkv-admission.ts` | 1 statement reader module | PR 8 libredbkv | the libredbkv family, `src/lib/languages/libredbkv/` |
| `src/lib/db/operations/milvusrpc-admission.ts` | 1 statement reader module | PR 8 milvusrpc | the milvusrpc family, `src/lib/languages/milvusrpc/` |
| `src/lib/db/operations/modbusread-admission.ts` | 1 statement reader module | PR 8 modbusread | the modbusread family, `src/lib/languages/modbusread/` |
| `src/lib/db/operations/mongo-admission.ts` | 1 statement reader module | PR 8 mongo | the mongo family, `src/lib/languages/mongo/` |
| `src/lib/db/operations/mqttread-admission.ts` | 1 statement reader module | PR 8 mqttread | the mqttread family, `src/lib/languages/mqttread/` |
| `src/lib/db/operations/mtconnectread-admission.ts` | 1 statement reader module | PR 8 mtconnectread | the mtconnectread family, `src/lib/languages/mtconnectread/` |
| `src/lib/db/operations/netconfrpc-admission.ts` | 1 statement reader module | PR 8 netconfrpc | the netconfrpc family, `src/lib/languages/netconfrpc/` |
| `src/lib/db/operations/opcuaread-admission.ts` | 1 statement reader module | PR 8 opcuaread | the opcuaread family, `src/lib/languages/opcuaread/` |
| `src/lib/db/operations/promql-admission.ts` | 1 statement reader module | PR 8 promql | the promql family, `src/lib/languages/promql/` |
| `src/lib/db/operations/qdrantapi-admission.ts` | 1 statement reader module | PR 8 qdrantapi | the qdrantapi family, `src/lib/languages/qdrantapi/` |
| `src/lib/db/operations/rabbitread-admission.ts` | 1 statement reader module | PR 8 rabbitread | the rabbitread family, `src/lib/languages/rabbitread/` |
| `src/lib/db/operations/read-only-statement.ts` | 1 SQL read-only budget reader | PR 8 sql | the SQL family, `src/lib/sql/` |
| `src/lib/db/operations/rediscli-admission.ts` | 1 statement reader module | PR 8 rediscli | the rediscli family, `src/lib/languages/rediscli/` |
| `src/lib/db/operations/s3api-admission.ts` | 1 statement reader module | PR 8 s3api | the s3api family, `src/lib/languages/s3api/` |
| `src/lib/db/operations/snmpget-admission.ts` | 1 statement reader module | PR 8 snmpget | the snmpget family, `src/lib/languages/snmpget/` |
| `src/lib/db/operations/sparkplugread-admission.ts` | 1 statement reader module | PR 8 sparkplugread | the sparkplugread family, `src/lib/languages/sparkplugread/` |
| `src/lib/db/operations/weaviateapi-admission.ts` | 1 statement reader module | PR 8 weaviateapi | the weaviateapi family, `src/lib/languages/weaviateapi/` |
| `src/lib/db/query-dialects.ts` | 1 kubernetes query dialect row | PR 11 editor and SQL text | a manifest row |
| `src/lib/db/query-generators/index.ts` | 27 query generator rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/sql-grammar/index.ts` | 43 SQL grammar rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/db/sql-writing/index.ts` | 43 SQL writing rows | PR 11 editor and SQL text | manifest rows: the PR 9 schema, collected by the PR 11 projection |
| `src/lib/explain/firestore-explain.ts` | 1 firestore console parser | PR 8 fsquery | the fsquery family, `src/lib/languages/fsquery/` |
| `src/lib/kubernetes/kubeconfig-import.ts` | 1 kubernetes limits module | PR 11 connection | the manifest's connection section |
| `src/lib/mcp/tools/read-query-limits.ts` | 2 SQL read readers (`read-only-refusals.ts`, `read-query-forms.ts`) | PR 8 sql | the SQL family, `src/lib/sql/` |

## Slices of PR 8

| Slice | Content |
|---|---|
| PR 8a | This census and its guard, with no source change. |
| PR 8b | The 13 confirmation vocabulary rows with no closure inside the provider tree (mongodb, neo4j, modbus, mtconnect, opcua, sparkplug, mqtt, netconf, snmp, kafka, rabbitmq, prometheus, and redis with its command text reader) move into their statement language's core family module. |
| PR 8 `<language>` | One slice per statement language, or a few small ones together: the language's remaining confirmation row with its reader closure, its admission reader, its agent pack's provider imports and its other core readers move into the family module. |
| Later program PRs | PR 11 turns the registry indexes into generated projections, PR 12's loader replaces the factory's static imports, and the snmp native PR takes its generator script. |

The recommended order of the language slices is the confirmation families first (influxql, oxiacli, weaviateapi, kubectl, qdrantapi, milvusrpc, fsquery, s3api, etcdctl), then the admission-only ones from small to large (libredbkv, kafkaread, cypher, promql, rediscli, mqttread, sparkplugread, modbusread, mongo, mtconnectread, rabbitread, netconfrpc, opcuaread, snmpget), then `sql`.
A family module lives in `src/lib/sql/` for `sql`, in `src/lib/db/graph/cypher/` for `cypher`, and in `src/lib/languages/<language>/` for every other statement language.
A language slice may move an agent fact to PR 11 agent instead, changing its row here in its own PR with the reason.

## The rule

No core file gains an import into a provider directory.
`tests/unit/lib/db/provider-imports.test.ts` holds the tree to exactly the pairs of its allowlist: a new pair fails by name, and so does a listed pair the source no longer holds.
Each slice deletes its pairs from the allowlist and its rows from the inward table in the same PR, so both only shrink.
The one growth allowed before PR 11 and PR 12 land is a new type-id's row modules in the ten collector entries, the nine registry indexes and `src/lib/db/factory.ts`, added to the allowlist and counted here in the PR that adds the type-id.

A provider that imports a core module the outward table does not list fails the same test until the module gets a row and a destination here.
The same test holds the outward rows whose destination is SDK /sql: the value imports of each such module reach no provider module, so the readers it names can move into the SDK without bringing a provider row with them.

## Limits

- An `import()` or `require()` whose argument is not a literal is not seen; no core file that names `providers` holds one today.
- Tests, e2e and workspace packages are not scanned.
  The SDK package needs no place in this scan: the package import rule (`tests/unit/package-imports.test.ts`, packages/README.md "Imports") refuses any import out of a package, so the SDK cannot import a provider directory, and core reaches the SDK only by its name.
  PR 14 widens the scan to provider packages as provider directories.
- Files under `docker/` are not scanned either; `docker/s3/make-data.ts`, the S3 sample data generator, imports an S3 constant from its provider directory.

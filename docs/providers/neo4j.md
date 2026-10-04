# Neo4j Provider

The `neo4j` type-id: read-only graph browsing over Bolt, tested and claimed on Neo4j 5.26 LTS.
Source: [`src/lib/db/providers/graph/neo4j/`](../../src/lib/db/providers/graph/neo4j/), on the shared graph layer [`src/lib/db/graph/`](../../src/lib/db/graph/).
Tests: [`tests/unit/db/neo4j/`](../../tests/unit/db/neo4j/), [`tests/unit/db/graph/`](../../tests/unit/db/graph/), [`tests/integration/db/neo4j-provider.test.ts`](../../tests/integration/db/neo4j-provider.test.ts) and [`tests/integration/db/neo4j-bolt-composed.test.ts`](../../tests/integration/db/neo4j-bolt-composed.test.ts).

## 1. Overview

Studio reads a Neo4j database through Cypher typed in the editor, shows its node labels, relationship types, indexes and constraints in the object tree, and reads the monitoring panels Community serves.
It writes nothing: every statement passes a read policy before anything is sent, then the server's own classification (an allowlisted SHOW form skips it, and an allowlisted procedure call classified `s` runs, section 3.5), and then runs in a READ session, so a write has to defeat three layers (section 3.1).
Nodes, relationships and paths reach the grid as tagged JSON cells, and the column header names the graph type (section 5.2); a Graph tab beside the grid draws them (section 5.6).
Plan mode drafts Cypher and the MCP metadata tools list Neo4j connections and their shape, while agent execution and MCP `run_read_query` do not serve Neo4j (section 3.6).

### Concept mapping

| Neo4j | Studio |
|---|---|
| One database (`neo4j`, or the one the connection names) | One connection, with that database as its one container |
| A node label | A row of Node labels, with its properties as columns |
| A relationship type | A row of Relationship types, with its properties as columns |
| An index, a constraint | A row of Indexes or Constraints, listed with no click action |
| A Cypher read | One statement per run in the editor |
| A node, a relationship, a path in a result | A JSON cell tagged `"~graph"`, drawn by the Graph tab |

## 2. Architecture

### 2.1 Where it sits

`Neo4jProvider` extends `GraphBaseProvider`, which extends `BaseDatabaseProvider`, in the `graph` family.
`GraphBaseProvider` owns the query path, the object surface, the cancel and the catalog cache, and an engine supplies a `GraphEngineProfile`: its policy lists, its port, its statement gate, its catalog reads and its error table.
So `src/lib/db/providers/graph/neo4j/` holds declarations, the profile and the monitoring reads, and nothing of the query path.
The graph layer is split by what may reach the browser: `src/lib/db/graph/cypher/`, `objects.ts`, `profile.ts` and `values.ts` are pure and shipped to the browser, because the editor's tokens provider, completion and generators read them, while `src/lib/db/graph/bolt/` and `graph-base-provider.ts` run on the server only.
`neo4j-driver-lite` is imported by `bolt/bolt-client.ts` and `bolt/record-values.ts` alone, and `tests/unit/db/graph/seam-guard.test.ts` holds the driver members they may call and the layer direction.

### 2.2 Modules

| File | What it owns |
|---|---|
| `graph/cypher/lexer.ts`, `statements.ts`, `quote.ts` | The Cypher lexer the policy and the editor share, the statement splitter, and name and string quoting |
| `graph/cypher/read-policy.ts` | The read policy over tokens, driven by a `GraphPolicyProfile` |
| `graph/cypher/generators.ts` | The tree click's sample reads |
| `graph/objects.ts`, `graph/values.ts`, `graph/profile.ts` | The object kinds and their path segments, the JSON forms of graph values, and the policy profile's types |
| `graph/result-graph.ts` | The Graph tab's model of a result: its nodes, relationships, captions, label colours and counts |
| `graph/bolt/client.ts`, `uri.ts`, `bolt-client.ts`, `record-values.ts` | The `GraphClient` seam, the panel to a Bolt URI, the one driver client, and driver values to JSON |
| `graph/graph-base-provider.ts` | The base class every graph engine extends |
| `neo4j/profile.ts` | `NEO4J_POLICY_PROFILE`: every list of the read policy |
| `neo4j/statement-gate.ts`, `catalog.ts`, `errors.ts` | The EXPLAIN gate, the catalog reads, and the error table |
| `neo4j/monitoring-reads.ts`, `monitoring.ts`, `labels.ts`, `index.ts` | The monitoring reads and their shaping, the labels, and the composition root |

### 2.3 Registration & lifecycle

The constructor validates nothing and opens nothing, so a provider built from any connection answers its capabilities and labels.
`connect()` builds the Bolt endpoint from the host, the port and the TLS panel (section 4.3), opens one driver, verifies connectivity, resolves the database (section 4.4), clears the catalog cache, and reads the kernel's version and edition once, on the connection's database.
Connectivity verification never touches that database, so this read is the first that does: a database the server does not hold (`Neo.ClientError.Database.DatabaseNotFound`) fails the connect, so Test Connection refuses a misspelled database name.
Any other failed version read leaves the version unknown and does not fail the connection.
A second `connect()` closes the previous driver first and aborts its statements.
A `connect()` that overlaps one still in flight awaits that attempt instead of starting its own, so two calls build one driver.
`disconnect()` aborts every statement in flight and closes the driver.

### 2.4 The client, and why

The client is `neo4j-driver-lite` 6.2.0, pinned exactly: the official driver without the RxJS layer, Apache-2.0, pure JavaScript.
Its configuration is fixed and asserted by `tests/unit/db/graph/bolt-client.test.ts`: telemetry off, the product's user agent, the connection's timeout for the socket and for pool acquisition, a pool of four, no transaction retry time, `disableAutoCommitRetries` on, lossless integers, notifications off, and no logger and no resolver.
No logger is passed because at debug level the driver logs every statement, parameter and row.
Only `session.run` is called, in a READ session: `executeQuery`, `executeRead`, `executeWrite` and `beginTransaction` re-run their work on transient errors and are never called, so a statement reaches the server once.
Only the direct `bolt` family is built, never a routing `neo4j://` URI, so no routing table is asked for and no address the server names is dialled.

## 3. Design decisions

### 3.1 Read-only by construction: three layers

Every statement the editor sends, typed, generated by a tree click or drafted by plan mode and then run by the user, takes one road.

1. The read policy of section 3.2 reads its tokens, and a refusal opens no session.
2. The statement gate of section 3.5 asks the server to classify it with `EXPLAIN` and runs it only as a read, or as `s` when it calls an allowlisted procedure; an allowlisted SHOW form skips the gate.
3. It runs in a READ session, which Neo4j 5.26 enforces on an auto-commit transaction: the server refuses a write there with `Neo.ClientError.Statement.AccessMode`, measured on the compose server.

The policy is the boundary, and the other two are defence in depth: the gate classifies `LOAD CSV` and `TERMINATE TRANSACTIONS` as `r` (section 3.4), and READ mode is a measured behaviour, not a documented guarantee.
No production seam turns the policy off.

### 3.2 The read policy

The policy reads tokens, not text: a word inside a string, a comment or a backtick name is never a keyword, and a keyword split by a comment, `LOAD /* x */ CSV`, is still one word sequence.
A unicode escape, a backslash then `u` then four hex digits, is refused before the text is read, wherever it stands, because the server decodes it before it reads the text.
Measured on the compose 5.26.31 server on 2026-10-03: `` RETURN 1 AS `x\u0060y` `` is a syntax error at the `y`, the decoded backtick having ended the name; `RETURN 1 AS x // \u000a , 2 AS y` returns two columns, the decoded line break having ended the comment; and `RETURN 'a\u0027 AS x, \u0027b' AS y` returns two columns, the decoded quote having ended the string.
So a name, a string or a comment holding the escape hides a clause from the tokens the policy reads: `` MATCH (n) WITH count(*) AS `x\u0060 CALL dbms.components() YIELD \u0060name` RETURN name `` ran the procedure.
A backslash starts an escape only at the end of an odd run of backslashes, as the server reads it, so `'C:\\users'` passes; the server keeps an upper-case `\U0060` as written.
It reads one statement: more than one non-empty statement is refused, while a `;` inside a string or a comment and a trailing `;` are not statements.
Procedures, qualified functions and SHOW forms are allowlists, so a name the profile does not list is refused; clauses are a denylist, backed by the gate and READ mode, because the read clauses of Cypher are many and the writing ones few.

Denied words, refused wherever they stand outside a string, a comment or a backtick name, even where Cypher would read them as a property or a map key: `CREATE`, `MERGE`, `SET`, `DELETE`, `DETACH`, `REMOVE`, `DROP`, `FOREACH`, `LOAD`, `ALTER`, `RENAME`, `GRANT`, `DENY`, `REVOKE`, `START`, `STOP`, `ENABLE`, `TERMINATE`, `USE`, `INSERT`, `DEALLOCATE`, `REALLOCATE`, `DRYRUN`, `ROWS`, `TRANSACTIONS` and the sequences `IN TRANSACTIONS` and `CONCURRENT TRANSACTIONS`.
INSERT is GQL's spelling of CREATE, which Neo4j accepts since 5.18.
DEALLOCATE, REALLOCATE and DRYRUN are the commands that move databases between the servers of a cluster.
`USE` is denied because the database is the connection's, and `USE system` reaches the administration surface; `IN TRANSACTIONS` commits batches of its own, and `CONCURRENT TRANSACTIONS` is its parallel form, which may carry a count after `IN`.
`ROWS` and `TRANSACTIONS` are denied on their own because a count between `IN` and the words would let both sequences miss another batch spelling, and the lexer reads `1_000` as a number then a word.
5.26.31 rejects `IN 4 ROWS` and `IN 4 TRANSACTIONS` as syntax errors (measured on 2026-10-03), while `EXPLAIN` classifies the batch forms it accepts, `IN TRANSACTIONS OF 4 ROWS` and `IN 4 CONCURRENT TRANSACTIONS`, as reads, so the gate would not stop them and the words are the only layer.
A property, a map key or a label spelled like a denied word is written in backticks, `` n.`set` ``, and the refusal says so.
So is a label or a variable named `CALL` or `SHOW`, `` (n:`CALL`) ``, since outside a property or a map key the policy reads either word as its clause, and the refusal says so.

Denied namespaces, refused for every qualified name that starts with one, called or not, compared without case: `apoc.` and `gds.`.
The check is fail-closed: `` `apoc`.name ``, a property of a variable named `apoc`, is refused too, and no backtick spelling passes, so such a variable must be renamed; one backticked name holding dots and not called, `` `apoc.x` ``, is a plain name.

Procedures `CALL` may name, compared as Neo4j spells them, a backticked part unquoted first: `db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.schema.visualization`, `db.schema.nodeTypeProperties`, `db.schema.relTypeProperties`, `db.ping` and `dbms.components`.
`CALL {` and `CALL (vars) {` open a subquery, whose body the same rules read.

Qualified functions, a dotted name followed by `(`, are allowed only when the lowercased name is one of the built-in dotted functions Neo4j 5.26.31 lists (`SHOW FUNCTIONS YIELD name, isBuiltIn WHERE isBuiltIn AND name CONTAINS '.'`): `date.realtime`, `date.statement`, `date.transaction`, `date.truncate`, `datetime.fromepoch`, `datetime.fromepochmillis`, `datetime.realtime`, `datetime.statement`, `datetime.transaction`, `datetime.truncate`, `duration.between`, `duration.indays`, `duration.inmonths`, `duration.inseconds`, `graph.byelementid`, `graph.byname`, `localdatetime.realtime`, `localdatetime.statement`, `localdatetime.transaction`, `localdatetime.truncate`, `localtime.realtime`, `localtime.statement`, `localtime.transaction`, `localtime.truncate`, `point.distance`, `point.withinbbox`, `time.realtime`, `time.statement`, `time.transaction`, `time.truncate`, `vector.similarity.cosine` and `vector.similarity.euclidean`.
An unqualified function is not checked: on Neo4j a user-defined function is always namespaced, so an unqualified name is a built-in one.
A backticked name holding dots and called, `` `apoc.text.join`(...) ``, is read as a qualified name.

SHOW forms, each optionally followed by `YIELD`, `WHERE`, `RETURN`, `ORDER BY`, `SKIP` and `LIMIT`: `SHOW INDEXES`, `SHOW INDEX`, `SHOW ALL INDEXES`, `SHOW RANGE INDEXES`, `SHOW TEXT INDEXES`, `SHOW POINT INDEXES`, `SHOW LOOKUP INDEXES`, `SHOW FULLTEXT INDEXES`, `SHOW VECTOR INDEXES`, `SHOW CONSTRAINTS`, `SHOW CONSTRAINT`, `SHOW ALL CONSTRAINTS`, `SHOW UNIQUE CONSTRAINTS`, `SHOW NODE UNIQUENESS CONSTRAINTS`, `SHOW RELATIONSHIP UNIQUENESS CONSTRAINTS`, `SHOW EXISTENCE CONSTRAINTS`, `SHOW KEY CONSTRAINTS`, `SHOW PROPERTY TYPE CONSTRAINTS`, `SHOW DATABASES`, `SHOW DATABASE <name>`, `SHOW DEFAULT DATABASE`, `SHOW HOME DATABASE`, `SHOW PROCEDURES`, `SHOW FUNCTIONS`, `SHOW ALL FUNCTIONS`, `SHOW BUILT IN FUNCTIONS` and `SHOW USER DEFINED FUNCTIONS`.
`SHOW USERS`, `SHOW ROLES`, `SHOW PRIVILEGES`, `SHOW SERVERS`, `SHOW SETTINGS` and every other form are refused.
`SHOW TRANSACTIONS` is refused too, because its `YIELD *` returns other sessions' query text and parameters; the Active sessions panel reads transactions with a fixed column list of its own (section 7).

Prefixes: `CYPHER 5` and `CYPHER 25` pass through to the server, while `EXPLAIN` and `PROFILE` are refused, because the product has no plan view for Cypher and `PROFILE` executes.

A `$parameter` is refused: every statement is literal text in this version, and the tree's generators write literals.

### 3.3 Refusals

Every refusal is a `QueryError` whose sentence names what was refused; a policy refusal carries the offset of what it refused.

| Refused | Example | The sentence |
|---|---|---|
| A unicode escape | `RETURN 'caf\u00e9' AS s` | The statement holds the escape \u00e9, which the server decodes before it reads the text, so it could end a name, a string or a comment early and the server would run a statement other than the one checked. It was not run: type the character itself. |
| Text that does not lex | `MATCH (n) RETURN 'x` | The statement could not be read: unterminated string at character 18. |
| No statement | an empty or comment-only text | There is no statement to run. |
| More than one statement | `MATCH (n) RETURN n; MATCH (m) RETURN m` | Neo4j runs one statement at a time, and this text holds 2. Run them one by one. |
| `EXPLAIN` or `PROFILE` | `EXPLAIN MATCH (n) RETURN n` | EXPLAIN is not supported on Neo4j connections in this version. |
| A denied word | `MATCH (n) SET n.seen = true` | SET is not allowed: Neo4j connections are read-only in this version. If SET is a name here (a property, a map key or a label), write it in backticks, as `SET`. |
| A denied word used as a name | `MATCH (n) RETURN n.set` | SET is not allowed: Neo4j connections are read-only in this version. If SET is a name here (a property, a map key or a label), write it in backticks, as `set`. |
| A procedure outside the allowlist | `CALL dbms.listConfig()` | CALL dbms.listConfig is not allowed: a read-only Neo4j connection can call only db.labels, db.relationshipTypes, db.propertyKeys, db.schema.visualization, db.schema.nodeTypeProperties, db.schema.relTypeProperties, db.ping, dbms.components. |
| `CALL` used as a name | `MATCH (n:CALL) RETURN n` | CALL is not allowed here: a read-only Neo4j connection can call only db.labels, db.relationshipTypes, db.propertyKeys, db.schema.visualization, db.schema.nodeTypeProperties, db.schema.relTypeProperties, db.ping, dbms.components. If CALL is a name here (a property, a map key or a label), write it in backticks, as `CALL`. |
| A denied namespace | `CALL apoc.load.json('http://10.0.0.5/')` | apoc.* is not allowed on Neo4j connections in this version, because its procedures and functions can reach the network or the file system. A name starting apoc. is refused in any position, called or not, so a variable named apoc must be renamed. |
| A SHOW form outside the allowlist | `SHOW USERS` | SHOW USERS is not allowed on a read-only Neo4j connection. |
| `SHOW` used as a name | `MATCH (n:SHOW) RETURN n` | SHOW is not allowed on a read-only Neo4j connection. If SHOW is a name here (a property, a map key or a label), write it in backticks, as `SHOW`. |
| `SHOW TRANSACTIONS` | `SHOW TRANSACTIONS` | SHOW TRANSACTIONS is not allowed on a read-only Neo4j connection. |
| A qualified function outside the allowlist | `RETURN my.custom(1)` | my.custom() is not allowed: a read-only Neo4j connection calls only built-in functions. |
| A parameter | `MATCH (n) WHERE n.id = $id RETURN n` | Parameters such as $id are not supported on Neo4j connections in this version: write the value into the statement. |
| Parameters bound by the caller | a `params` list that is not empty, from the API | Parameters are not supported for Neo4j in this version. |
| The gate: a write | a statement the server classifies `w` | The server classifies this statement as write, and a read-only Neo4j connection runs only reads. |
| The gate: a read and write | a statement the server classifies `rw` | The server classifies this statement as read and write, and a read-only Neo4j connection runs only reads. |
| The gate: a schema or administration statement | a statement the server classifies `s` that calls no allowlisted procedure | The server classifies this statement as a schema or administration statement, and a read-only Neo4j connection runs only reads. |
| The gate: no classification | a plan that carries no query type | The server did not classify this statement, so it was not run. |
| The gate: the check failed | an `EXPLAIN` the server refused, such as a syntax error | The statement could not be checked by the server, so it was not run: <the server's words> |
| The server's READ mode | a write that reached a READ session | The server refused a write: Neo4j connections are read-only in this version. |

### 3.4 Why LOAD CSV and APOC are refused

`LOAD CSV` fetches a URL from the server, and the design's research measured it, through a READ session, reaching a private address the server could see: READ mode does not stop it, and the server classifies `LOAD CSV` as `r` (the capture `tests/fixtures/neo4j/5.26.31/explain-load-csv.json`), so the gate does not stop it either.
APOC's `apoc.load.*` procedures and functions reach the network and the file system the same way, and GDS is a plugin this version has not measured, so its namespace is refused with APOC's.
So `LOAD` is a denied word, `apoc.` and `gds.` are denied namespaces, and every procedure outside the eight above is refused: the policy is the only layer that stops a server-side request to an address the user names.
Widening the allowlist with a measured APOC subset is filed as D140.

### 3.5 The statement gate

After the policy allows a statement, the provider sends it prefixed with `EXPLAIN` in a READ session, with the run's own timeout and cancel, and reads `summary.queryType`; a version prefix stays first, as `CYPHER 5 EXPLAIN <rest>`, and so do the options after `CYPHER`, as `CYPHER 5 runtime=slotted EXPLAIN <rest>`.
Measured on 5.26.31 on 2026-10-03: `CYPHER 5 EXPLAIN runtime=slotted MATCH (n) RETURN n` is a syntax error at `runtime`, while `CYPHER runtime=slotted EXPLAIN MATCH (n) RETURN n`, `EXPLAIN CYPHER runtime=slotted MATCH (n) RETURN n` and `CYPHER 5 runtime=slotted EXPLAIN MATCH (n) RETURN n` each parse and classify as a read.
`r` runs.
`s` runs only when the statement calls an allowlisted procedure, because the policy has already refused every other procedure: `CALL dbms.components()` is classified `s` and runs.
Every other type, a plan with no type, and an `EXPLAIN` that failed refuse the statement, and nothing is run.
An allowed SHOW form skips the gate, because the server classifies the database forms `s`, a class that also holds administration; the policy has already restricted them to the forms of section 3.2.
The gate costs one round trip per statement, which the design accepted because the maintainer's first axis is security.

### 3.6 Machine access

Plan mode drafts Cypher and runs nothing: `getLabels().statementLanguage` tells the model what the policy enforces, "Read-only Cypher for Neo4j 5: one statement per run, no writes, no LOAD CSV, no APOC or GDS. CALL is limited to db.labels, db.relationshipTypes, db.propertyKeys, db.schema.visualization, db.schema.nodeTypeProperties, db.schema.relTypeProperties, db.ping and dbms.components. SHOW is limited to indexes, constraints, databases, procedures and functions. Only built-in functions can be called; parameters are not supported. Quote labels, relationship types and property names that are not plain words with backticks.", and a drafted statement meets the policy when the user runs it.
A plan run's fence tag is the type-id, `neo4j`, and a `cypher` block also names Neo4j, as `promql` names Prometheus, while Neo4j is the only engine here that runs Cypher; a second graph engine revisits that.
`list_connections` and `inspect_schema` work through the object surface and run no user Cypher, so a Neo4j seed may set `mcp: true`.
The provider implements no `queryReadOnly`, so agent execution and MCP `run_read_query` do not serve Neo4j: both need a non-SQL statement contract the agent and MCP guards do not have, and the boundary of section 3.4 has to be measured for that path on its own.
That work is filed as B93.

### 3.7 Measurements

The cancel, the READ-mode refusal and every capture of section 11 were measured against the compose server on 2026-10-03; section 11.3 records them.

## 4. Connection

### 4.1 Configuration fields

| Field | Meaning |
|---|---|
| Host | A name or address only: the provider builds the `bolt` URI from Host, Port and the SSL panel |
| Port | `7687` by default, Bolt's port; 7474 is Neo4j's HTTP port, which this provider never uses |
| User | The Neo4j user; its write privileges are never used, because the connection is read-only |
| Password | The user's password, sent in Bolt's basic authentication |
| Database | Leave empty to use the server's home database. |
| SSL / TLS | The mode and the CA (section 4.3) |
| SSH Tunnel | A bastion that forwards the one Bolt endpoint |
| Read-only | Accepted, and read-only either way: the provider refuses every write whatever the toggle says. The dialog says so under the toggle: "Neo4j connections are read-only in this version, whether or not this is ticked: this user's write privileges are never used." |

The Database row is the hint the connection dialog shows under that field, and the Read-only row quotes the sentence under the toggle.
There is no connection string: no `bolt://` or `neo4j://` URI is parsed, so a scheme typed into Host is refused rather than read.
A user name or password written into the host is refused with "Invalid host: a user name or password belongs in the connection's user and password fields, not in the host".
The host and port go through the shared validators of `src/lib/db/http/endpoint.ts`, and the built URI is parsed back and must name the same host and port.

### 4.2 Authentication

Studio signs in with Bolt's basic scheme, the User and the Password, or with no authentication when the User is empty.
A refused sign-in reads "Neo4j refused the sign-in:" with the server's words (section 10).
The provider never uses a write privilege the user holds, so a read-only Neo4j user is not needed for safety, though it is a sound second boundary on Enterprise, where roles exist.

### 4.3 TLS

| Panel | Scheme | Trust |
|---|---|---|
| No TLS panel, or `disable` | `bolt` | none, plaintext |
| `require` | `bolt+ssc` | any certificate: the chain and the name are not checked |
| `require` with `rejectUnauthorized: true` | `bolt+s` | the system CAs, and the host name |
| `verify-system`, or a panel with no mode | `bolt+s` | the system CAs, and the host name |
| `verify-ca` or `verify-full` with a pasted CA | `bolt+s` | the pasted CA instead of the system CAs, and the host name |
| `verify-ca` or `verify-full` with no CA | `bolt+s` | the system CAs, and the host name |

`verify-ca` also checks the host name, as `verify-full` does: the driver verifies the chain against the pasted CA and Node verifies the name, and the driver offers no mode that checks one without the other.
A pasted CA reaches the driver as a file, because `neo4j-driver-lite` 6.2.0 reads trusted certificates from paths: it is written once to `<os.tmpdir()>/libredb-neo4j-ca/<sha256 of the PEM>.pem` with mode 0600, in a directory of mode 0700 owned by the Studio process's user, and reused while its content matches.
A CA certificate is public material; the file mode keeps it from being replaced.
A client certificate is refused in every mode with "TLS client certificates are not supported for Neo4j in this version: remove the client certificate and key from the connection's TLS settings".
A self-signed certificate under a verifying mode is refused with a TLS error naming the certificate, never downgraded.

### 4.4 One database per connection

A connection reads one database: the Database field, or the user's home database, which `SHOW HOME DATABASE YIELD name` resolves at connect.
The tree shows that one database as its one container, and every object path is checked against it; another database is another connection.
`USE` is a denied word for the same reason.
Browsing several databases in one connection is filed as D143.

### 4.5 SSH tunnel

An SSH tunnel is supported, because a `bolt` URI dials the one server it names.
Certificate verification through a tunnel is not: the certificate would be checked against the tunnel's local `127.0.0.1`, so a verifying mode on a tunnelled connection is refused with "Certificate verification through an SSH tunnel is not supported for Neo4j in this version: the certificate would be checked against the tunnel's local address. Use TLS mode require with verification off, or connect without the tunnel".
`require` with verification off connects through a tunnel as `bolt+ssc`.
Verified TLS through a tunnel, with the driver's resolver measured, is filed as D142.

### 4.6 Server versions

Neo4j 5.26 LTS is tested and claimed: every capture and the integration test are 5.26.31 Community.
The calendar releases, 2025.x and 2026.x, are not refused and connect untested: constraint type names and `propertyTypes` strings differ there, and they are shown as returned, never parsed.
The overview's version reads `5.26.31 community` on the tested series, `2026.01.0 enterprise (untested)` outside it, and `unknown` when the read at connect failed.
Enterprise connects too; the monitoring differences are in section 7.

## 5. Query interface

### 5.1 One statement per run

The editor sends one Cypher statement, with an optional `CYPHER <n>` prefix; a trailing `;` is allowed.
To run one statement of several, select it, because the editor then sends the selection alone.

### 5.2 Result shape

Every value is converted on the server before it leaves the transport, so the response never meets a driver class, a `BigInt` or a typed array:

| Bolt value | JSON form |
|---|---|
| INTEGER | a number within the safe integer range, otherwise its exact decimal string |
| FLOAT | the number; `NaN`, `Infinity` and `-Infinity` as those strings |
| DATE, TIME, LOCAL TIME, DATETIME, LOCAL DATETIME, DURATION | the ISO-8601 text with nanoseconds and zone |
| POINT | `{ "srid": <number>, "x": ..., "y": ..., "z"?: ... }` |
| BYTE ARRAY | an array of unsigned byte numbers |
| LIST, MAP | converted recursively |
| NODE | `{ "~graph": "node", "elementId": ..., "labels": [...], "properties": {...} }` |
| RELATIONSHIP | `{ "~graph": "relationship", "elementId": ..., "type": ..., "startNodeElementId": ..., "endNodeElementId": ..., "properties": {...} }` |
| PATH | `{ "~graph": "path", "nodes": [...], "relationships": [...] }`, a zero-length path as its one node and no relationship |
| VECTOR, UUID, a type the driver adds later | its text |

The deprecated numeric `identity` is never emitted, and `elementId` is stable only within one transaction: do not keep one to find the same node later.
`columnTypes` names `Node`, `Relationship` or `Path` for a column whose every non-null value has that form, `Mixed` when graph forms mix or meet other values, and nothing for a scalar column; the grid shows it in the header.
The `"~graph"` tag is how the Graph tab finds graph values in any result without a provider change (section 5.6).

### 5.3 Bounds

| Bound | Value | What it bounds |
|---|---|---|
| `DEFAULT_QUERY_LIMIT` | 500 | The rows of one result; the driver fetches one more, and on that record the session is closed and the result marked limited |
| `MAX_CELL_JSON_BYTES` | 1,048,576 | One cell's converted JSON in bytes; a larger value becomes `"<value too large: N bytes>"` and a warning names the column |
| `MAX_CELL_DEPTH` | 32 | How deep one cell's lists and maps nest; a deeper value is replaced the same way |
| `CATALOG_ROW_BOUND` | 10,000 | The rows of one catalog read; a cut listing is counted as a floor and a cut detail is refused, while the tree shows a cut listing's rows with no marker, since its object type has none, and the server log records the cut |
| `CATALOG_CACHE_MS` | 60,000 | How long the property and index reads are kept, in milliseconds (section 6.1) |
| `CATALOG_TIMEOUT_MS` | 30,000 | The Bolt transaction timeout of one catalog read |
| `MONITORING_TIMEOUT_MS` | 30,000 | The Bolt transaction timeout of one monitoring read |
| `TABLE_STATS_LABEL_BOUND` | 50 | The labels the Tables tab counts, the first by name |
| `GRAPH_SAMPLE_LIMIT` | 100 | The `LIMIT` of a tree click's sample read |

A statement's time is the connection's query timeout, sent as the Bolt transaction timeout, which the server enforces, and kept by the client as its own timer one second later.

### 5.4 Cancellation and the confirmation gate

Cancelling a statement aborts its run, the client closes the session, and Neo4j ends the transaction; the result reports a cancel, never a driver fault.
The design's research measured that `session.close()` returns in 1 to 3 ms and the transaction leaves `SHOW TRANSACTIONS` within 1.5 s.
Through the Bolt client as the query route sends it, an abort of a long `UNWIND` rejected the run 1.9 ms later, and the transaction left `SHOW TRANSACTIONS` 5 ms after the abort (section 11.3).
The confirmation gate asks nothing: the destructive vocabulary row for `neo4j` declares no operation and decides alone, because the provider refuses every write before sending, and the gate never reads Cypher as SQL.

### 5.5 EXPLAIN and PROFILE

`supportsExplain` is false and a typed `EXPLAIN` or `PROFILE` is refused, because the product has no plan view for Cypher and `PROFILE` runs the statement.

### 5.6 The Graph tab

A result that holds a node, a relationship or a path in any cell, at any depth inside lists and maps, offers a Graph tab beside Results; the default view stays Results.
The tab is offered by the result's shape and not by the engine, so any provider that emits the `"~graph"` forms gets it; the model is `src/lib/db/graph/result-graph.ts` and the view is `src/components/results-graph/`.
It draws only what the statement returned and runs no statement of its own, so the read policy's surface is unchanged.
Nodes and relationships are taken from every cell, paths included, and each is drawn once per result, by `elementId`.
A cell cut to `"<value too large: N bytes>"` (section 5.3) is text, so it draws nothing.
The tab draws the first 300 distinct nodes in row order, and when a result holds more it says so: "Showing 300 of 412 nodes. The graph draws at most 300 nodes; the Results tab holds every row."
A relationship is drawn only when both its endpoints are drawn, and the ones left out are counted: "2 relationships are not drawn because an endpoint is not among the drawn nodes."
Each label gets a colour of the chart palette in order of first appearance, cycling when labels outnumber colours, and a node takes its first label's.
A node's caption is the first present property among `name`, `title` and `label`, then a key ending in `name`, then `description`, then `id`, then the first string property that is not a non-finite float (`NaN`, `Infinity`, `-Infinity`), else the first label, else the `elementId`, compared without case and cut to at most 24 characters with an ellipsis.
A relationship's caption is its type, and an arrow shows its direction.
The legend lists the labels with their colour and count, and the relationship types with their count.
The legend and the inspector share one column, a scroll region named "Graph legend and details" that takes focus by Tab, so the arrow keys scroll it.
A click on a node or a relationship opens the inspector beside the canvas, under it on a narrow screen, with its labels or type, its `elementId` and every property; Escape clears the selection.
The layout is fcose, rerun by Re-layout; a fit never zooms in past 1, so a small graph is drawn at its own size and not blown up, while Zoom in and `+` go up to 3; a dragged node stays where it is dropped, and the toolbar holds Fit the graph, Zoom in, Zoom out, Re-layout, Export PNG and Export JSON.
The canvas takes focus and is named "Graph of N nodes and M relationships"; there `+` and `-` zoom, `0` fits and the arrow keys pan.
Export PNG draws the whole graph on the theme's background, and Export JSON writes `{ "nodes": [...], "relationships": [...] }` of the drawn elements in their tagged forms.
Masking follows the grid's rule: when the grid would mask, a property whose key the masking config flags is masked in the captions, the inspector and both exports.
A node or relationship found under a column the grid masks by name has every property masked with that column's pattern, as the grid masks the whole cell; its labels, type and elementId stay.

## 6. Schema introspection

### 6.1 The object surface (#789)

| Kind | Role | Folder | Columns | Listing |
|---|---|---|---|---|
| `label` | relation | Node labels | properties | `CALL db.labels() YIELD label RETURN label ORDER BY label` |
| `relationship_type` | relation | Relationship types | properties | `CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType` |
| `index` | config | Indexes | none | `SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, owningConstraint`, the default `LOOKUP` indexes left out |
| `constraint` | config | Constraints | none | `SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties` |

The one container is the database, resolved at connect with `SHOW HOME DATABASE YIELD name` when the connection names none.
An object's path is `[database, segment]`, with a segment that names its kind: a label `(:Name)`, a relationship type `[:NAME]`, an index `INDEX name` and a constraint `CONSTRAINT name`, so a label and a relationship type of one name never collide; the object's name stays the plain name.
A count is the listing's length, and a listing the server refuses answers that kind's refusal sentence instead of a count.
A label's or a relationship type's columns come from `CALL db.schema.nodeTypeProperties() YIELD nodeLabels, propertyName, propertyTypes, mandatory` and `CALL db.schema.relTypeProperties() YIELD relType, propertyName, propertyTypes, mandatory`: the property name, the `propertyTypes` text as returned, and `nullable` false only when every row naming that owner and property says `mandatory`.
A label with no property has no columns.
Its indexes are the index rows whose entity type and labels or types name it.
The property and index reads answer every object at once, so they are shared by concurrent callers and kept for 60 seconds, then read again: a schema change shows in the tree within a minute, and listing the container drops the cache at once.
A tree click on a label writes `` MATCH (n:`Label`) RETURN n LIMIT 100 ``, and on a relationship type `` MATCH (a)-[r:`TYPE`]->(b) RETURN a, r, b LIMIT 100 ``, with every name backticked and every backtick doubled, so a name with a space, a backtick or non-ASCII letters reads back as itself; an index and a constraint have no click action.
The schema diagram is not offered on a `queryLanguage: "cypher"` connection (`offersSchemaDiagram` in `src/lib/db/types.ts`): relationship types are not tables, and the diagram's `_id` heuristic would invent edges.

### 6.2 Object source (#789)

No kind has a source, so the provider writes no `readObjectSource`, and the type-id is on the abstainer list of `tests/isolated/object-source-declarations.test.ts`.

### 6.3 Object edit (#789): nothing to write

No kind declares `acceptsSourceEdits` or `acceptsRowWrites`: there is no source edit, no grid edit, no Create Table and no Import Data target for Neo4j, because every connection is read-only in this version.
`tests/isolated/object-edit-declarations.test.ts` holds that absence and this section together, over every kind the provider declares.

## 7. Monitoring & health

| Surface | Read | On Community 5.26 |
|---|---|---|
| Health | the driver's connectivity check, then `CALL db.ping()` | yes |
| Overview | `CALL dbms.components() YIELD name, versions, edition` at connect, `MATCH (n) RETURN count(n) AS nodes`, `MATCH ()-[r]->() RETURN count(r) AS relationships`, and the label, relationship-type and index listings of section 6.1 | yes |
| Active sessions | `SHOW TRANSACTIONS YIELD database, transactionId, username, currentQuery, startTime, status, elapsedTime` | the user's own transactions; on Enterprise every transaction, with the privilege to see them |
| Slow queries | none | the query log is Enterprise only, and this version does not read it |
| Performance metrics | none | the metrics endpoint is Enterprise only |
| Table stats | the label listing, then `MATCH (n:<label>) RETURN count(n) AS c` for each of the first 50 labels by name, one at a time, from the count store | yes |
| Index stats | `SHOW INDEXES YIELD name, type, entityType, labelsOrTypes, properties, state, readCount, lastRead, populationPercent`, the `LOOKUP` indexes left out | yes |
| Storage stats | none | Bolt reports no store size |

The transactions read names its columns, never the `parameters` column, which can hold a secret, and never `YIELD *`.
Each `elapsedTime` is read as an ISO 8601 duration of days and time, a sign allowed on each component, and a negative total is shown as 0 ms (#1416): Neo4j 2026.09.0 reported a just-started transaction as `PT-0.001000000S` on about one Sessions load in three, and refusing that value dropped the whole panel. Any other text in that column still refuses the panel, naming the column.
Each label in a count statement is backticked by the quoting module and checked by the read policy before it runs; a label the quoting refuses is left out, and the server log names every label left out, since the table stats have no field to say so.
The monitoring reads run through the same READ session path without the user's policy, and a unit test checks every one against the policy: every monitoring read but the transactions read passes it.
The transactions read stays out of the user allowlist (section 3.2), since a user's `SHOW TRANSACTIONS YIELD *` returns other sessions' query text and parameters, and the monitoring read keeps a fixed column list that names no `parameters` column.
A read the server refuses yields that panel's empty answer, never a throw, while an unreachable server, a timeout or a cancel is raised; a refused overview figure is shown as unreadable and leaves the others standing.
The Slow queries panel says "Neo4j Community keeps no query log, and this version does not read the Enterprise query log." and the Active sessions panel with nothing running says "No transaction is running."
Health answers healthy after the connectivity check and the ping, or raises; Bolt reports no cache ratio, size or uptime, so those read "N/A".

## 8. Maintenance

None: `supportsMaintenance` is false, no operation is declared, and a maintenance call that arrives anyway is refused with "Neo4j connections are read-only in this version: no maintenance operation runs."
`TERMINATE TRANSACTIONS` is a denied word, so a transaction is never ended from Studio.

## 9. Capabilities & labels

`queryLanguage: "cypher"` with no `queryDialect`, `defaultPort: 7687`, `enforcesReadOnly: true`, `supportsMaintenance: false`, `statementTerminator: "none"`, one container level (`Database`), the four kinds of section 6.1, `schemaRefreshPattern: "(?!)"`, which no statement matches, and `false` for explain, external query limiting, table creation, inline row edits, result pagination, transactions, connection strings, foreign keys and derived groupings.
Each object of the tree is a "graph object", the noun plan mode counts the whole inventory under, and a label's rows are each a "node"; its read is "Match Nodes" and its generator "Generate Cypher".
The editor's Cypher language is the shared lexer as a Monaco tokens provider, with completion of the schema's labels and relationship types, the allowlisted procedures after `CALL` and the allowed forms after `SHOW`; there is no Cypher formatter, so the SQL Format action does not apply to a Cypher tab.

## 10. Error handling

The Bolt client classifies every failure by the server's status code where there is one, and `errors.ts` turns each class into the repository's error class:

| Category | Error class | The message |
|---|---|---|
| `auth` | `AuthenticationError` | Neo4j refused the sign-in: <the server's words> |
| `connection` | `ConnectionError` | Neo4j could not be reached: <the server's words> |
| `tls` | `ConnectionError` | The TLS connection to Neo4j failed: <the server's words> |
| `timeout` | `TimeoutError` | The query did not finish in time: <the server's words> |
| `cancelled` | `QueryCancelledError` | The query was cancelled. |
| `access-mode` | `QueryError` | The server refused a write: Neo4j connections are read-only in this version. |
| `syntax` | `QueryError` | <the server's words> |
| `query` | `QueryError` | <the server's words> |

The server's status code, such as `Neo.ClientError.Statement.SyntaxError`, travels as the error's detail.
A write that reached the server is reported as refused, never as a driver fault.
The password never reaches an error, and no statement text reaches the server's log through the driver, since no logger is configured.

## 11. Testing

### 11.1 How the tests work

The unit tests drive each graph-layer module and each Neo4j module through fakes injected by constructor or parameter, with no module mock.
`tests/integration/db/neo4j-provider.test.ts` drives the real provider over `recordedGraphClient` (`tests/helpers/neo4j-fixtures.ts`), which answers a run from the capture of the exact database and statement text and fails on any other, so a catalog, gate or monitoring statement that changes without a new capture goes red.
`tests/integration/db/neo4j-bolt-composed.test.ts` runs the real provider over the real `bolt-client.ts` with a fake driver serving real driver value classes, covering the row-bound cut, an error during iteration and the summary path.
The read policy is tested over a shared corpus of Cypher texts, `tests/fixtures/graph/cypher-corpus.ts`, which the lexer and the editor's tests read too.

### 11.2 Run it

```bash
bun tests/run-tests.ts tests/integration/db/neo4j-provider.test.ts
bun tests/run-tests.ts tests/integration/db/neo4j-bolt-composed.test.ts
bun run test
```

### 11.3 The live fixture

`database-compose.yml` holds `neo4j`: Bolt on 127.0.0.1:7687, user `neo4j`, password `password123`, no TLS, on the image `neo4j:5.26.31-community` pinned by the digest `sha256:d9cfe82983d27f5a75b3aaae8f316d04f9a698a3b7f6103a508f7caf8362f255`.
[`docker/neo4j/README.md`](../../docker/neo4j/README.md) says how to start it and load `docker/neo4j/seed.cypher`, a graph written for this repository of 30 nodes and 40 relationships, with a label holding a space, one holding a backtick, a label sharing its name with a relationship type, a label with no property, and a node holding every value type.
`tests/live/neo4j-evidence.ts` runs by hand against it and writes the captures of `tests/fixtures/neo4j/5.26.31/`, whose README records the provenance and the two measurements no capture holds: the server refused `CREATE (n)` in a READ session with `Neo.ClientError.Statement.AccessMode: Writing in read access mode not allowed. Attempted write to neo4j`, and an abort of the Bolt client's run of `UNWIND range(1, 2000000000) AS x RETURN count(x)` rejected the run 1.9 ms later, the transaction leaving `SHOW TRANSACTIONS` 5 ms after the abort.
The harness reads the node and relationship counts and the index and constraint names before and after its run, and fails when they differ.

## 12. Usage examples

### 12.1 A read-only seed

```yaml
version: "1"
connections:
  - id: "graph"
    name: "Graph"
    type: neo4j
    host: neo4j.internal
    port: 7687
    database: neo4j
    user: "reader"
    password: "${NEO4J_READER_PASSWORD}"
    ssl:
      mode: verify-full
      caCert: "${NEO4J_CA}"
    roles: ["*"]
    managed: true
    readOnly: true
    mcp: true
```

The same recipe, with what each field does, is in [SEED_CONNECTIONS.md](../SEED_CONNECTIONS.md#a-read-only-neo4j-graph).

### 12.2 Reads that run

```cypher
MATCH (p:Person)-[m:MEMBER_OF]->(t:Team) RETURN p.name, m.role, t.name LIMIT 25
MATCH path = (s:Service {id: 'checkout'})-[:DEPENDS_ON*1..3]->(d) RETURN path
CALL db.schema.nodeTypeProperties()
SHOW INDEXES YIELD name, state WHERE state = 'ONLINE'
MATCH (n) RETURN n.`set`
```

Each line is one run.

## 13. Known limitations and risks

- The policy is a word scan, not a parser, so it refuses some valid reads: a property named `set` must be backticked, and the refusal says how.
- `EXPLAIN` adds a round trip to every statement, and the gate stays whatever it costs.
- READ mode on 5.26 is measured, not documented as a guarantee, so it is the third layer and never the only one.
- `db.schema.nodeTypeProperties()` scans data on a large graph, measured at 708 ms at 2 million nodes in the design's research; it runs when a label is described, the cache keeps its answer for up to a minute per database, and a tree refresh or a reconnect drops the cache, so the next describe reads it again; the inventory a plan run reads when it starts reads it once.
- 2025.x and 2026.x servers connect untested, and their constraint type names and `propertyTypes` strings are shown as returned.
- The graph layer is designed from one shipped engine and one probe, Memgraph 3.13.1, which showed that READ mode, cancellation and the catalog differ there; a second engine adds what it needs in its own PR, and the Memgraph provider is filed as D141.
- The Graph tab draws only the result: it does not connect result nodes the statement left unlinked (U75) or expand a node's neighbours (U76), keeps no style a user sets (U77) and offers one layout (U78).
- No APOC, GDS or custom procedure, and no `LOAD CSV`: a measured APOC subset is filed as D140.
- No agent execution and no MCP `run_read_query`, filed as B93.
- One database per connection, filed as D143.
- No verified TLS through an SSH tunnel, filed as D142.
- No client certificate, no routing `neo4j://` URI, no cluster routing and no Aura in this version.
- The UI shows the plain name "Neo4j" and a generic graph icon, never Neo4j's logo.

## 14. References

- The design, decided with the maintainer on 2026-10-03, and its research on the driver, Cypher, the editions and Memgraph.
- Neo4j's [Cypher manual for Neo4j 5](https://neo4j.com/docs/cypher-manual/5/) and the `neo4j-driver-lite` 6.2.0 [JavaScript driver API](https://neo4j.com/docs/api/javascript-driver/6.2/), for 5.26 LTS.
- [`docker/neo4j/README.md`](../../docker/neo4j/README.md) and [`tests/fixtures/neo4j/5.26.31/README.md`](../../tests/fixtures/neo4j/5.26.31/README.md).

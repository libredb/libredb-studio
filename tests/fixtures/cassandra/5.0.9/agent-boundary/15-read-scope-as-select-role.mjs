// What a role holding only SELECT on its own keyspace may read outside it. The image's superuser makes a keyspace,
// a second keyspace with one row, and the role, then sends one traced statement on the second keyspace. The role then
// reads every table the server lists in its own keyspaces and the two made here (system_schema.tables and
// system_virtual_schema.tables), each by its quoted name
// with LIMIT 1, and the answer is printed: the rows it read, or the error's code with the role's name and the resource
// left as written. Last, the role reads the trace of the superuser's statement, to show what such a row holds.
// Makes and drops its own keyspaces and role.
// Usage: node 15-read-scope-as-select-role.mjs <host:port>
// oxlint-disable no-await-in-loop -- each read runs after the one before, on purpose: the capture records them in order.
import { Client } from "cassandra-driver";

const contact = process.argv[2];
const client = (username, password, keyspace) =>
  new Client({
    contactPoints: [contact],
    localDataCenter: "datacenter1",
    credentials: { username, password },
    ...(keyspace ? { keyspace } : {}),
  });
const admin = client("cassandra", "cassandra");
await admin.connect();
for (const cql of [
  "DROP KEYSPACE IF EXISTS scope15",
  "DROP KEYSPACE IF EXISTS scope15_other",
  "DROP ROLE IF EXISTS scope15_agent",
  "CREATE KEYSPACE scope15 WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
  "CREATE KEYSPACE scope15_other WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
  "CREATE TABLE scope15.t (id int PRIMARY KEY, v text)",
  "CREATE TABLE scope15_other.t (id int PRIMARY KEY, v text)",
  "INSERT INTO scope15_other.t (id, v) VALUES (1, 'a value of another keyspace')",
  "CREATE ROLE scope15_agent WITH LOGIN = true AND PASSWORD = 'not-a-real-password'",
  "GRANT SELECT ON KEYSPACE scope15 TO scope15_agent",
]) {
  await admin.execute(cql);
}
const traced = await admin.execute("SELECT v FROM scope15_other.t WHERE id = 1", [], { traceQuery: true });
// The trace is written after the answer; wait for it to land.
await new Promise((resolve) => setTimeout(resolve, 2000));
const tables = [];
for (const catalog of ["system_schema.tables", "system_virtual_schema.tables"]) {
  for (const row of (await admin.execute(`SELECT keyspace_name, table_name FROM ${catalog}`)).rows) {
    if (!/^(system|scope15)/.test(row.keyspace_name)) continue;
    tables.push(`${row.keyspace_name}.${row.table_name}`);
  }
}
tables.sort();
const agent = client("scope15_agent", "not-a-real-password", "scope15");
await agent.connect();
console.log("== as scope15_agent, holding only SELECT on scope15: one read of every table the server lists");
for (const table of tables) {
  const [keyspace, name] = table.split(".");
  try {
    const rs = await agent.execute(`SELECT * FROM "${keyspace}"."${name}" LIMIT 1`, [], { prepare: false });
    console.log(`${table}: ok, ${rs.rows.length} rows`);
  } catch (error) {
    console.log(`${table}: error code=${error.code ?? "none"}: ${error.message}`);
  }
}
console.log("== as scope15_agent: the trace of the superuser's statement on scope15_other");
const session = await agent.execute(
  `SELECT command, request, parameters FROM system_traces.sessions WHERE session_id = ${traced.info.traceId}`,
  [],
  { prepare: false },
);
for (const row of session.rows) {
  console.log(`  command=${row.command} request=${row.request} query=${JSON.stringify(row.parameters?.query)}`);
}
const events = await agent.execute(
  `SELECT activity FROM system_traces.events WHERE session_id = ${traced.info.traceId} LIMIT 1`,
  [],
  { prepare: false },
);
for (const row of events.rows) console.log(`  activity=${JSON.stringify(row.activity)}`);
await agent.shutdown();
for (const cql of ["DROP KEYSPACE scope15", "DROP KEYSPACE scope15_other", "DROP ROLE scope15_agent"]) {
  await admin.execute(cql);
}
await admin.shutdown();

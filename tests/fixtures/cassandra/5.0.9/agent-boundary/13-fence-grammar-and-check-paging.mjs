// Two facts the agent path rests on, measured as the image's superuser on its own keyspace and roles, which it drops
// again. First, how the server reads the text the statement fence reads: a tagged dollar run, a second statement after
// a semicolon, a doubled semicolon, and comments of all three forms around a lowercase SELECT, one holding a semicolon.
// Second, whether the three listings the check reads come back in pages: each is asked with a fetch size of 1 against a
// role that has three of each, and the answer's page state is printed. Usage: node 13-fence-grammar-and-check-paging.mjs <host:port>
// oxlint-disable no-await-in-loop -- each statement runs after the one before, on purpose: the capture records what the server holds then.
import { Client } from "cassandra-driver";

const admin = new Client({
  contactPoints: [process.argv[2]],
  localDataCenter: "datacenter1",
  credentials: { username: "cassandra", password: "cassandra" },
});
await admin.connect();
const answer = async (cql, options = {}) => {
  try {
    const rs = await admin.execute(cql, [], { prepare: false, ...options });
    const rows = rs.rows?.length ?? 0;
    return `ok, ${rows} rows, page state ${rs.pageState ? "present" : "absent"}`;
  } catch (error) {
    return `error ${error.name} code=${error.code ?? "none"}: ${error.message}`;
  }
};
const say = async (cql, options) =>
  console.log(
    `> ${JSON.stringify(cql)}${options ? ` ${JSON.stringify(options)}` : ""}\n  ${await answer(cql, options)}`,
  );

await admin.execute("DROP KEYSPACE IF EXISTS fence13");
for (const role of ["fence13_agent", "fence13_a", "fence13_b", "fence13_c"])
  await admin.execute(`DROP ROLE IF EXISTS ${role}`);
await admin.execute("CREATE KEYSPACE fence13 WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}");
await admin.execute(
  "CREATE TABLE fence13.t (id int PRIMARY KEY, a text MASKED WITH mask_default(), b text MASKED WITH mask_default(), c text MASKED WITH mask_default())",
);
await admin.execute("INSERT INTO fence13.t (id, a, b, c) VALUES (1, 'x', 'y', 'z')");
await admin.execute("CREATE ROLE fence13_agent WITH LOGIN = true AND PASSWORD = 'not-a-real-password'");
for (const role of ["fence13_a", "fence13_b", "fence13_c"]) {
  await admin.execute(`CREATE ROLE ${role}`);
  await admin.execute(`GRANT SELECT ON KEYSPACE fence13 TO ${role}`);
  await admin.execute(`GRANT ${role} TO fence13_agent`);
}
await admin.execute("GRANT SELECT ON TABLE fence13.t TO fence13_agent");

console.log("== the text the fence reads");
await say("SELECT $t$x$t$ FROM system.local");
await say("SELECT $$x; y$$ FROM system.local WHERE key = 'local'");
await say("SELECT release_version FROM system.local; SELECT key FROM system.local");
await say("SELECT release_version FROM system.local;;");
await say("/* a; */ -- b\n// c\nselect release_version from system.local ; -- d\n");
console.log("== whether the check's reads come back in pages, at a fetch size of 1");
await say("LIST ROLES OF 'fence13_agent'", { fetchSize: 1 });
await say("LIST ALL PERMISSIONS OF 'fence13_agent'", { fetchSize: 1 });
await say(
  "SELECT keyspace_name, table_name, column_name, function_keyspace, function_name FROM system_schema.column_masks WHERE keyspace_name = 'fence13'",
  { fetchSize: 1 },
);

await admin.execute("DROP KEYSPACE fence13");
for (const role of ["fence13_agent", "fence13_a", "fence13_b", "fence13_c"]) await admin.execute(`DROP ROLE ${role}`);
await admin.shutdown();

// Runs each statement of a .cql file (one statement per line; blank lines and lines starting with -- are skipped)
// as one role through cassandra-driver, and prints each statement beside the server's answer: the rows, or the
// error's class, protocol code and message. Usage: node probe.mjs <host:port> <role> <password> <file.cql> [keyspace]
// oxlint-disable no-await-in-loop -- each statement runs after the one before, on purpose: the captures record what the server holds then.
import { readFileSync } from "node:fs";
import { Client } from "cassandra-driver";

const [contact, role, password, file, keyspace] = process.argv.slice(2);
const client = new Client({
  contactPoints: [contact],
  localDataCenter: "datacenter1",
  credentials: { username: role, password },
  ...(keyspace ? { keyspace } : {}),
});
const show = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && value.constructor?.name !== "Object"
    ? String(value)
    : value;
try {
  await client.connect();
} catch (error) {
  const inner = Object.values(error.innerErrors ?? {})[0];
  console.log(
    `connect as ${role}: ${error.name} ${inner?.name ?? ""} ${inner?.code ?? error.code ?? ""} ${inner?.message ?? error.message}`,
  );
  process.exit(0);
}
for (const line of readFileSync(file, "utf8").split("\n")) {
  const cql = line.trim();
  if (cql === "" || cql.startsWith("--")) continue;
  console.log(`> ${cql}`);
  try {
    const rs = await client.execute(cql, [], { prepare: false });
    if (rs.columns === null || rs.columns === undefined) {
      console.log("ok, no result columns");
    } else {
      console.log(`ok, ${rs.rows.length} rows${rs.pageState ? " and a page state" : ""}`);
      for (const row of rs.rows) {
        console.log("  " + JSON.stringify(Object.fromEntries(rs.columns.map((c) => [c.name, show(row[c.name])]))));
      }
    }
  } catch (error) {
    console.log(`error ${error.name} code=${error.code ?? "none"}: ${error.message}`);
  }
  console.log(`  (session keyspace: ${client.keyspace ?? "none"})`);
}
await client.shutdown();

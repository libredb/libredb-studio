// What the agent role's own listing and the server's enforcement say in the moments after an administrator grants and
// then revokes MODIFY: the listing reads the role tables, the enforcement reads a cache that `permissions_validity`
// (2000ms in the image's cassandra.yaml) bounds. Usage: node 05-permission-cache-window.mjs <host:port>
// oxlint-disable no-await-in-loop -- each statement runs after the one before, on purpose: the captures record what the server holds then.
import { Client } from "cassandra-driver";

const contact = process.argv[2];
const open = (username) =>
  new Client({
    contactPoints: [contact],
    localDataCenter: "datacenter1",
    credentials: { username, password: username === "cassandra" ? "cassandra" : "not-a-real-password" },
  });
const admin = open("cassandra");
const agent = open("agent_cache");
await admin.connect();
await admin.execute("DROP ROLE IF EXISTS agent_cache");
await admin.execute("CREATE ROLE agent_cache WITH LOGIN = true AND PASSWORD = 'not-a-real-password'");
await admin.execute("GRANT SELECT ON KEYSPACE probe TO agent_cache");
await agent.connect();
const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(5)}ms`;
const listing = async () =>
  (await agent.execute("LIST ALL PERMISSIONS OF agent_cache")).rows
    .map((row) => `${row.permission} ${row.resource}`)
    .join(", ");
const write = async (id) => {
  try {
    await agent.execute(`INSERT INTO probe.orders (id, customer_id, amount) VALUES (${id}, 0, 0)`);
    return "INSERT accepted";
  } catch (error) {
    return `INSERT refused code=${error.code}`;
  }
};
// Warm the cache with the SELECT-only answer.
console.log(`${at()} before grant: listing [${await listing()}], ${await write(900)}`);
await admin.execute("GRANT MODIFY ON KEYSPACE probe TO agent_cache");
console.log(`${at()} granted MODIFY`);
for (let i = 0; i < 4; i++) {
  console.log(`${at()} listing [${await listing()}], ${await write(901 + i)}`);
  await new Promise((resolve) => setTimeout(resolve, 900));
}
await admin.execute("REVOKE MODIFY ON KEYSPACE probe FROM agent_cache");
console.log(`${at()} revoked MODIFY`);
for (let i = 0; i < 5; i++) {
  console.log(`${at()} listing [${await listing()}], ${await write(911 + i)}`);
  await new Promise((resolve) => setTimeout(resolve, 900));
}
await admin.execute("DELETE FROM probe.orders WHERE id IN (900, 901, 902, 903, 904, 911, 912, 913, 914, 915)");
await admin.execute("DROP ROLE agent_cache");
await agent.shutdown();
await admin.shutdown();

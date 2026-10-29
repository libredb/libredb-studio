// Where the server ends a `--` or `//` comment: at a line feed only, or at a lone carriage return too. Each text is
// sent as the image's superuser, then as a role that holds only SELECT on its own keyspace, and the server's answer is
// printed: a `WHERE` the comment would hide filters the row out only when the carriage return ends the comment, and a
// statement after the carriage return runs only then. The last texts are ones a reader that runs the comment on to the
// line feed reads as a SELECT: the server runs an ALTER ROLE instead, and the role's password change is read back by
// signing in with each password. Makes and drops its own keyspace and role.
// Usage: node 14-line-comment-carriage-return.mjs <host:port>
// oxlint-disable no-await-in-loop -- each statement runs after the one before, on purpose: the capture records what the server holds then.
import { Client } from "cassandra-driver";

const contact = process.argv[2];
const client = (username, password) =>
  new Client({ contactPoints: [contact], localDataCenter: "datacenter1", credentials: { username, password } });
const admin = client("cassandra", "cassandra");
await admin.connect();
const answer = async (session, cql) => {
  try {
    const rs = await session.execute(cql, [], { prepare: false });
    return rs.columns ? `ok, ${rs.rows.length} rows` : "ok, no result columns";
  } catch (error) {
    return `error ${error.name} code=${error.code ?? "none"}: ${error.message}`;
  }
};
const say = async (session, cql) => console.log(`> ${JSON.stringify(cql)}\n  ${await answer(session, cql)}`);

await admin.execute("DROP KEYSPACE IF EXISTS fence14");
await admin.execute("DROP ROLE IF EXISTS fence14_agent");
await admin.execute("CREATE KEYSPACE fence14 WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}");
await admin.execute("CREATE TABLE fence14.t (id int PRIMARY KEY, name text)");
await admin.execute("INSERT INTO fence14.t (id, name) VALUES (1, 'kept')");
await admin.execute("CREATE ROLE fence14_agent WITH LOGIN = true AND PASSWORD = 'not-a-real-password'");
await admin.execute("GRANT SELECT ON KEYSPACE fence14 TO fence14_agent");

console.log("== as cassandra: does a lone carriage return end a line comment?");
await say(admin, "SELECT id FROM fence14.t -- x\nWHERE id = 2");
await say(admin, "SELECT id FROM fence14.t -- x\rWHERE id = 2");
await say(admin, "SELECT id FROM fence14.t // x\rWHERE id = 2");
await say(admin, "SELECT id FROM fence14.t -- x\r\nWHERE id = 2");
await say(admin, "-- x\rSELECT id FROM fence14.t");
await say(admin, "// x\rSELECT id FROM fence14.t");
await say(admin, "SELECT id FROM fence14.t -- x\r");
await say(admin, "/* x\r */ SELECT id FROM fence14.t");
await say(admin, "SELECT id FROM fence14.t -- x");

// 5.0.9 lets a role change its password once per 5000ms from its creation on (code 4097).
await new Promise((resolve) => setTimeout(resolve, 6000));
const agent = client("fence14_agent", "not-a-real-password");
await agent.connect();
console.log("== as fence14_agent, holding only SELECT on fence14: a statement after the carriage return");
await say(agent, "SELECT * FROM fence14.t -- x\rALTER ROLE fence14_agent WITH PASSWORD = 'changed-by-a-comment'");
await say(agent, "SELECT * FROM fence14.t // x\rALTER ROLE fence14_agent WITH PASSWORD = 'changed-by-a-comment'");
// To a reader that ends the comment at the line feed only, this is a comment and then one SELECT whose string holds
// `-- `; the server reads the comment as `-- x` and sets the password to the text between the quotes. The last line
// feed ends the server's ` -- '` comment, which its lexer needs: a line comment at the end of the text with no line end
// after it is a syntax error there (the control just below).
await say(agent, "-- x\rALTER ROLE fence14_agent WITH PASSWORD = '\nSELECT id FROM fence14.t WHERE name = ' -- '\n");
await agent.shutdown();
await new Promise((resolve) => setTimeout(resolve, 6000));
const changed = client("fence14_agent", "\nSELECT id FROM fence14.t WHERE name = ");
await changed.connect();
await say(changed, "-- x\rALTER ROLE fence14_agent WITH PASSWORD = 'changed-by-a-comment'");
await changed.shutdown();
// The server reads a sign-in from its credentials cache for credentials_validity (2000ms by default), so wait it out.
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log("== which password signs in afterwards");
for (const [label, password] of [
  ["the role's first password", "not-a-real-password"],
  ["the literal the first text sets", "\nSELECT id FROM fence14.t WHERE name = "],
  ["the literal the second text sets", "changed-by-a-comment"],
]) {
  const probe = client("fence14_agent", password);
  try {
    await probe.connect();
    console.log(`  ${label}: signs in`);
  } catch (error) {
    console.log(`  ${label}: refused (${Object.values(error.innerErrors ?? {})[0]?.name ?? error.name})`);
  }
  await probe.shutdown();
}

await admin.execute("DROP KEYSPACE fence14");
await admin.execute("DROP ROLE fence14_agent");
await admin.shutdown();

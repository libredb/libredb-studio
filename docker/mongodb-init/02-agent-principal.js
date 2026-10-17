// The agent's own principal for the MongoDB read-only execution profile (issue #1614).
//
// The `mongo` image runs every .js in /docker-entrypoint-initdb.d through mongosh, once,
// on a FRESH data directory only, so an already-initialized container has to be recreated
// before an edit here takes effect - the same rule 01-object-fixture.js states.
//
// The user holds exactly the `read` role, on exactly the `app` database, and nothing else.
// That is the shape the profile admits at open: it reads this user's privileges, which must
// all be reads of the database the connection is bound to, and asks the server to refuse a
// delete that matches nothing, which changes nothing on any outcome. The server's refusal
// (code 13) is the proof that it enforces the role; a server started without `--auth`
// enforces nothing (measured on 9.0.4: a user holding only `read` wrote with `insertOne`),
// and accepts the delete, so the profile refuses it.
//
// The `app` database's own documents come from 01-object-fixture.js; the principal adds no
// data, because a write through this account is the one thing the profile must not do.

db.getSiblingDB("app").createUser({
  user: "libredb_agent",
  pwd: "libredb_agent",
  roles: [{ role: "read", db: "app" }],
});

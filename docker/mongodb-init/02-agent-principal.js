// The agent's own principal for the MongoDB read-only execution profile (issue #1614).
//
// The `mongo` image runs every .js in /docker-entrypoint-initdb.d through mongosh, once,
// on a FRESH data directory only, so an already-initialized container has to be recreated
// before an edit here takes effect - the same rule 01-object-fixture.js states.
//
// The user holds exactly the `read` role, on exactly the `app` database, and nothing else.
// That is the shape the profile's negative write probe proves at open: a write it attempts
// into this server must come back refused with an authorization error (code 13), because
// the ROLE, not this file, is what the boundary rests on. A server started without `--auth`
// enforces nothing (measured 2026-09-27: a user holding only `read` wrote with `insertOne`
// and with `$out`), which is exactly what the probe exists to catch rather than trust.
//
// The `app` database's own documents come from 01-object-fixture.js; the principal adds no
// data, because a write through this account is the one thing the profile must not do.

db.getSiblingDB("app").createUser({
  user: "libredb_agent",
  pwd: "libredb_agent",
  roles: [{ role: "read", db: "app" }],
});

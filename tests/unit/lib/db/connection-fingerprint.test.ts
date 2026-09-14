import { describe, expect, test } from "bun:test";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The base connection every case below varies by exactly one field.
 *
 * `createdAt` is a fixed instant rather than `new Date()`, so a fingerprint that ever started
 * reading it would answer the same value twice here and the difference assertions would not be
 * the thing that caught it. The field assertions below are what decide that question.
 */
const BASE: DatabaseConnection = {
  id: "conn-1",
  name: "Primary",
  type: "postgres",
  host: "db.internal",
  port: 5432,
  database: "app",
  user: "libredb",
  password: "secret",
  createdAt: new Date("2026-09-13T00:00:00.000Z"),
};

function vary(overrides: Partial<DatabaseConnection>): DatabaseConnection {
  return { ...BASE, ...overrides };
}

describe("connectionFingerprint", () => {
  test("is a SHA-256 hex digest, so it is a fixed-width opaque string", async () => {
    const digest = await connectionFingerprint(BASE);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await connectionFingerprint(vary({}))).toBe(digest);
  });

  test("each of the nine server fields MOVES it, one field at a time", async () => {
    // One case per field rather than one case for all nine, because a walk that dropped a single
    // field would still answer differently for a connection that varied two.
    const base = await connectionFingerprint(BASE);
    expect(await connectionFingerprint(vary({ type: "mysql" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ host: "db.other" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ port: 5433 }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ database: "other" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ user: "someone" }))).not.toBe(base);
    // The four an external review of PR #831 asked for. Each one, changed ALONE, sends the same
    // sealed plan somewhere else: `connectionString` overrides the field-by-field form outright
    // (`postgres.ts:2095-2099`), `schema` is Trino's `X-Trino-Schema` submission header and is what
    // an unqualified name in the applied statement resolves against, `serviceName` is the tail of
    // Oracle's `host:port/service` connect string, and `instanceName` selects a MSSQL named
    // instance the Browser resolves to another process.
    expect(await connectionFingerprint(vary({ connectionString: "postgres://u@db.other/app" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ schema: "other" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ serviceName: "XEPDB1" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ instanceName: "SQLEXPRESS" }))).not.toBe(base);
  });

  test("two connections differing ONLY in their URI are two different servers", async () => {
    // THE REGRESSION FOR THE HOLE AN EXTERNAL REVIEW OF PR #831 FOUND, kept as a case of its own
    // rather than left to the one-field-at-a-time walk above, because the walk varies against a
    // base that carries NO URI and this pair carries one on both sides. REPRODUCED before the fix:
    // both sides answered `1c7e7b2e9f9ee023a97ad141dd3d3c92923bb03472f6b0ff0c726968c3fe28a5`.
    //
    // It is the population the digest exists for and the one it could not see. Every one of the
    // five original fields is IDENTICAL here, `id` included, so neither an id check nor the
    // five-field frame separates them, while `postgres.ts:2095-2099` opens the URI and ignores all
    // five. The plan is sealed against the left-hand server and applied against the right-hand one.
    const ours = await connectionFingerprint(vary({ connectionString: "postgres://libredb@db.internal:5432/app" }));
    const theirs = await connectionFingerprint(vary({ connectionString: "postgres://libredb@evil.example:5432/app" }));
    expect(ours).not.toBe(theirs);
    // And a URI is not the same address as the field-by-field form that spells out the same server,
    // which is the correct answer rather than a limitation: `pg` reaches them by different code and
    // a URI can carry `options`, `sslmode` and a target-session attribute the five fields cannot.
    expect(ours).not.toBe(await connectionFingerprint(BASE));
  });

  test("the connection's id and name are NOT in it", async () => {
    // MEASURED, `src/lib/seed/resolve-connection.ts:21-23` returns an inline connection object
    // verbatim, `id` included, so on the majority path the id is a string the caller typed.
    // Binding a plan to it would be vacuous for exactly the case the binding exists for.
    const base = await connectionFingerprint(BASE);
    expect(await connectionFingerprint(vary({ id: "conn-2" }))).toBe(base);
    expect(await connectionFingerprint(vary({ name: "Replica" }))).toBe(base);
    // Nor the credential: a fingerprint that moved with the password would refuse every plan
    // built before a rotation, and the password is not part of WHICH SERVER this is.
    expect(await connectionFingerprint(vary({ password: "rotated" }))).toBe(base);
  });

  test("the framing holds, so two fields cannot slide across their boundary", async () => {
    // The whole reason the walk is length-framed. Unframed, both of these concatenate to the
    // same `...appdb1u...`: an unframed walk answers ONE digest for TWO different servers, which
    // is the failure a fingerprint exists to prevent rather than an aesthetic point.
    const left = await connectionFingerprint(vary({ database: "d", user: "b1u" }));
    const right = await connectionFingerprint(vary({ database: "db1", user: "u" }));
    expect(left).not.toBe(right);
  });

  test("an absent field is not a throw, over BOTH populations that carry absences", async () => {
    // THIS TEST NAMED `connectionString` AND THEN NEVER BUILT ONE. It hashed a bare SQLite record
    // and nothing else, so the population its own comment claimed to cover was empty, which is
    // this phase's signature defect. Both are built now.
    const bare: DatabaseConnection = {
      id: "conn-3",
      name: "Bare",
      type: "sqlite",
      createdAt: BASE.createdAt,
    };
    expect(await connectionFingerprint(bare)).toMatch(/^[0-9a-f]{64}$/);
    // The other half: a URI-only connection, which is what `postgres.ts:2095-2099`,
    // `mysql.ts:1973-1976` and `mongodb.ts:800-801` all open when the record carries one. Every
    // one of the five original fields is absent on it and the URI is the entire address.
    const uriOnly: DatabaseConnection = {
      id: "conn-4",
      name: "URI only",
      type: "postgres",
      connectionString: "postgres://libredb:secret@db.internal:5432/app",
      createdAt: BASE.createdAt,
    };
    expect(await connectionFingerprint(uriOnly)).toMatch(/^[0-9a-f]{64}$/);
    // And it is not the digest of the SAME record with the URI removed, which is the assertion a
    // "does not throw" case cannot make on its own: an implementation that dropped the URI from the
    // frame would answer a hex string here and pass every line above, because `type` would be the
    // only field left and it is equal on both sides of this pair.
    expect(await connectionFingerprint(uriOnly)).not.toBe(
      await connectionFingerprint({ ...uriOnly, connectionString: undefined }),
    );
    // And an absent field is NOT the same as an empty one that happens to render alike: an empty
    // string and an absent field are both the empty frame, which is stated here as the measured
    // limit rather than left for a later reader to discover.
    expect(await connectionFingerprint({ ...bare, host: "" })).toBe(await connectionFingerprint(bare));
  });
});

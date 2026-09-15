import { describe, expect, test } from "bun:test";
import { connectionFingerprint } from "@/lib/db/connection-fingerprint";
import { TUNNEL_FAR_END } from "@/lib/types";
import type { DatabaseConnection, SSHTunnelConfig, WithTunnelFarEnd } from "@/lib/types";

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

/**
 * The bastion every tunnel case below varies by exactly one field. Its secrets are populated, so a
 * frame that hashed the whole `sshTunnel` object rather than its four route fields would fail the
 * rotation assertions rather than pass them by absence.
 */
const BASTION: SSHTunnelConfig = {
  enabled: true,
  host: "bastion.internal",
  port: 22,
  username: "libredb",
  authMethod: "password",
  password: "secret",
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

  test("each of the ten server fields MOVES it, one field at a time", async () => {
    // One case per field rather than one case for all ten, because a walk that dropped a single
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
    // The tenth, which the four above were audited without and which a review of THAT audit found
    // one field away: the bastion is the ROUTE, and `factory.ts:485-492` rewrites `host` and `port`
    // to the tunnel's local endpoint before the provider is constructed, so the tunnel and not the
    // record decides which machine the sealed statement reaches.
    expect(await connectionFingerprint(vary({ sshTunnel: BASTION }))).not.toBe(base);
  });

  test("two connections differing ONLY in their BASTION are two different servers", async () => {
    // THE REGRESSION FOR THE SECOND HOLE, the one the first fix left open. REPRODUCED against the
    // real module before the fix: `{ postgres, db.internal, 5432, app, libredb }` with no tunnel and
    // the same record carrying `sshTunnel: { enabled, attacker.example, mallory }` BOTH answered
    // `2dedca1a0ad45abdfb01427f0e1df3130e59617c5658058cbcf4852297f888c7`.
    //
    // Reachable with no forgery at all: preview an edit normally, then POST the SAME nine fields
    // with a fresh `connection.id`, which is out of the frame on purpose and also misses the
    // provider cache, plus a bastion the caller owns. The seal verified and the approved DDL and
    // the database credentials travelled through the caller's SSH server.
    //
    // This repository already hashes the tunnel into its OTHER connection identity,
    // `connectionIdentity` in `src/lib/agent/context-snapshot.ts`, whose docblock states the rule
    // this seal needed: the same `db:5432` reached through two different bastions is two different
    // databases. The field set below is that twin's, deliberately, so the two cannot drift.
    const ours = await connectionFingerprint(vary({ sshTunnel: BASTION }));
    expect(ours).not.toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, host: "attacker.example" } })));
    expect(ours).not.toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, port: 2222 } })));
    expect(ours).not.toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, username: "mallory" } })));
    // A DISABLED tunnel is not the same route as an enabled one to the same bastion, because
    // `factory.ts:485` branches on exactly that flag and only the enabled arm rewrites the endpoint.
    expect(ours).not.toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, enabled: false } })));
    // And the tunnel's SECRETS are out, on the rule the database password already follows: rotating
    // a key changes who may reach the bastion, never which machine it is. `hostKeyFingerprint` is
    // out for the twin's reason, it records what this connection TRUSTS rather than where it goes.
    expect(ours).toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, password: "rotated" } })));
    expect(ours).toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, privateKey: "-----BEGIN-----" } })));
    expect(ours).toBe(await connectionFingerprint(vary({ sshTunnel: { ...BASTION, passphrase: "p" } })));
    expect(ours).toBe(
      await connectionFingerprint(vary({ sshTunnel: { ...BASTION, hostKeyFingerprint: "SHA256:aa" } })),
    );
  });

  test("the tunnel's far end is what a rewritten connection frames (X23)", async () => {
    // X23 WAS THE OTHER HALF OF THE SSH ASYMMETRY, and this test used to pin it as a known gap.
    // `getOrCreateProvider` hands the provider a connection whose `host` and `port` are the
    // tunnel's LOCAL endpoint, `base-provider.ts` stores that object as `this.config`, and every
    // provider seals its plan with `connectionFingerprint(this.config)` - while the routes
    // fingerprint the UNREWRITTEN record. The two could never be equal, so 100 percent of
    // tunnelled connections were refused `EDIT_PLAN_INVALID` with no sentence saying why.
    //
    // The factory now carries the pre-rewrite endpoint under `TUNNEL_FAR_END` and this walk frames
    // it. Driven end to end through the factory in `tests/isolated/factory.test.ts` and against a
    // real bastion in `tests/live/ssh-tunnel-edit-plan.ts`; what is RUN here is the arithmetic.
    const record = vary({ sshTunnel: BASTION });
    const asTheProviderSeesIt: DatabaseConnection & WithTunnelFarEnd = {
      ...record,
      host: "127.0.0.1",
      port: 54_321,
      [TUNNEL_FAR_END]: { host: "db.internal", port: 5432 },
    };
    expect(await connectionFingerprint(asTheProviderSeesIt)).toBe(await connectionFingerprint(record));
    // FAIL CLOSED, and the control the equality above needs. Without the marker the same rewritten
    // record still answers the local endpoint and is still refused: the compare was not widened,
    // and nothing here falls back to "equal if we cannot tell".
    expect(await connectionFingerprint({ ...record, host: "127.0.0.1", port: 54_321 })).not.toBe(
      await connectionFingerprint(record),
    );
    // And the marker decides the ADDRESS rather than waving the check through: a far end pointing
    // somewhere else is a different digest, so a plan sealed through one forward cannot be applied
    // against another server.
    expect(
      await connectionFingerprint({ ...asTheProviderSeesIt, [TUNNEL_FAR_END]: { host: "evil.example", port: 5432 } }),
    ).not.toBe(await connectionFingerprint(record));
  });

  test("the NON-TUNNELLED digest has not moved, byte for byte", async () => {
    // Property 5 of the X23 ruling, and the regression that change could have caused: every plan
    // sealed by the untunnelled population - which is nearly all of it - must keep verifying.
    // These three literals were computed from the PRE-X23 framing, transcribed from the function
    // as it stood at the commit before the fix, and they are hard-coded rather than recomputed so
    // that a later edit to the walk cannot move them and stay green.
    expect(await connectionFingerprint(BASE)).toBe("0a6ad0c796153f04028d037f3008e2192fc193c18225f1ff4bd3d82ecb754568");
    expect(await connectionFingerprint(vary({ sshTunnel: BASTION }))).toBe(
      "06912b0f35bc9a4af38d9589e85e8e70742acbdd208783827c9e8d8bd0aecd6d",
    );
    expect(await connectionFingerprint({ id: "conn-3", name: "Bare", type: "sqlite", createdAt: BASE.createdAt })).toBe(
      "c1577a8f2f6b76941e22c93c70cbc5af78665bf543306685575dd1b7f7b4156f",
    );
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
    // And it holds INSIDE the tunnel's own field, which is a second frame and needed its own
    // colliding pair. MEASURED: dropping the inner `.map` from `tunnelRoute` was the ONE mutation
    // of five that every other assertion in this file survived, so this pair is the whole guard.
    // Unframed, both of these concatenate to `truebastion.internal22libredb`, one digest for a
    // bastion on port 22 and a DIFFERENT bastion, `bastion.internal2`, on port 2.
    const throughOne = await connectionFingerprint(
      vary({ sshTunnel: { ...BASTION, host: "bastion.internal", port: 22 } }),
    );
    const throughTwo = await connectionFingerprint(
      vary({ sshTunnel: { ...BASTION, host: "bastion.internal2", port: 2 } }),
    );
    expect(throughOne).not.toBe(throughTwo);
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
    // The third absence, added with the tunnel field: NO tunnel is not the same route as a tunnel
    // that happens to be switched off. An implementation that folded both to the empty frame would
    // pass every other line here, because nothing else in this file compares those two records.
    expect(await connectionFingerprint(bare)).not.toBe(
      await connectionFingerprint({ ...bare, sshTunnel: { ...BASTION, enabled: false } }),
    );
  });
});

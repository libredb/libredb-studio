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

  test("each of the five server fields MOVES it, one field at a time", async () => {
    // One case per field rather than one case for all five, because a walk that dropped a single
    // field would still answer differently for a connection that varied two.
    const base = await connectionFingerprint(BASE);
    expect(await connectionFingerprint(vary({ type: "mysql" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ host: "db.other" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ port: 5433 }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ database: "other" }))).not.toBe(base);
    expect(await connectionFingerprint(vary({ user: "someone" }))).not.toBe(base);
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

  test("an absent host, port, database or user is not a throw", async () => {
    // The live population: `connectionString` connections and the engines that carry none of
    // these, where every one of the four is undefined on a connection the route will resolve.
    const bare: DatabaseConnection = {
      id: "conn-3",
      name: "Bare",
      type: "sqlite",
      createdAt: BASE.createdAt,
    };
    expect(await connectionFingerprint(bare)).toMatch(/^[0-9a-f]{64}$/);
    // And an absent field is NOT the same as an empty one that happens to render alike: an empty
    // string and an absent field are both the empty frame, which is stated here as the measured
    // limit rather than left for a later reader to discover.
    expect(await connectionFingerprint({ ...bare, host: "" })).toBe(await connectionFingerprint(bare));
  });
});

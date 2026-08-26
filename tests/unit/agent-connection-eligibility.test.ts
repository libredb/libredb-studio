/**
 * Which connections a run may be STARTED on (#329 follow-up).
 *
 * A run persists a connection id and no credential, so the process that resumes it
 * re-resolves that id server-side. The question the rail has to answer is therefore
 * not "can I avoid shipping credentials" (that is `buildConnectionPayload`, whose own two
 * arms are pinned at the bottom of this file) but "will `seed:<id>` still reach the SAME
 * database later". The two answers coincide for a
 * managed connection and for a browser-only one, and diverge for the editable copy of
 * a seed — which is exactly what a zero-config deployment ships, and what left the
 * rail unable to start anything at all.
 *
 * The last test here is the anti-drift pin this needs: it takes the real seed
 * writers' output, puts it through the same JSON round trip the browser copy makes,
 * and asserts the payload builder's requirement still accepts it. A seed descriptor
 * that changed shape, or a rule that got stricter, fails here rather than in a
 * container.
 */

import { describe, expect, test, beforeAll } from "bun:test";
import type { DatabaseConnection } from "@/lib/types";
import {
  buildConnectionPayload,
  resolveAgentRunConnectionId,
  type ManagedConnectionPayload,
  type ServedSeeds,
} from "@/hooks/use-connection-payload";

/** A seed descriptor as `GET /api/connections/managed` serializes it. */
function descriptor(overrides: Partial<ManagedConnectionPayload> = {}): ManagedConnectionPayload {
  return {
    id: "seed:sales",
    seedId: "sales",
    name: "Sales",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    database: "sales",
    user: "reader",
    password: "s3cret",
    managed: false,
    createdAt: "1970-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** The copy `use-connection-manager` persists for an editable (managed:false) seed. */
function browserCopy(from: ManagedConnectionPayload, edits: Partial<DatabaseConnection> = {}): DatabaseConnection {
  const serialized = JSON.parse(JSON.stringify(from)) as ManagedConnectionPayload;
  return { ...serialized, createdAt: new Date(serialized.createdAt), managed: false, ...edits };
}

/** A seed list the server actually served — the ONLY thing an empty one may mean. */
function loaded(...seeds: ManagedConnectionPayload[]): ServedSeeds {
  return { loaded: true, seeds };
}

/** The id a run may be started on, dropping the reason the tests below do not read. */
function startableId(conn: DatabaseConnection, servedSeeds: ServedSeeds): string | null {
  return resolveAgentRunConnectionId(conn, servedSeeds).id;
}

describe("which connection a run may be started on", () => {
  test("a managed connection is startable by id without consulting any descriptor", () => {
    const managed: DatabaseConnection = {
      id: "seed:sales",
      seedId: "sales",
      name: "Sales",
      type: "postgres",
      managed: true,
      createdAt: new Date(0),
    };

    expect(startableId(managed, loaded())).toBe("seed:sales");
  });

  test("a connection with no seed origin is not startable", () => {
    const own: DatabaseConnection = {
      id: "local-1",
      name: "Local scratch",
      type: "postgres",
      host: "localhost",
      createdAt: new Date(0),
    };

    expect(startableId(own, loaded(descriptor()))).toBeNull();
  });

  test("an untouched copy of an editable seed is startable by id", () => {
    const server = descriptor();

    expect(startableId(browserCopy(server), loaded(server))).toBe("seed:sales");
  });

  test("a copy whose seed the server no longer serves is not startable", () => {
    const server = descriptor();

    expect(startableId(browserCopy(server), loaded(descriptor({ seedId: "other" })))).toBeNull();
  });

  // The whole reason the rule is not just "has a seedId": the server would resolve
  // `seed:sales` to ITS descriptor, so a run started here would investigate a
  // different database than the one the user is looking at, and say nothing.
  test("a copy edited to reach a different database is not startable", () => {
    const server = descriptor();

    expect(startableId(browserCopy(server, { database: "somewhere-else" }), loaded(server))).toBeNull();
  });

  test("a copy given different credentials is not startable", () => {
    const server = descriptor();

    expect(startableId(browserCopy(server, { password: "different" }), loaded(server))).toBeNull();
  });

  // The field a hand-written comparison forgets: it changes which role the agent
  // executes as, which is the whole point of the least-privilege profile (#328).
  test("a copy carrying its own agent credentials is not startable", () => {
    const server = descriptor();
    const copy = browserCopy(server, { agentUser: "agent_ro", agentPassword: "pw" });

    expect(startableId(copy, loaded(server))).toBeNull();
  });

  test("presentation-only edits leave a copy startable", () => {
    const server = descriptor();
    const renamed = browserCopy(server, {
      name: "My sales DB",
      color: "#ff0000",
      group: "work",
      environment: "development",
      createdAt: new Date("2026-08-12T00:00:00.000Z"),
    });

    expect(startableId(renamed, loaded(server))).toBe("seed:sales");
  });

  // B37. A seed list that was never read is not an empty seed list. Deciding
  // "browser-only" from it states a conclusion about the SERVER's copy that nothing
  // measured — and it is wrong for exactly the connections this application seeds itself.
  test("a seed copy is not judged browser-only while the served list is unread", () => {
    const copy = browserCopy(descriptor());

    expect(resolveAgentRunConnectionId(copy, { loaded: false })).toEqual({
      id: null,
      reason: "seed-config-unreadable",
    });
  });

  // The control: a served list that is genuinely empty HAS been measured, so the
  // browser-only verdict is the honest one there.
  test("a seed copy the server does not serve is browser-only, empty list and all", () => {
    const copy = browserCopy(descriptor());

    expect(resolveAgentRunConnectionId(copy, loaded())).toEqual({ id: null, reason: "browser-only" });
  });

  // An unread list changes nothing for a MANAGED connection: it only exists in the list
  // because the server served it, and its id is the server's own.
  test("a managed connection stays startable while the served list is unread", () => {
    const managed: DatabaseConnection = {
      id: "seed:sales",
      seedId: "sales",
      name: "Sales",
      type: "postgres",
      managed: true,
      createdAt: new Date(0),
    };

    expect(resolveAgentRunConnectionId(managed, { loaded: false })).toEqual({ id: "seed:sales" });
  });

  describe("nested transport settings", () => {
    const withSsl = descriptor({ ssl: { mode: "require", rejectUnauthorized: true } });

    test("an identical TLS block leaves a copy startable", () => {
      expect(startableId(browserCopy(withSsl), loaded(withSsl))).toBe("seed:sales");
    });

    test("a changed TLS field makes a copy unstartable", () => {
      const relaxed = browserCopy(withSsl, { ssl: { mode: "require", rejectUnauthorized: false } });

      expect(startableId(relaxed, loaded(withSsl))).toBeNull();
    });

    test("adding a TLS block the descriptor does not have makes a copy unstartable", () => {
      const server = descriptor();
      const added = browserCopy(server, { ssl: { mode: "disable" } });

      expect(startableId(added, loaded(server))).toBeNull();
    });

    test("dropping the descriptor's TLS block makes a copy unstartable", () => {
      const dropped = browserCopy(withSsl);
      delete (dropped as { ssl?: unknown }).ssl;

      expect(startableId(dropped, loaded(withSsl))).toBeNull();
    });

    test("a changed SSH tunnel makes a copy unstartable", () => {
      const tunnelled = descriptor({
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "ops", authMethod: "password" },
      });
      const rerouted = browserCopy(tunnelled, {
        sshTunnel: { enabled: true, host: "other-bastion", port: 22, username: "ops", authMethod: "password" },
      });

      expect(startableId(rerouted, loaded(tunnelled))).toBeNull();
    });
  });
});

/**
 * The reason this test exists: the two connections a default deployment ships are the ONLY
 * ones most installations have, so if the eligibility rule rejects them the whole
 * agent surface is unreachable out of the box. Nothing else in the suite compares
 * the seed writers' real output against the rule that consumes it.
 */
describe("the connections a default deployment ships", () => {
  let builders: { seedId: string; build: () => { seedId: string } }[] = [];

  beforeAll(async () => {
    process.env.LIBREDB_EMBEDDED_SAMPLE_PATH = "/tmp/libredb-eligibility-sample.libredb";
    process.env.SQLITE_EMBEDDED_SAMPLE_PATH = "/tmp/libredb-eligibility-sample.db";
    const [libredb, sqlite] = await Promise.all([
      import("@/lib/seed/libredb-sample"),
      import("@/lib/seed/sqlite-sample"),
    ]);
    builders = [
      { seedId: libredb.SAMPLE_SEED_ID, build: libredb.buildSampleConnection },
      { seedId: sqlite.SQLITE_SAMPLE_SEED_ID, build: sqlite.buildSqliteSampleConnection },
    ];
  });

  test("both built-in samples can start a run", () => {
    expect(builders).toHaveLength(2);

    for (const { seedId, build } of builders) {
      const served = JSON.parse(JSON.stringify(build())) as ManagedConnectionPayload;
      const stored = browserCopy(served);

      expect(startableId(stored, loaded(served))).toBe(`seed:${seedId}`);
    }
  });
});

/**
 * `buildConnectionPayload` — the other question, and the reason it belongs beside this
 * one: both decide what a request body may say about a connection, and they disagree
 * on purpose. The managed arm is a credential boundary, not a formatting choice: a
 * seed travels as a bare `seed:<id>` reference so nothing about how to authenticate
 * leaves the server's own configuration, and a browser-held connection has to travel
 * whole because the server has no other way to reach it.
 *
 * Pinned here rather than in a file of its own because this is the process that
 * measures this module: a test that only loads it records no line data for it at all.
 */
describe("what a request body says about a connection", () => {
  const plain = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
    id: "conn-1",
    name: "Sales",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "reader",
    password: "secret",
    database: "sales",
    createdAt: new Date(0),
    ...overrides,
  });

  test("a managed connection travels as a seed reference, carrying no credential", () => {
    const payload = buildConnectionPayload(plain({ managed: true, seedId: "sales" }));

    expect(payload).toEqual({ connectionId: "seed:sales" });
    // The point of the arm, asserted rather than assumed: nothing about how to
    // authenticate is in the body at all.
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  test("a browser-held connection travels whole, because the server cannot rebuild it", () => {
    const conn = plain();

    expect(buildConnectionPayload(conn)).toEqual({ connection: conn });
  });

  test("a seedId without `managed` is not a seed reference: the copy may point elsewhere", () => {
    const conn = plain({ seedId: "sales" });

    expect(buildConnectionPayload(conn)).toEqual({ connection: conn });
  });

  test("`managed` with no seedId has no id to reference, so it travels whole", () => {
    const conn = plain({ managed: true });

    expect(buildConnectionPayload(conn)).toEqual({ connection: conn });
  });
});

/**
 * GET /api/ready: readiness (docs/GOVERNANCE.md#freshness-and-readiness).
 *
 * The loader, the single flight and the state holder are the real ones; `pg` is the fake of
 * tests/helpers/governance/pg-fake.ts, so each case drives the governance source into the state it names, and every
 * connection the route makes Studio open is seen. `setSystemTime` ages the snapshot.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { keyringFileOf, removeKeyringFiles, testKey, writeKeyringFile } from "../helpers/governance/keyring-file";
import {
  answerSnapshot,
  contractRow,
  EMPTY_SOURCE,
  FakePool,
  fakePg,
  nodeError,
  pgError,
  settle,
} from "../helpers/governance/pg-fake";

const realPg = await import("pg");
mock.module("pg", () => ({ Pool: FakePool, Client: realPg.Client, types: realPg.types }));

const { GET } = await import("@/app/api/ready/route");
const { requestGovernanceLoad, stopGovernance } = await import("@/lib/governance/start");
const { resetGovernanceState } = await import("@/lib/governance/state");
const { resetGovernanceKeyring } = await import("@/lib/governance/keyring");
const { logger } = await import("@/lib/logger");

type ReadinessBody = import("@/app/api/ready/route").ReadinessBody;

const MANIFEST = JSON.parse(
  readFileSync(path.resolve(import.meta.dir, "../fixtures/governance/contract-v1.json"), "utf8"),
) as { readiness: { path: string; schema: Record<string, unknown> } };

/** The manifest's own readiness schema, the one a control plane checks Studio's answer against. */
const READINESS_SCHEMA = z.fromJSONSchema(MANIFEST.readiness.schema);

const ENV: Readonly<Record<string, string | undefined>> = {
  GOVERNANCE_SOURCE: "postgres",
  GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
  GOVERNANCE_PRIVATE_KEYS_FILE: keyringFileOf(testKey()),
  GOVERNANCE_POSTGRES_SCHEMA: undefined,
  GOVERNANCE_ALLOWED_ENGINES: undefined,
  GOVERNANCE_REFRESH_MS: undefined,
  GOVERNANCE_MAX_STALENESS_MS: undefined,
};

let saved: Record<string, string | undefined> = {};
let spies: ReturnType<typeof spyOn>[] = [];
/** How many connections Studio opened to the governance source. */
let connections = 0;
/** Whether the governance source accepts connections. */
let up = true;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {};
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    setEnv(name, value);
  }
  fakePg.reset();
  connections = 0;
  up = true;
  fakePg.connecting = async () => {
    connections += 1;
    if (!up) throw nodeError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:5432");
  };
  spies = (["error", "warn", "info", "debug"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => {}),
  );
});

afterEach(async () => {
  setSystemTime();
  await stopGovernance();
  resetGovernanceState();
  resetGovernanceKeyring();
  for (const [name, value] of Object.entries(saved)) setEnv(name, value);
  for (const spy of spies) spy.mockRestore();
});

afterAll(() => {
  removeKeyringFiles();
});

/** One answer of the route: its status, its body and its cache header. */
async function ready(): Promise<{ status: number; body: ReadinessBody; cacheControl: string | null }> {
  const response = GET();
  return {
    status: response.status,
    body: (await response.json()) as ReadinessBody,
    cacheControl: response.headers.get("cache-control"),
  };
}

/** Moves the clock `ms` past now. */
function age(ms: number): void {
  setSystemTime(new Date(Date.now() + ms));
}

describe("GET /api/ready", () => {
  test("a fresh snapshot answers 200 {status: ok, contract: {supported: [1], active: 1}}", async () => {
    await requestGovernanceLoad();
    expect(connections).toBe(1);

    const answer = await ready();

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: "ok", contract: { supported: [1], active: 1 } });
    expect(answer.cacheControl).toBe("no-store");
    // A fresh snapshot needs no load, so an anonymous caller cannot make Studio reload the source at will.
    await settle();
    expect(connections).toBe(1);
  });

  test("governance on with no successful load answers 503 loading", async () => {
    const first = await ready();
    expect(first.status).toBe(503);
    expect(first.body).toEqual({ status: "loading", contract: { supported: [1], active: null } });

    await requestGovernanceLoad();
    expect((await ready()).body).toEqual({ status: "ok", contract: { supported: [1], active: 1 } });
  });

  test("a request in every state other than ok starts no governance load", async () => {
    /** Answers once and lets every promise the answer could have started settle, then counts the connections. */
    const loadsStartedBy = async (expected: ReadinessBody["status"]): Promise<number> => {
      const before = connections;
      expect((await ready()).body.status).toBe(expected);
      await settle();
      return connections - before;
    };

    // loading: nothing has loaded yet.
    expect(await loadsStartedBy("loading")).toBe(0);
    // degraded, then unavailable, which answers as degraded.
    await requestGovernanceLoad();
    up = false;
    age(31_000);
    await requestGovernanceLoad();
    expect(await loadsStartedBy("degraded")).toBe(0);
    age(90_000);
    expect(await loadsStartedBy("degraded")).toBe(0);
    // misconfigured.
    up = true;
    fakePg.respond = async (sql) => {
      if (sql.includes("grants_v1")) throw pgError("42501", "permission denied for view grants_v1");
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };
    await requestGovernanceLoad();
    expect(await loadsStartedBy("misconfigured")).toBe(0);
    // incompatible.
    fakePg.respond = answerSnapshot({ ...EMPTY_SOURCE, contract: [contractRow(2)] });
    await requestGovernanceLoad();
    expect(await loadsStartedBy("incompatible")).toBe(0);
  });

  test("the detail of a misconfigured state names the object and SQLSTATE and never the server or keyring message", async () => {
    fakePg.respond = async (sql) => {
      if (sql.includes("connections_v1")) {
        throw pgError("42501", "permission denied for view connections_v1 as role libredb_studio_admin");
      }
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };
    await requestGovernanceLoad();

    const denied = await ready();
    expect(denied.status).toBe(503);
    expect(denied.body).toEqual({
      status: "misconfigured",
      contract: { supported: [1], active: null },
      detail: "bridge.connections_v1: 42501",
    });

    // A keyring that does not load is named by its variable, never by the loader's message and its file path.
    const emptyKeyring = writeKeyringFile({ version: 1, keys: [] });
    process.env.GOVERNANCE_PRIVATE_KEYS_FILE = emptyKeyring;
    resetGovernanceKeyring();
    await requestGovernanceLoad();

    const keyring = await ready();
    expect(keyring.status).toBe(503);
    expect(keyring.body).toEqual({
      status: "misconfigured",
      contract: { supported: [1], active: null },
      detail: "GOVERNANCE_PRIVATE_KEYS_FILE",
    });
    expect(JSON.stringify(keyring.body)).not.toContain(emptyKeyring);
  });

  test("after one successful load a database outage answers 200 degraded", async () => {
    await requestGovernanceLoad();
    up = false;
    age(31_000);
    await requestGovernanceLoad();

    const degraded = await ready();
    expect(degraded.status).toBe(200);
    expect(degraded.body).toEqual({ status: "degraded", contract: { supported: [1], active: 1 } });
    // The route only reads the state: the refresher, not the probe, retries the load.
    await settle();
    expect(connections).toBe(2);

    // Past GOVERNANCE_MAX_STALENESS_MS the snapshot is unavailable, still answered as degraded with 200, so an
    // administrator can reach the status page.
    age(90_000);
    const unavailable = await ready();
    expect(unavailable.status).toBe(200);
    expect(unavailable.body).toEqual({ status: "degraded", contract: { supported: [1], active: 1 } });
  });

  test("42501 on a view answers 503 misconfigured naming the view in detail", async () => {
    fakePg.respond = async (sql) => {
      if (sql.includes("grants_v1")) throw pgError("42501", "permission denied for view grants_v1");
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };
    await requestGovernanceLoad();

    const answer = await ready();

    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({
      status: "misconfigured",
      contract: { supported: [1], active: null },
      detail: "bridge.grants_v1: 42501",
    });
  });

  test("no common contract version answers 503 incompatible listing both version sets", async () => {
    await requestGovernanceLoad();
    fakePg.respond = answerSnapshot({ ...EMPTY_SOURCE, contract: [contractRow(2), contractRow(3)] });
    await requestGovernanceLoad();

    const answer = await ready();

    expect(answer.status).toBe(503);
    // The snapshot kept from the first load is not in use, so no version is active.
    expect(answer.body).toEqual({
      status: "incompatible",
      contract: { supported: [1], active: null },
      detail: "no common contract version: Studio supports [1], the governance source publishes [2, 3]",
    });
  });

  test("governance off answers 200 {status: ready, contract: {supported: [1], active: null}}", async () => {
    delete process.env.GOVERNANCE_SOURCE;

    const answer = await ready();

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: "ready", contract: { supported: [1], active: null } });
    expect(answer.cacheControl).toBe("no-store");
    await settle();
    // Nothing is loaded and no pool is made without governance.
    expect(connections).toBe(0);
    expect(FakePool.made).toEqual([]);
  });

  test("every body the route answers validates against the manifest's readiness schema", async () => {
    expect(MANIFEST.readiness.path).toBe("/api/ready");
    const bodies: ReadinessBody[] = [];
    const collect = async (): Promise<void> => {
      bodies.push((await ready()).body);
    };

    // loading, with a source that refuses connections.
    up = false;
    await collect();
    await settle();
    // ok, then degraded, then unavailable.
    up = true;
    await requestGovernanceLoad();
    await collect();
    up = false;
    age(31_000);
    await requestGovernanceLoad();
    await collect();
    age(120_000);
    await collect();
    // misconfigured and incompatible.
    up = true;
    fakePg.respond = async (sql) => {
      if (sql.includes("connections_v1")) throw pgError("42P01", 'relation "bridge.connections_v1" does not exist');
      return answerSnapshot(EMPTY_SOURCE)(sql);
    };
    await requestGovernanceLoad();
    await collect();
    fakePg.respond = answerSnapshot({ ...EMPTY_SOURCE, contract: [contractRow(2)] });
    await requestGovernanceLoad();
    await collect();
    // ready, without governance.
    delete process.env.GOVERNANCE_SOURCE;
    await collect();

    expect(bodies.map((body) => body.status)).toEqual([
      "loading",
      "ok",
      "degraded",
      "degraded",
      "misconfigured",
      "incompatible",
      "ready",
    ]);
    for (const body of bodies) expect(READINESS_SCHEMA.safeParse(body).success).toBe(true);
  });
});

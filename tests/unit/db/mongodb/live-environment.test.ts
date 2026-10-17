/**
 * The MongoDB agent profile's live check and the fixture around it, held to the rules the check rests on (issue #1614).
 *
 * One image runs the developer's fixture, the check and CI: database-compose.yml's `mongodb` service pins MongoDB 9.0.4
 * by digest, the check runs that reference unless `LIBREDB_LIVE_MONGO_IMAGE` names another reference to the same digest
 * (a mirror of Docker Hub), and the CI step names it to the check. The check's containers bind a loopback port Docker
 * picks, mount the repository's init scripts read-only and take a root password made for the run, never written on a
 * command line. Its plan rule finds a server key at a plan's top level and the server's host anywhere in the plan, and
 * its plan readings find a group and a sort's limit in the plans 9.0.4 and 7.0.43 answer. Each rule is also run on a
 * planted fault, so a rule that cannot fail is caught here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  liveImage,
  MONGODB_LIVE_IMAGE,
  mongoRunArgs,
  PLAN_KEYS,
  planRowProblems,
  planRunsGroup,
  planSortLimits,
  planStageNames,
} from "../../../live/mongodb-agent-profile";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");
const PINNED_904 = /^mongo:9\.0\.4@sha256:[0-9a-f]{64}$/;
const SCRIPT = "tests/live/mongodb-agent-profile.ts";
const DIGEST = MONGODB_LIVE_IMAGE.slice(MONGODB_LIVE_IMAGE.indexOf("@"));

interface Service {
  readonly image?: string;
  readonly volumes?: readonly string[];
}

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly if?: string;
  readonly env?: Readonly<Record<string, string>>;
}

describe("the pinned image", () => {
  const compose = parseYaml(read("database-compose.yml"), { merge: true }) as { services: Record<string, Service> };
  const mongodb = compose.services.mongodb;

  test("database-compose.yml's mongodb service runs MongoDB 9.0.4 pinned by digest, the check's own image", () => {
    expect(mongodb.image).toMatch(PINNED_904);
    expect(mongodb.image).toBe(MONGODB_LIVE_IMAGE);
    expect(MONGODB_LIVE_IMAGE).toMatch(PINNED_904);
  });

  test("the service mounts the init scripts the check mounts, read-only", () => {
    expect(mongodb.volumes).toContain("./docker/mongodb-init:/docker-entrypoint-initdb.d:ro");
  });

  test("the check runs the pinned reference, or another reference to its digest, and refuses any other", () => {
    expect(liveImage({})).toBe(MONGODB_LIVE_IMAGE);
    expect(liveImage({ LIBREDB_LIVE_MONGO_IMAGE: "" })).toBe(MONGODB_LIVE_IMAGE);
    const mirror = `mirror.gcr.io/library/${MONGODB_LIVE_IMAGE}`;
    expect(liveImage({ LIBREDB_LIVE_MONGO_IMAGE: mirror })).toBe(mirror);
    expect(() => liveImage({ LIBREDB_LIVE_MONGO_IMAGE: "mongo:9.0.4" })).toThrow(DIGEST);
    expect(() => liveImage({ LIBREDB_LIVE_MONGO_IMAGE: `mongo:9.0.4@sha256:${"0".repeat(64)}` })).toThrow(DIGEST);
    expect(() => liveImage({ LIBREDB_LIVE_MONGO_IMAGE: `mongo:9.0.4${DIGEST}0` })).toThrow(DIGEST);
  });
});

describe("the CI step", () => {
  const CI = parseYaml(read(".github/workflows/ci.yml")) as {
    jobs: Record<string, { name?: string; steps: Step[] }>;
  };
  const smoke = CI.jobs["functional-smoke"];
  const names = smoke.steps.map((step) => step.name);
  const step = smoke.steps.find((s) => s.name === "MongoDB agent read-only live check");

  test("the job keeps its id and names the three engines it checks, so a red check never shows under another's label", () => {
    expect(smoke.name).toBe("Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)");
  });

  test("the step runs after the functional smoke and the RabbitMQ check, with no condition, so it cannot hide their results", () => {
    const at = names.indexOf("MongoDB agent read-only live check");
    expect(names.indexOf("Run functional smoke")).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(names.indexOf("Run functional smoke"));
    expect(at).toBeGreaterThan(names.indexOf("RabbitMQ read-only check"));
    expect(names.indexOf("RabbitMQ read-only check")).toBeGreaterThan(-1);
    expect(step?.run).toBe(`bun ${SCRIPT}`);
    expect(step?.if).toBeUndefined();
  });

  test("the step names the pinned image to the check, the compose fixture's own", () => {
    expect(step?.env?.LIBREDB_LIVE_MONGO_IMAGE).toBe(MONGODB_LIVE_IMAGE);
    expect(liveImage(step?.env ?? {})).toBe(MONGODB_LIVE_IMAGE);
  });
});

describe("the maintainer loop", () => {
  test("loop/scripts/functional-smoke.sh runs the check right after the PostgreSQL one", () => {
    const lines = read("loop/scripts/functional-smoke.sh")
      .split("\n")
      .filter((line) => line.startsWith("bun tests/live/"));
    expect(lines).toEqual(["bun tests/live/postgres-read-only-live.ts", `bun ${SCRIPT}`]);
  });

  test("the loop's README and the PostgreSQL check name the job by its name", () => {
    for (const file of ["loop/README.md", "tests/live/postgres-read-only-live.ts"]) {
      const named = read(file).match(/Functional Smoke \([^)]*\)/g) ?? [];
      expect({ file, named }).toEqual({ file, named: ["Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)"] });
    }
  });
});

describe("the containers", () => {
  const INIT = "/repo/docker/mongodb-init";

  /** The host ports an argument list publishes, as `docker run` reads `-p`. */
  const published = (args: readonly string[]): string[] =>
    args.flatMap((arg, at) => (args[at - 1] === "-p" ? [arg] : []));

  test("an authorized server takes the root user, mounts the init scripts read-only and binds a loopback port Docker picks", () => {
    const args = mongoRunArgs({ name: "n", image: MONGODB_LIVE_IMAGE, authorization: true }, INIT);
    expect(args.slice(0, 4)).toEqual(["run", "-d", "--name", "n"]);
    expect(args).toContain("MONGO_INITDB_ROOT_USERNAME=root");
    expect(args).toContain("MONGO_INITDB_ROOT_PASSWORD");
    expect(args).toContain(`${INIT}:/docker-entrypoint-initdb.d:ro`);
    expect(published(args)).toEqual(["127.0.0.1::27017"]);
    expect(args.at(-1)).toBe(MONGODB_LIVE_IMAGE);
  });

  test("the password is passed by name only, so no command line and no listing of processes carries it", () => {
    const args = mongoRunArgs({ name: "n", image: MONGODB_LIVE_IMAGE, authorization: true }, INIT);
    expect(args.filter((arg) => arg.startsWith("MONGO_INITDB_ROOT_PASSWORD"))).toEqual(["MONGO_INITDB_ROOT_PASSWORD"]);
  });

  test("a server without authorization takes no root user, so the image starts it without --auth", () => {
    const args = mongoRunArgs({ name: "n", image: MONGODB_LIVE_IMAGE, authorization: false }, INIT);
    expect(args.some((arg) => arg.startsWith("MONGO_INITDB_ROOT"))).toBe(false);
    expect(args).toContain(`${INIT}:/docker-entrypoint-initdb.d:ro`);
    expect(published(args)).toEqual(["127.0.0.1::27017"]);
  });

  test("only the server for the deadline's own kill enables the test commands, after the image", () => {
    const plain = mongoRunArgs({ name: "n", image: MONGODB_LIVE_IMAGE, authorization: true }, INIT);
    expect(plain.some((arg) => arg.includes("enableTestCommands"))).toBe(false);
    const kill = mongoRunArgs({ name: "n", image: MONGODB_LIVE_IMAGE, authorization: true, testCommands: true }, INIT);
    expect(kill.slice(kill.indexOf(MONGODB_LIVE_IMAGE) + 1)).toEqual(["--setParameter", "enableTestCommands=1"]);
  });
});

describe("the plan rule", () => {
  const HOST = "5f0aafecab29";
  const plan = {
    explainVersion: "1",
    queryPlanner: { namespace: "app.live_slow", winningPlan: { stage: "COLLSCAN" } },
  };

  test("the plan keys are the seven agent-read.ts keeps (PLAN_KEYS there)", () => {
    expect([...PLAN_KEYS]).toEqual([
      "explainVersion",
      "queryPlanner",
      "stages",
      "mergeType",
      "mergeShardId",
      "splitPipeline",
      "shards",
    ]);
  });

  test("a row of plan keys without the server's host passes", () => {
    expect(planRowProblems(plan, HOST)).toEqual([]);
  });

  test("a server key at the top level is found, and a field the command names serverInfo below it is not", () => {
    expect(planRowProblems({ ...plan, serverInfo: { port: 27017 }, ok: 1 }, HOST)).toEqual([
      'top-level key "serverInfo" is not a plan key',
      'top-level key "ok" is not a plan key',
    ]);
    const echoed = { ...plan, queryPlanner: { parsedQuery: { serverInfo: { $eq: 1 } } } };
    expect(planRowProblems(echoed, HOST)).toEqual([]);
  });

  test("the server's host anywhere in the row is found, and an empty host is refused rather than matched", () => {
    const leaked = { ...plan, queryPlanner: { winningPlan: { shards: [{ host: `${HOST}:27017` }] } } };
    expect(planRowProblems(leaked, HOST)).toEqual([`the row carries the server's host ${HOST}`]);
    expect(() => planRowProblems(plan, "")).toThrow("no host");
  });
});

describe("the plan readings", () => {
  // Trimmed from the plans 9.0.4 (slot-based) and 7.0.43 (classic) answered for the check's own reads.
  const sbeCount = {
    queryPlanner: { winningPlan: { queryPlan: { stage: "GROUP", inputStage: { stage: "COLLSCAN" } } } },
  };
  const classicCount = {
    stages: [{ $cursor: { queryPlanner: { winningPlan: { stage: "COLLSCAN" } } } }, { $group: { _id: { $const: 1 } } }],
  };
  const fastCount = { queryPlanner: { winningPlan: { stage: "RECORD_STORE_FAST_COUNT" } } };

  test("a group is found in a slot-based GROUP stage and in a classic pipeline's $group stage, and nowhere else", () => {
    expect(planRunsGroup(sbeCount)).toBe(true);
    expect(planRunsGroup(classicCount)).toBe(true);
    expect(planRunsGroup(fastCount)).toBe(false);
  });

  test("every stage name is read at any depth", () => {
    expect(planStageNames(sbeCount)).toEqual(["GROUP", "COLLSCAN"]);
    expect(planStageNames(fastCount)).toEqual(["RECORD_STORE_FAST_COUNT"]);
  });

  test("a sort's limit is read from a SORT stage and from a classic $sort stage", () => {
    const sortStage = { queryPlanner: { winningPlan: { stage: "SORT", limitAmount: 11, inputStage: {} } } };
    const classicSort = { stages: [{ $cursor: {} }, { $sort: { sortKey: { i: 1 }, limit: 11 } }] };
    expect(planSortLimits(sortStage)).toEqual([11]);
    expect(planSortLimits(classicSort)).toEqual([11]);
    expect(planSortLimits(sbeCount)).toEqual([]);
  });
});

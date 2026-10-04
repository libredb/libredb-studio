/**
 * Unit tests for the CapRover discovery exporter (`docker/discover.mjs`).
 *
 * The exporter runs as root with the Docker socket mounted, which is root on the host, and the file it
 * writes holds database passwords. It sits outside src/, so the coverage gate does not measure it
 * (scripts/merge-lcov.mjs keeps src/ only): every branch below is covered by discipline instead, the way
 * tests/unit/docker-bind-address.test.ts covers bind-address.mjs.
 *
 * WHY each group is worth locking:
 *  - The allow-list is the only thing between every app's secrets and the shared volume. Its exact ten
 *    keys, the mixed-case DFLY_requirepass, and the split on the FIRST "=" (a password may contain "=" or
 *    spaces) are each a way to leak or to lose a credential.
 *  - Network and service selection: Docker's name filter matches substrings, CapRover's own services share
 *    the network, and Studio's image runs both the web app and this exporter.
 *  - Host resolution: legacy apps have no alias and their service name IS the host; deriving the host by
 *    adding or stripping the prefix breaks one of the two shapes.
 *  - Every bound, because the file is untrusted input for Studio and a Docker answer is untrusted input here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as nodeFs from "node:fs";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appNameOf,
  buildExport,
  checkOutputDir,
  classifyDockerError,
  createDockerClient,
  DEFAULTS,
  ENV_ALLOW_LIST,
  hostOf,
  isDirectExecution,
  isStudioImage,
  LIMITS,
  main,
  parseExcludeList,
  projectEnv,
  readConfig,
  requirepassEnvOf,
  scanOnce,
  selectNetwork,
  selectServices,
  serializeExport,
  writeExportAtomic,
} from "../../docker/discover.mjs";
import { eventually } from "../helpers/node-transport-fixtures";
import { describeIf, MISSING_POSIX_FILE_MODES, MISSING_UNIX_SOCKETS } from "../helpers/posix-tools";

const NETWORK_ID = "jolhlap6b0rctoqh21rk8sidt";
const NETWORK = { id: NETWORK_ID, name: "captain-overlay-network" };

interface ServiceShape {
  id: string;
  name: string;
  image: string;
  env?: string[];
  command?: string[];
  args?: string[];
  networks?: { Target: string; Aliases?: string[] }[];
  status?: { RunningTasks?: unknown; DesiredTasks?: unknown };
}

/** One entry of GET /v1.44/services?status=true, in the shape the Engine answers. */
function dockerService(shape: ServiceShape) {
  return {
    ID: shape.id,
    Spec: {
      Name: shape.name,
      TaskTemplate: {
        ContainerSpec: { Image: shape.image, Env: shape.env, Command: shape.command, Args: shape.args },
        Networks: shape.networks ?? [{ Target: NETWORK_ID, Aliases: [`srv-captain--${shape.name}`] }],
      },
    },
    ServiceStatus: shape.status ?? { RunningTasks: 1, DesiredTasks: 1 },
  };
}

describe("the reviewed constants", () => {
  test("the allow-list is exactly the ten keys, in order, and cannot be changed at run time", () => {
    expect([...ENV_ALLOW_LIST]).toEqual([
      "POSTGRES_USER",
      "POSTGRES_PASSWORD",
      "POSTGRES_DB",
      "MYSQL_ROOT_PASSWORD",
      "MONGO_INITDB_ROOT_USERNAME",
      "MONGO_INITDB_ROOT_PASSWORD",
      "REDIS_PASSWORD",
      "VALKEY_EXTRA_FLAGS",
      "KEYDB_PASSWORD",
      "DFLY_requirepass",
    ]);
    expect(Object.isFrozen(ENV_ALLOW_LIST)).toBe(true);
  });

  test("the defaults and the bounds are the ones the spec names", () => {
    expect({ ...DEFAULTS }).toEqual({
      output: "/app/discovery/services.json",
      network: "captain-overlay-network",
      intervalMs: 10000,
      minIntervalMs: 2000,
      socket: "/var/run/docker.sock",
      fileUid: 1001,
      fileGid: 1001,
    });
    expect({ ...LIMITS }).toEqual({
      services: 500,
      envValueBytes: 1024,
      name: 63,
      host: 253,
      image: 512,
      fileBytes: 2097152,
      responseBytes: 16777216,
      requestTimeoutMs: 10000,
      messageChars: 512,
    });
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

describe("readConfig and parseExcludeList", () => {
  test("an empty environment, or none, is every default", () => {
    const expected = {
      output: "/app/discovery/services.json",
      network: "captain-overlay-network",
      intervalMs: 10000,
      exclude: new Set<string>(),
      socket: "/var/run/docker.sock",
      fileUid: 1001,
      fileGid: 1001,
      once: false,
    };
    expect(readConfig({})).toEqual(expected);
    expect(readConfig(undefined)).toEqual(expected);
  });

  test("reads every variable, trimmed", () => {
    expect(
      readConfig({
        DISCOVERY_OUTPUT: " /data/out.json ",
        DISCOVERY_NETWORK: " my-net ",
        DISCOVERY_INTERVAL_MS: " 2000 ",
        DISCOVERY_EXCLUDE: "wordpress-db, umami-postgres",
        DOCKER_SOCKET: " /run/docker.sock ",
        DISCOVERY_FILE_UID: "0",
        DISCOVERY_FILE_GID: " 42 ",
        DISCOVERY_ONCE: " 1 ",
      }),
    ).toEqual({
      output: "/data/out.json",
      network: "my-net",
      intervalMs: 2000,
      exclude: new Set(["wordpress-db", "umami-postgres"]),
      socket: "/run/docker.sock",
      fileUid: 0,
      fileGid: 42,
      once: true,
    });
  });

  test("blank values mean unset", () => {
    const config = readConfig({
      DISCOVERY_OUTPUT: "  ",
      DISCOVERY_NETWORK: "",
      DISCOVERY_INTERVAL_MS: " ",
      DOCKER_SOCKET: "",
      DISCOVERY_FILE_UID: "",
      DISCOVERY_FILE_GID: "  ",
    });
    expect(config.output).toBe("/app/discovery/services.json");
    expect(config.network).toBe("captain-overlay-network");
    expect(config.intervalMs).toBe(10000);
    expect(config.socket).toBe("/var/run/docker.sock");
    expect(config.fileUid).toBe(1001);
    expect(config.fileGid).toBe(1001);
  });

  test("DISCOVERY_ONCE is on for exactly 1", () => {
    expect(readConfig({ DISCOVERY_ONCE: "true" }).once).toBe(false);
    expect(readConfig({ DISCOVERY_ONCE: "0" }).once).toBe(false);
    expect(readConfig({ DISCOVERY_ONCE: "1" }).once).toBe(true);
  });

  test.each([["1999"], ["0"], ["abc"], ["-5"], ["1e4"], ["2000.5"]])(
    "DISCOVERY_INTERVAL_MS=%p is refused with the variable's name",
    (raw) => {
      expect(() => readConfig({ DISCOVERY_INTERVAL_MS: raw })).toThrow(
        `DISCOVERY_INTERVAL_MS must be an integer of at least 2000, got "${raw}"`,
      );
    },
  );

  test.each([["DISCOVERY_FILE_UID"], ["DISCOVERY_FILE_GID"]])("%s must be a non-negative integer", (name) => {
    expect(() => readConfig({ [name]: "nextjs" })).toThrow(`${name} must be an integer of at least 0, got "nextjs"`);
    expect(() => readConfig({ [name]: "-1" })).toThrow(name);
  });

  // setTimeout turns a delay above 2147483647 into 1 ms, so the loop would rescan back to back.
  test("DISCOVERY_INTERVAL_MS is accepted up to 2147483647, the longest delay a timer honours", () => {
    expect(readConfig({ DISCOVERY_INTERVAL_MS: "2147483647" }).intervalMs).toBe(2147483647);
    expect(() => readConfig({ DISCOVERY_INTERVAL_MS: "2147483648" })).toThrow(
      'DISCOVERY_INTERVAL_MS must be an integer of at most 2147483647, got "2147483648"',
    );
  });

  // Number() reads a digit string this long as Infinity, which setTimeout also turns into 1 ms.
  test("a 400-digit DISCOVERY_INTERVAL_MS is refused, not read as Infinity", () => {
    const raw = "9".repeat(400);
    expect(() => readConfig({ DISCOVERY_INTERVAL_MS: raw })).toThrow(
      `DISCOVERY_INTERVAL_MS must be an integer of at most 2147483647, got "${raw}"`,
    );
  });

  // fchownSync throws on an id above 4294967295 and reads 4294967295 itself as "leave the owner as it is",
  // which would leave a root-owned 0600 file that Studio cannot read.
  test.each([
    ["DISCOVERY_FILE_UID", "fileUid"],
    ["DISCOVERY_FILE_GID", "fileGid"],
  ] as const)("%s is accepted up to 4294967294, the largest id fchownSync sets", (name, key) => {
    expect(readConfig({ [name]: "4294967294" })[key]).toBe(4294967294);
    expect(() => readConfig({ [name]: "4294967295" })).toThrow(
      `${name} must be an integer of at most 4294967294, got "4294967295"`,
    );
  });

  test("the exclude list drops blanks and empty items and keeps each name once", () => {
    expect(parseExcludeList(" a, ,b,,a ")).toEqual(new Set(["a", "b"]));
    expect(parseExcludeList("")).toEqual(new Set());
    expect(parseExcludeList(undefined)).toEqual(new Set());
  });
});

describe("selectNetwork - the substring trap", () => {
  test("only an exact Name counts, because the Engine's name filter matches substrings", () => {
    const answer = [
      { Name: "captain-overlay-network-old", Id: "old", Scope: "swarm" },
      { Name: "captain-overlay-network", Id: NETWORK_ID, Scope: "swarm" },
    ];
    expect(selectNetwork(answer, "captain-overlay-network")).toEqual(NETWORK);
    expect(selectNetwork(answer, "captain")).toBeNull();
  });

  test("a swarm-scoped network wins over a local one of the same name", () => {
    const answer = [
      { Name: "captain-overlay-network", Id: "local1", Scope: "local" },
      { Name: "captain-overlay-network", Id: NETWORK_ID, Scope: "swarm" },
    ];
    expect(selectNetwork(answer, "captain-overlay-network")).toEqual(NETWORK);
    expect(selectNetwork([answer[0]], "captain-overlay-network")).toEqual({
      id: "local1",
      name: "captain-overlay-network",
    });
  });

  test("an answer that is not a list, or entries without an Id, select nothing", () => {
    expect(selectNetwork({ message: "x" }, "captain-overlay-network")).toBeNull();
    expect(selectNetwork([null, { Name: "captain-overlay-network" }], "captain-overlay-network")).toBeNull();
  });
});

describe("isStudioImage, appNameOf and hostOf", () => {
  test.each([
    ["ghcr.io/libredb/libredb-studio:0.18.0", true],
    ["libredb/libredb-studio", true],
    ["libredb/libredb-studio:latest@sha256:abc", true],
    ["localhost:5000/mirror/libredb/libredb-studio:1", true],
    ["evil-libredb/libredb-studio:1", false],
    ["libredb/libredb-studio-fork:1", false],
    ["postgres:16", false],
    ["", false],
  ])("isStudioImage(%p) is %p", (image, expected) => {
    expect(isStudioImage(image)).toBe(expected);
  });

  test("isStudioImage refuses a non-string", () => {
    expect(isStudioImage(undefined)).toBe(false);
  });

  test("the app name drops a leading legacy prefix and nothing else", () => {
    expect(appNameOf("pgtest")).toBe("pgtest");
    expect(appNameOf("srv-captain--pgtest")).toBe("pgtest");
    expect(appNameOf("x-srv-captain--y")).toBe("x-srv-captain--y");
  });

  test("a current app is dialled by its srv-captain-- alias on the matching attachment", () => {
    const spec = dockerService({ id: "a", name: "pgtest", image: "postgres:16" }).Spec;
    expect(hostOf(spec, NETWORK)).toBe("srv-captain--pgtest");
  });

  test("an attachment that targets the network by name counts too", () => {
    const spec = dockerService({
      id: "a",
      name: "pgtest",
      image: "postgres:16",
      networks: [{ Target: "captain-overlay-network", Aliases: ["srv-captain--pgtest"] }],
    }).Spec;
    expect(hostOf(spec, NETWORK)).toBe("srv-captain--pgtest");
  });

  test("a legacy app has no alias, and its service name is the host", () => {
    const spec = dockerService({
      id: "a",
      name: "srv-captain--oldpg",
      image: "postgres:16",
      networks: [{ Target: NETWORK_ID }],
    }).Spec;
    expect(hostOf(spec, NETWORK)).toBe("srv-captain--oldpg");
  });

  test("an app deployed before CapRover added the alias is dialled by its bare name", () => {
    const spec = dockerService({
      id: "a",
      name: "pgtest",
      image: "postgres:16",
      networks: [{ Target: NETWORK_ID, Aliases: ["pgtest-extra"] }],
    }).Spec;
    expect(hostOf(spec, NETWORK)).toBe("pgtest");
  });

  test("an alias on another network is not used", () => {
    const spec = dockerService({
      id: "a",
      name: "pgtest",
      image: "postgres:16",
      networks: [
        { Target: "other", Aliases: ["srv-captain--elsewhere"] },
        { Target: NETWORK_ID, Aliases: "srv-captain--pgtest" as unknown as string[] },
      ],
    }).Spec;
    expect(hostOf(spec, NETWORK)).toBe("pgtest");
  });
});

describe("projectEnv - the allow-list", () => {
  test("keeps only allow-listed keys, in allow-list order", () => {
    const result = projectEnv(
      ["SECRET_KEY_BASE=leak", "POSTGRES_PASSWORD=pw", "PGDATA=/data", "POSTGRES_USER=postgres", "postgres_db=x"],
      ENV_ALLOW_LIST,
    );
    expect(result).toEqual({ env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "pw" }, dropped: 0 });
    expect(Object.keys(result.env)).toEqual(["POSTGRES_USER", "POSTGRES_PASSWORD"]);
  });

  test("DFLY_requirepass is matched in its own mixed case, and only in it", () => {
    expect(projectEnv(["DFLY_requirepass=dfly", "DFLY_REQUIREPASS=upper"], ENV_ALLOW_LIST)).toEqual({
      env: { DFLY_requirepass: "dfly" },
      dropped: 0,
    });
  });

  test("a value with '=' and surrounding spaces is split on the first '=' and kept byte for byte", () => {
    expect(projectEnv(["POSTGRES_PASSWORD= a=b "], ENV_ALLOW_LIST)).toEqual({
      env: { POSTGRES_PASSWORD: " a=b " },
      dropped: 0,
    });
    expect(projectEnv(["VALKEY_EXTRA_FLAGS=--requirepass 'x=y' --maxmemory 1gb"], ENV_ALLOW_LIST).env).toEqual({
      VALKEY_EXTRA_FLAGS: "--requirepass 'x=y' --maxmemory 1gb",
    });
  });

  test("an empty value is a value", () => {
    expect(projectEnv(["REDIS_PASSWORD="], ENV_ALLOW_LIST).env).toEqual({ REDIS_PASSWORD: "" });
  });

  test("entries without '=' or with an empty key, and non-strings, are skipped", () => {
    // "POSTGRES_USERx" has no "=": it must not be read as the allow-listed key POSTGRES_USER with a cut-off letter.
    const entries = ["POSTGRES_PASSWORD", "POSTGRES_USERx", "=POSTGRES_PASSWORD", 42, null];
    expect(projectEnv(entries, ENV_ALLOW_LIST)).toEqual({
      env: {},
      dropped: 0,
    });
  });

  test("the last duplicate wins, as it does for the container", () => {
    expect(projectEnv(["POSTGRES_PASSWORD=first", "POSTGRES_PASSWORD=second"], ENV_ALLOW_LIST).env).toEqual({
      POSTGRES_PASSWORD: "second",
    });
  });

  test("a value over 1024 UTF-8 bytes is dropped and counted; 1024 bytes is kept", () => {
    const result = projectEnv(
      [
        `POSTGRES_PASSWORD=${"a".repeat(1024)}`,
        `MYSQL_ROOT_PASSWORD=${"a".repeat(1025)}`,
        `KEYDB_PASSWORD=${String.fromCharCode(0xe9).repeat(512)}`,
        `REDIS_PASSWORD=${String.fromCharCode(0xe9).repeat(513)}`,
      ],
      ENV_ALLOW_LIST,
    );
    expect(result.dropped).toBe(2);
    expect(Object.keys(result.env)).toEqual(["POSTGRES_PASSWORD", "KEYDB_PASSWORD"]);
  });

  test("the bound applies to the value that wins, not to one it replaced", () => {
    expect(projectEnv([`POSTGRES_PASSWORD=${"a".repeat(2000)}`, "POSTGRES_PASSWORD=ok"], ENV_ALLOW_LIST)).toEqual({
      env: { POSTGRES_PASSWORD: "ok" },
      dropped: 0,
    });
  });

  test("no env list at all is an empty projection", () => {
    expect(projectEnv(undefined, ENV_ALLOW_LIST)).toEqual({ env: {}, dropped: 0 });
  });
});

describe("requirepassEnvOf - the one parsing rule", () => {
  test("the redis one-click template's exact command yields REDIS_PASSWORD", () => {
    expect(
      requirepassEnvOf({ Command: ["sh", "-c", "redis-server --requirepass $REDIS_PASSWORD"] }, ENV_ALLOW_LIST),
    ).toBe("REDIS_PASSWORD");
  });

  test.each([
    [{ Command: ["redis-server", "--requirepass", "${REDIS_PASSWORD}"] }],
    [{ Command: ["sh", "-c", 'redis-server --requirepass "$REDIS_PASSWORD"'] }],
    [{ Command: ["sh", "-c", "redis-server --requirepass '${REDIS_PASSWORD}'"] }],
    [{ Command: ["redis-server"], Args: ["--requirepass", "$REDIS_PASSWORD"] }],
    [{ Args: ["--requirepass", "$REDIS_PASSWORD", 7] }],
  ])("reads the variable name from %p", (containerSpec) => {
    expect(requirepassEnvOf(containerSpec, ENV_ALLOW_LIST)).toBe("REDIS_PASSWORD");
  });

  test.each([
    ["a literal password", { Command: ["redis-server", "--requirepass", "hunter2"] }],
    ["a variable outside the allow-list", { Command: ["sh", "-c", "redis-server --requirepass $APP_SECRET"] }],
    [
      "a longer name that starts like an allow-listed one",
      { Command: ["redis-server", "--requirepass", "$REDIS_PASSWORD_X"] },
    ],
    ["no command", {}],
    ["a command that is not a list", { Command: "redis-server --requirepass $REDIS_PASSWORD" }],
  ])("answers null for %s", (_label, containerSpec) => {
    expect(requirepassEnvOf(containerSpec, ENV_ALLOW_LIST)).toBeNull();
  });

  test("answers null when there is no container spec", () => {
    expect(requirepassEnvOf(undefined, ENV_ALLOW_LIST)).toBeNull();
  });
});

describe("selectServices", () => {
  const services = [
    dockerService({
      id: "s-pg",
      name: "pgtest",
      image: "postgres:16",
      env: ["POSTGRES_USER=postgres", "POSTGRES_PASSWORD=pg-secret", "POSTGRES_DB=appdb", "PGDATA=/var/lib/x"],
    }),
    dockerService({
      id: "s-redis",
      name: "srv-captain--cache",
      image: "redis:7",
      env: ["REDIS_PASSWORD=redis-secret"],
      command: ["sh", "-c", "redis-server --requirepass $REDIS_PASSWORD"],
      networks: [{ Target: "captain-overlay-network" }],
      status: { RunningTasks: 0, DesiredTasks: 1 },
    }),
    dockerService({ id: "s-nginx", name: "captain-nginx", image: "nginx:1" }),
    dockerService({ id: "s-studio", name: "studio", image: "ghcr.io/libredb/libredb-studio:0.18.0" }),
    dockerService({ id: "s-skip", name: "wordpress-db", image: "mysql:8", env: ["MYSQL_ROOT_PASSWORD=x"] }),
    dockerService({ id: "s-away", name: "elsewhere", image: "postgres:16", networks: [{ Target: "other-net" }] }),
    dockerService({ id: "s-web", name: "blog", image: "img-captain-blog:3", status: {} }),
    { ID: 7, Spec: { Name: "no-id" } },
    { ID: "no-spec" },
    // The three above fail two guards at once, so each guard hides the other. These two fail one guard each:
    // "nonet" has no network list (Swarm omits it for a service on no network), "numid" has a numeric ID.
    { ID: "x", Spec: { Name: "nonet" } },
    dockerService({ id: 7 as unknown as string, name: "numid", image: "redis:7" }),
    null,
  ];

  test("exports every non-system, non-Studio, non-excluded service on the network, sorted by name", () => {
    expect(selectServices(services, NETWORK, new Set(["wordpress-db"]))).toEqual({
      services: [
        {
          id: "s-web",
          name: "blog",
          appName: "blog",
          host: "srv-captain--blog",
          image: "img-captain-blog:3",
          env: {},
          requirepassEnv: null,
          tasks: { running: 0, desired: 0 },
        },
        {
          id: "s-pg",
          name: "pgtest",
          appName: "pgtest",
          host: "srv-captain--pgtest",
          image: "postgres:16",
          env: { POSTGRES_USER: "postgres", POSTGRES_PASSWORD: "pg-secret", POSTGRES_DB: "appdb" },
          requirepassEnv: null,
          tasks: { running: 1, desired: 1 },
        },
        {
          id: "s-redis",
          name: "srv-captain--cache",
          appName: "cache",
          host: "srv-captain--cache",
          image: "redis:7",
          env: { REDIS_PASSWORD: "redis-secret" },
          requirepassEnv: "REDIS_PASSWORD",
          tasks: { running: 0, desired: 1 },
        },
      ],
      excluded: ["wordpress-db"],
      droppedValues: 0,
      truncated: false,
    });
  });

  test("the exclude list matches the app name, so a legacy app is excluded by its short name", () => {
    const result = selectServices(services, NETWORK, new Set(["cache", "wordpress-db"]));
    expect(result.services.map((entry) => entry.appName)).toEqual(["blog", "pgtest"]);
    expect(result.excluded).toEqual(["cache", "wordpress-db"]);
  });

  test("excluded names only the apps the list left out, sorted and once each", () => {
    // Studio, a captain- service and a service on another network are skipped before the list is read,
    // so naming them in DISCOVERY_EXCLUDE does not report them; neither does a name no service carries.
    const result = selectServices(
      [
        dockerService({ id: "z", name: "zeta", image: "postgres:16" }),
        dockerService({ id: "a", name: "alpha", image: "redis:7" }),
        dockerService({ id: "m1", name: "srv-captain--mid", image: "mysql:8" }),
        dockerService({ id: "m2", name: "mid", image: "mysql:8" }),
        dockerService({ id: "st", name: "studio", image: "ghcr.io/libredb/libredb-studio:0.18.0" }),
        dockerService({ id: "sys", name: "captain-nginx", image: "nginx:1" }),
        dockerService({ id: "far", name: "faraway", image: "postgres:16", networks: [{ Target: "other-net" }] }),
        dockerService({ id: "k", name: "kept", image: "postgres:16" }),
      ],
      NETWORK,
      new Set(["zeta", "mid", "alpha", "studio", "captain-nginx", "faraway", "ghost"]),
    );
    expect(result.excluded).toEqual(["alpha", "mid", "zeta"]);
    expect(result.services.map((entry) => entry.name)).toEqual(["kept"]);
    expect(result.droppedValues).toBe(0);
  });

  test("more than 500 excluded apps lists the first 500 by name", () => {
    const names = Array.from({ length: 501 }, (_, index) => `app-${String(500 - index).padStart(3, "0")}`);
    const many = names.map((name, index) => dockerService({ id: `id-${index}`, name, image: "redis:7" }));
    const result = selectServices(many, NETWORK, new Set(names));
    expect(result.services).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.excluded).toHaveLength(500);
    expect(result.excluded[0]).toBe("app-000");
    expect(result.excluded[499]).toBe("app-499");
    expect(result.excluded).toEqual([...names].sort().slice(0, 500));
  });

  test("a service with no image, an empty image or an empty app name is left out and counted", () => {
    // Studio's schema refuses an empty image or appName for the whole file, so one odd service would
    // otherwise withdraw every discovered connection. A service named exactly "srv-captain--" has no app name.
    const bare = { ID: "s-bare", Spec: { Name: "bare", TaskTemplate: { Networks: [{ Target: NETWORK_ID }] } } };
    const result = selectServices(
      [
        bare,
        dockerService({ id: "s-blank", name: "blank", image: "" }),
        dockerService({ id: "s-prefix", name: "srv-captain--", image: "postgres:16" }),
        dockerService({ id: "s-pg", name: "pgtest", image: "postgres:16" }),
      ],
      NETWORK,
      new Set(),
    );
    expect(result.services.map((entry) => entry.id)).toEqual(["s-pg"]);
    expect(result.droppedValues).toBe(3);
    expect(result.excluded).toEqual([]);
  });

  test("a name, host or image over its bound leaves the service out and is counted, even when excluded", () => {
    const result = selectServices(
      [
        dockerService({ id: "n", name: "n".repeat(64), image: "postgres:16", networks: [{ Target: NETWORK_ID }] }),
        dockerService({
          id: "h",
          name: "hostly",
          image: "postgres:16",
          networks: [{ Target: NETWORK_ID, Aliases: [`srv-captain--${"h".repeat(241)}`] }],
        }),
        dockerService({ id: "i", name: "imagey", image: `${"i".repeat(510)}:16` }),
        dockerService({
          id: "ok",
          name: "n".repeat(63),
          image: `${"i".repeat(509)}:16`,
          networks: [{ Target: NETWORK_ID }],
        }),
        dockerService({
          id: "big",
          name: "bigenv",
          image: "postgres:16",
          env: [`POSTGRES_PASSWORD=${"x".repeat(1025)}`, "POSTGRES_USER=u"],
        }),
      ],
      NETWORK,
      // The bound checks run before the exclude list, so excluded never carries a name Studio would refuse.
      new Set(["n".repeat(64)]),
    );
    expect(result.services.map((entry) => entry.id)).toEqual(["big", "ok"]);
    expect(result.services[0].env).toEqual({ POSTGRES_USER: "u" });
    expect(result.droppedValues).toBe(4);
    expect(result.excluded).toEqual([]);
  });

  test("more than 500 services keeps the first 500 by name and says it truncated", () => {
    const many = Array.from({ length: 501 }, (_, index) =>
      dockerService({ id: `id-${index}`, name: `app-${String(500 - index).padStart(3, "0")}`, image: "redis:7" }),
    );
    const result = selectServices(many, NETWORK, new Set());
    expect(result.truncated).toBe(true);
    expect(result.services).toHaveLength(500);
    expect(result.services[0].name).toBe("app-000");
    expect(result.services[499].name).toBe("app-499");
  });

  test("exactly 500 is not truncated, and an answer that is not a list selects nothing", () => {
    const five = Array.from({ length: 500 }, (_, index) =>
      dockerService({ id: `id-${index}`, name: `app-${index}`, image: "redis:7" }),
    );
    expect(selectServices(five, NETWORK, new Set()).truncated).toBe(false);
    expect(selectServices({ message: "x" }, NETWORK, new Set())).toEqual({
      services: [],
      excluded: [],
      droppedValues: 0,
      truncated: false,
    });
  });
});

describe("buildExport", () => {
  const NOW = Date.parse("2026-10-04T12:00:10.000Z");
  const exported = [{ id: "s-pg", name: "pgtest" }];

  test("a successful scan carries its services, excluded apps, network and an ok status", () => {
    const data = buildExport({
      now: NOW,
      network: NETWORK,
      services: exported,
      excluded: ["wordpress-db"],
      status: { ok: true, code: "ignored" },
      generatedAt: "2026-10-04T12:00:00.000Z",
    });
    expect(data).toEqual({
      version: 1,
      platform: "caprover",
      generatedAt: "2026-10-04T12:00:00.000Z",
      checkedAt: "2026-10-04T12:00:10.000Z",
      status: { ok: true },
      network: { name: "captain-overlay-network", id: NETWORK_ID },
      services: exported,
      excluded: ["wordpress-db"],
    });
    // The file reads in the spec's order: excluded comes right after services.
    expect(Object.keys(data)).toEqual([
      "version",
      "platform",
      "generatedAt",
      "checkedAt",
      "status",
      "network",
      "services",
      "excluded",
    ]);
  });

  test("before the first successful listing, generatedAt is null and no service or excluded app is exported", () => {
    expect(
      buildExport({
        now: NOW,
        network: null,
        services: exported,
        excluded: ["wordpress-db"],
        status: { ok: false, code: "socket_unavailable", message: "no socket" },
        generatedAt: null,
      }),
    ).toEqual({
      version: 1,
      platform: "caprover",
      generatedAt: null,
      checkedAt: "2026-10-04T12:00:10.000Z",
      status: { ok: false, code: "socket_unavailable", message: "no socket" },
      network: null,
      services: [],
      excluded: [],
    });
  });

  test("an error status keeps its HTTP status and is clipped to 512 characters", () => {
    const data = buildExport({
      now: NOW,
      network: NETWORK,
      services: [],
      excluded: [],
      status: { ok: false, code: "swarm_unavailable", httpStatus: 503, message: "m".repeat(600) },
      generatedAt: null,
    });
    expect(data.status).toEqual({ ok: false, code: "swarm_unavailable", httpStatus: 503, message: "m".repeat(512) });
  });

  test("clipping never leaves half a surrogate pair at the end", () => {
    const message = `${"m".repeat(511)}\u{1F600}tail`;
    const data = buildExport({
      now: NOW,
      network: null,
      services: [],
      excluded: [],
      status: { ok: false, code: "docker_error", message },
      generatedAt: null,
    });
    expect(data.status).toEqual({ ok: false, code: "docker_error", message: "m".repeat(511) });
  });
});

describe("classifyDockerError", () => {
  test("503 is swarm_unavailable with the daemon's message verbatim", () => {
    const message =
      'This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.';
    expect(classifyDockerError(Object.assign(new Error(message), { statusCode: 503 }))).toEqual({
      ok: false,
      code: "swarm_unavailable",
      httpStatus: 503,
      message,
    });
  });

  test("400 is api_version, any other HTTP status is docker_error", () => {
    expect(
      classifyDockerError(Object.assign(new Error("client version 1.44 is too old"), { statusCode: 400 })),
    ).toEqual({
      ok: false,
      code: "api_version",
      httpStatus: 400,
      message: "client version 1.44 is too old",
    });
    expect(classifyDockerError(Object.assign(new Error(""), { statusCode: 500 }))).toEqual({
      ok: false,
      code: "docker_error",
      httpStatus: 500,
      message: "Docker answered HTTP 500",
    });
  });

  test.each([
    ["ENOENT", "the Docker socket is not mounted into this app"],
    ["EACCES", "the exporter is not running as root"],
    ["ECONNREFUSED", "the Docker daemon refused the connection"],
    ["ETIMEDOUT", "did not answer within 10000 ms"],
  ])("%s is socket_unavailable and names the likely cause", (code, cause) => {
    const status = classifyDockerError(Object.assign(new Error(`connect ${code} /var/run/docker.sock`), { code }));
    expect(status).toMatchObject({ ok: false, code: "socket_unavailable" });
    expect(JSON.stringify(status)).toContain(cause);
    expect(JSON.stringify(status)).toContain("/var/run/docker.sock");
    expect(JSON.stringify(status)).not.toContain("httpStatus");
  });

  test("an oversized answer is limit_exceeded, anything else is docker_error", () => {
    expect(classifyDockerError(Object.assign(new Error("too big"), { code: "ERESPONSETOOLARGE" }))).toEqual({
      ok: false,
      code: "limit_exceeded",
      message: "ERESPONSETOOLARGE (too big)",
    });
    expect(classifyDockerError(Object.assign(new Error("not JSON"), { code: "EBADJSON" }))).toEqual({
      ok: false,
      code: "docker_error",
      message: "EBADJSON (not JSON)",
    });
    expect(classifyDockerError(undefined)).toEqual({ ok: false, code: "docker_error", message: "unknown error" });
    expect(classifyDockerError("boom")).toEqual({ ok: false, code: "docker_error", message: "boom" });
  });

  test("a long daemon message is clipped to 512 characters", () => {
    const status = classifyDockerError(Object.assign(new Error("x".repeat(900)), { statusCode: 503 }));
    expect(JSON.stringify(status)).toContain(`"${"x".repeat(512)}"`);
    expect(JSON.stringify(status)).not.toContain("x".repeat(513));
  });
});

/*
  Everything below drives the exporter's I/O: a fake Docker Engine on a temp unix socket (node:http, as the
  exporter's own client is), real files in temp directories, and the real file run under `node`. Each test
  file runs in its own bun process (tests/run-tests.ts), so no other file's mock.module can reach the real
  sockets used here. Socket paths stay short (`<tmpdir>/dsk-XXXXXX/d.sock`) because macOS caps a unix
  socket path at 104 bytes and its tmpdir is long.
*/

const NOT_A_MANAGER =
  'This node is not a swarm manager. Use "docker swarm init" or "docker swarm join" to connect this node to swarm and try again.';
const NETWORKS_PATH = "/v1.44/networks?filters=%7B%22name%22%3A%5B%22captain-overlay-network%22%5D%7D";
const SERVICES_PATH = "/v1.44/services?status=true";
const NETWORKS_ANSWER = [
  { Name: "captain-overlay-network-2", Id: "decoy", Scope: "swarm" },
  { Name: "captain-overlay-network", Id: NETWORK_ID, Scope: "swarm" },
];
const SERVICES_ANSWER = [
  dockerService({
    id: "s-pg",
    name: "pgtest",
    image: "postgres:16",
    env: ["POSTGRES_USER=postgres", "POSTGRES_PASSWORD=pg-secret-value", "POSTGRES_DB=appdb"],
  }),
  dockerService({
    id: "s-web",
    name: "blog",
    image: "img-captain-blog:3",
    env: ["SECRET_KEY_BASE=app-secret-value", "REDIS_PASSWORD=redis-secret-value"],
  }),
];

type Reply = { status: number; body: string } | "hold";

interface FakeDocker {
  readonly socket: string;
  readonly seen: { method: string; url: string; host: string | undefined }[];
}

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  // Last in, first out: servers close before the directories that hold their sockets are removed.
  await cleanups
    .splice(0)
    .reverse()
    .reduce<Promise<unknown>>((chain, cleanup) => chain.then(cleanup), Promise.resolve());
});

function tempDir(prefix = "dsc-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function json(value: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(value) };
}

function healthyDocker(url: string): Reply {
  return url.startsWith("/v1.44/networks") ? json(NETWORKS_ANSWER) : json(SERVICES_ANSWER);
}

/** A fake Engine on a temp unix socket that records every request and answers through `reply`. */
async function fakeDocker(reply: (url: string) => Reply): Promise<FakeDocker> {
  const socket = join(tempDir("dsk-"), "d.sock");
  const seen: FakeDocker["seen"] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    seen.push({ method: request.method ?? "", url, host: request.headers.host });
    const answer = reply(url);
    if (answer === "hold") return;
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => resolve());
  });
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  return { socket, seen };
}

describeIf(MISSING_UNIX_SOCKETS, "createDockerClient - GET over the unix socket", () => {
  test("sends a GET with Host: docker and parses the JSON answer", async () => {
    const docker = await fakeDocker(() => json([{ ID: "x" }]));
    expect(await createDockerClient({ socket: docker.socket }).get("/v1.44/services")).toEqual([{ ID: "x" }]);
    expect(docker.seen).toEqual([{ method: "GET", url: "/v1.44/services", host: "docker" }]);
  });

  test("a non-2xx answer rejects with its status and the daemon's message", async () => {
    const docker = await fakeDocker(() => json({ message: NOT_A_MANAGER }, 503));
    await expect(createDockerClient({ socket: docker.socket }).get(SERVICES_PATH)).rejects.toMatchObject({
      statusCode: 503,
      message: NOT_A_MANAGER,
    });
  });

  test.each([
    ["an HTML page", "<html>bad gateway</html>"],
    ["an empty message", '{"message":""}'],
    ["a JSON null", "null"],
  ])("a non-2xx answer with %s says only the status", async (_label, body) => {
    const docker = await fakeDocker(() => ({ status: 502, body }));
    await expect(createDockerClient({ socket: docker.socket }).get(SERVICES_PATH)).rejects.toMatchObject({
      statusCode: 502,
      message: "Docker answered HTTP 502",
    });
  });

  test("a 2xx answer that is not JSON is refused with a fixed message that never quotes the body", async () => {
    // A JSON parser names the text it could not read (here: Unexpected identifier "pg_secret_value"), and a
    // services answer carries every app's environment. The message is logged and written to the export.
    const docker = await fakeDocker(() => ({ status: 200, body: '{"POSTGRES_PASSWORD":pg_secret_value}' }));
    await expect(createDockerClient({ socket: docker.socket }).get(SERVICES_PATH)).rejects.toMatchObject({
      code: "EBADJSON",
      message: `Docker answered GET ${SERVICES_PATH} with a body that is not JSON`,
    });
  });

  test("an answer over the byte cap is refused", async () => {
    const docker = await fakeDocker(() => json({ padding: "x".repeat(100) }));
    const client = createDockerClient({ socket: docker.socket, maxBytes: 10 });
    await expect(client.get(SERVICES_PATH)).rejects.toMatchObject({ code: "ERESPONSETOOLARGE" });
  });

  test("a daemon that never answers times out", async () => {
    const docker = await fakeDocker(() => "hold");
    const client = createDockerClient({ socket: docker.socket, timeoutMs: 50 });
    await expect(client.get(SERVICES_PATH)).rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  test("a socket that does not exist is ENOENT", async () => {
    const socket = join(tempDir(), "none.sock");
    await expect(createDockerClient({ socket }).get(SERVICES_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("abort ends every request in flight", async () => {
    const docker = await fakeDocker(() => "hold");
    const client = createDockerClient({ socket: docker.socket });
    const pending = client.get(SERVICES_PATH);
    await eventually(() => docker.seen.length === 1, "the request to reach the fake Engine");
    client.abort();
    await expect(pending).rejects.toMatchObject({ code: "EABORTED" });
  });

  test("a request function that throws rejects with its error", async () => {
    const request = () => {
      throw new Error("bad request options");
    };
    await expect(createDockerClient({ socket: "unused", request }).get(SERVICES_PATH)).rejects.toThrow(
      "bad request options",
    );
  });
});

describeIf(MISSING_UNIX_SOCKETS, "scanOnce - the two Engine calls", () => {
  test("asks for exactly two paths, in order, and exports what it selects", async () => {
    const docker = await fakeDocker(healthyDocker);
    const result = await scanOnce({ client: createDockerClient({ socket: docker.socket }), config: readConfig({}) });
    expect(docker.seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      `GET ${NETWORKS_PATH}`,
      `GET ${SERVICES_PATH}`,
    ]);
    expect(result).toEqual({ ok: true, network: NETWORK, ...selectServices(SERVICES_ANSWER, NETWORK, new Set()) });
  });

  test("the exclude list reaches the selection, and the left-out app is reported", async () => {
    const docker = await fakeDocker(healthyDocker);
    const result = await scanOnce({
      client: createDockerClient({ socket: docker.socket }),
      config: readConfig({ DISCOVERY_EXCLUDE: "blog" }),
    });
    expect(result).toEqual({
      ok: true,
      network: NETWORK,
      ...selectServices(SERVICES_ANSWER, NETWORK, new Set(["blog"])),
    });
    expect(result).toMatchObject({ ok: true, excluded: ["blog"] });
  });

  test("no exact network is network_not_found, and the services are never asked for", async () => {
    const docker = await fakeDocker(() => json([NETWORKS_ANSWER[0]]));
    const result = await scanOnce({ client: createDockerClient({ socket: docker.socket }), config: readConfig({}) });
    expect(result).toEqual({
      ok: false,
      status: { ok: false, code: "network_not_found", message: "no network is named exactly captain-overlay-network" },
    });
    expect(docker.seen).toHaveLength(1);
  });

  test("a node that is not a swarm manager is swarm_unavailable with the daemon's message", async () => {
    const docker = await fakeDocker(() => json({ message: NOT_A_MANAGER }, 503));
    const result = await scanOnce({ client: createDockerClient({ socket: docker.socket }), config: readConfig({}) });
    expect(result).toEqual({
      ok: false,
      status: { ok: false, code: "swarm_unavailable", httpStatus: 503, message: NOT_A_MANAGER },
    });
  });

  test("a services answer that is not a list is docker_error", async () => {
    const docker = await fakeDocker((url) =>
      url === SERVICES_PATH ? json({ message: "odd" }) : json(NETWORKS_ANSWER),
    );
    const result = await scanOnce({ client: createDockerClient({ socket: docker.socket }), config: readConfig({}) });
    expect(result).toEqual({
      ok: false,
      status: {
        ok: false,
        code: "docker_error",
        message: "Docker answered GET /services with something other than a list",
      },
    });
  });
});

const NOW = Date.parse("2026-10-04T12:00:00.000Z");

function injected(code = "EIO"): Error {
  return Object.assign(new Error("injected"), { code });
}

describeIf(MISSING_POSIX_FILE_MODES, "checkOutputDir - nobody else may write where root writes", () => {
  const uid = process.getuid?.();

  test("a 0755 directory owned by this process is accepted", () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    expect(checkOutputDir(dir, { fs: nodeFs, uid })).toEqual({ ok: true });
  });

  test("a directory owned by another uid is refused", () => {
    const dir = tempDir();
    const other = (uid ?? 0) + 1;
    expect(checkOutputDir(dir, { fs: nodeFs, uid: other })).toEqual({
      ok: false,
      reason: `${dir} is owned by uid ${uid}, not by this process (uid ${other})`,
    });
  });

  test.each([
    ["775", 0o775],
    ["757", 0o757],
  ])("a directory with mode %s is refused as group- or other-writable", (shown, mode) => {
    const dir = tempDir();
    chmodSync(dir, mode);
    expect(checkOutputDir(dir, { fs: nodeFs, uid })).toEqual({
      ok: false,
      reason: `${dir} is writable by group or others (mode ${shown})`,
    });
  });

  test("a file, or a link to a directory, is not a directory", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "file"), "");
    mkdirSync(join(dir, "real"), { mode: 0o755 });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(checkOutputDir(join(dir, "file"), { fs: nodeFs, uid })).toEqual({
      ok: false,
      reason: `${join(dir, "file")} is not a directory`,
    });
    expect(checkOutputDir(join(dir, "link"), { fs: nodeFs, uid })).toEqual({
      ok: false,
      reason: `${join(dir, "link")} is not a directory`,
    });
  });

  test("a directory that does not exist is refused with the reason", () => {
    const missing = join(tempDir(), "absent");
    const result = checkOutputDir(missing, { fs: nodeFs, uid });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain(`cannot read the output directory ${missing}: ENOENT`);
  });
});

describeIf(MISSING_POSIX_FILE_MODES, "writeExportAtomic - temp file, fchown, fsync, rename", () => {
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  function target() {
    const dir = tempDir();
    return { dir, path: join(dir, "services.json"), temp: join(dir, ".services.json.tmp") };
  }

  test("writes the content as mode 0600, owned as asked, and leaves no temp file", () => {
    const { dir, path } = target();
    writeExportAtomic(path, '{"version":1}', { fs: nodeFs, uid, gid });
    expect(readFileSync(path, "utf8")).toBe('{"version":1}');
    const stats = statSync(path);
    expect(stats.mode & 0o777).toBe(0o600);
    expect(stats.uid).toBe(uid);
    expect(stats.gid).toBe(gid);
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test("opens the temp file with exactly O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW and mode 0600", () => {
    // The leftover check runs first and hides both flags from every test that plants its link beforehand,
    // and O_NOFOLLOW changes nothing that can be observed while O_EXCL is there. So the call itself is pinned.
    const { path, temp } = target();
    const calls: unknown[][] = [];
    const fs = {
      ...nodeFs,
      openSync: (...args: Parameters<typeof nodeFs.openSync>) => {
        calls.push(args);
        return nodeFs.openSync(...args);
      },
    };
    writeExportAtomic(path, "{}", { fs, uid, gid });
    const { O_CREAT, O_EXCL, O_WRONLY, O_NOFOLLOW } = nodeFs.constants;
    expect(calls).toEqual([[temp, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600]]);
  });

  test("hands the owner to fchown on the descriptor, never to a path", () => {
    const { path } = target();
    const calls: unknown[][] = [];
    const fs = {
      ...nodeFs,
      fchownSync: (...args: unknown[]) => {
        calls.push(args);
      },
      chownSync: () => {
        throw new Error("chown by path must not be used");
      },
    };
    writeExportAtomic(path, "{}", { fs, uid: 1001, gid: 1001 });
    expect(calls).toEqual([[expect.any(Number), 1001, 1001]]);
  });

  test("a link planted at the temp path is removed, not followed", () => {
    const { dir, path, temp } = target();
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, temp);
    writeExportAtomic(path, "{}", { fs: nodeFs, uid, gid });
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(readdirSync(dir).sort()).toEqual(["services.json", "victim"]);
  });

  test("a dangling link at the temp path is removed and its target never created", () => {
    const { dir, path, temp } = target();
    const nowhere = join(dir, "nowhere");
    symlinkSync(nowhere, temp);
    writeExportAtomic(path, "{}", { fs: nodeFs, uid, gid });
    expect(existsSync(nowhere)).toBe(false);
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test("a link planted after the leftover check is refused by the open, and never followed", () => {
    // The race the open flags are there for: the temp path is free when it is checked, and a link sits on it
    // by the time it is opened. Nothing unlinks that link, so O_EXCL is all that stands in the way.
    const { dir, path, temp } = target();
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep");
    const fs = {
      ...nodeFs,
      lstatSync: () => {
        symlinkSync(victim, temp);
        throw injected("ENOENT");
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow("open: EEXIST");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(existsSync(path)).toBe(false);
  });

  test("a leftover temp file from a crash does not block the write", () => {
    const { dir, path, temp } = target();
    writeFileSync(temp, "half a file");
    writeExportAtomic(path, "{}", { fs: nodeFs, uid, gid });
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test("a failed rename leaves the previous file in place and removes the temp file", () => {
    const { dir, path } = target();
    writeFileSync(path, "previous");
    const fs = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error("EXDEV: cross-device link"), { code: "EXDEV" });
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow("rename: EXDEV: cross-device link");
    expect(readFileSync(path, "utf8")).toBe("previous");
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test.each([
    ["lstat", "lstatSync"],
    ["open", "openSync"],
    ["fchown", "fchownSync"],
    ["write", "writeFileSync"],
    ["fsync", "fsyncSync"],
  ])("a failure at %s names the step and keeps the previous file", (step, method) => {
    const { dir, path } = target();
    writeFileSync(path, "previous");
    const fs = {
      ...nodeFs,
      [method]: () => {
        throw injected();
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow(`${step}: EIO (injected)`);
    expect(readFileSync(path, "utf8")).toBe("previous");
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test("a failure at close names the step and keeps the previous file", () => {
    const { dir, path } = target();
    writeFileSync(path, "previous");
    const fs = {
      ...nodeFs,
      closeSync: (fd: number) => {
        nodeFs.closeSync(fd);
        throw injected();
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow("close: EIO (injected)");
    expect(readFileSync(path, "utf8")).toBe("previous");
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });

  test("a leftover that cannot be unlinked stops the write at unlink", () => {
    const { path, temp } = target();
    writeFileSync(temp, "half a file");
    const fs = {
      ...nodeFs,
      unlinkSync: () => {
        throw injected("EPERM");
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow("unlink: EPERM (injected)");
    expect(existsSync(path)).toBe(false);
  });

  test("a cleanup that fails too never hides the step that failed, and the next write recovers", () => {
    const { dir, path, temp } = target();
    const fs = {
      ...nodeFs,
      writeFileSync: () => {
        throw injected();
      },
      closeSync: (fd: number) => {
        nodeFs.closeSync(fd);
        throw new Error("close failed");
      },
      unlinkSync: () => {
        throw new Error("unlink failed");
      },
    };
    expect(() => writeExportAtomic(path, "{}", { fs, uid, gid })).toThrow("write: EIO (injected)");
    expect(existsSync(temp)).toBe(true);
    writeExportAtomic(path, "{}", { fs: nodeFs, uid, gid });
    expect(readdirSync(dir)).toEqual(["services.json"]);
  });
});

describe("serializeExport - the 2 MiB file bound", () => {
  function bulkyService(index: number) {
    return {
      id: `id-${index}`,
      name: `app-${String(index).padStart(3, "0")}`,
      appName: `app-${String(index).padStart(3, "0")}`,
      host: `srv-captain--app-${index}`,
      image: "postgres:16",
      env: Object.fromEntries(ENV_ALLOW_LIST.map((key) => [key, "v".repeat(1000)])),
      requirepassEnv: null,
      tasks: { running: 1, desired: 1 },
    };
  }

  /** The longest excluded list the exporter can write: 500 names of 63 characters. */
  const EXCLUDED = Array.from({ length: 500 }, (_, index) => `skip-${1000 + index}`.padEnd(63, "x"));

  function bulkyExport(status: Record<string, unknown>) {
    return buildExport({
      now: NOW,
      network: NETWORK,
      services: Array.from({ length: 500 }, (_, index) => bulkyService(index)),
      excluded: EXCLUDED,
      status,
      generatedAt: new Date(NOW).toISOString(),
    });
  }

  test("an export within the bound is plain JSON", () => {
    const data = buildExport({
      now: NOW,
      network: NETWORK,
      services: [],
      excluded: [],
      status: { ok: true },
      generatedAt: null,
    });
    expect(serializeExport(data)).toBe(JSON.stringify(data));
  });

  test("over the bound, the services that fit are kept in order and the status is limit_exceeded", () => {
    const data = bulkyExport({ ok: true });
    const text = serializeExport(data);
    const parsed = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(LIMITS.fileBytes);
    expect(parsed.status).toEqual({
      ok: false,
      code: "limit_exceeded",
      message: "the export would exceed 2097152 bytes; the rest was left out",
    });
    const kept = parsed.services.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(500);
    expect(parsed.services).toEqual(data.services.slice(0, kept));
    const oneMore = JSON.stringify({ ...parsed, services: data.services.slice(0, kept + 1) });
    expect(Buffer.byteLength(oneMore, "utf8")).toBeGreaterThan(LIMITS.fileBytes);
  });

  test("trimming the services keeps the whole excluded list, right after services", () => {
    const parsed = JSON.parse(serializeExport(bulkyExport({ ok: true })));
    expect(parsed.services.length).toBeLessThan(500);
    expect(parsed.excluded).toEqual(EXCLUDED);
    expect(Object.keys(parsed).slice(-2)).toEqual(["services", "excluded"]);
  });

  test("an error status keeps its own code when the services are cut", () => {
    const status = { ok: false, code: "socket_unavailable", message: "no socket" };
    const parsed = JSON.parse(serializeExport(bulkyExport(status)));
    expect(parsed.status).toEqual(status);
    expect(parsed.excluded).toEqual(EXCLUDED);
  });
});

const EXPORTER = join(import.meta.dir, "..", "..", "docker", "discover.mjs");
/** Secrets the fake Engine hands out: none may reach a log line; the non-allow-listed one not even the file. */
const SECRET_VALUES = ["pg-secret-value", "redis-secret-value", "app-secret-value"];

/** Every exporter variable, so nothing inherited from the developer's shell can change a run. */
function exporterEnv(socket: string, output: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DOCKER_SOCKET: socket,
    DISCOVERY_OUTPUT: output,
    DISCOVERY_NETWORK: "",
    DISCOVERY_EXCLUDE: "",
    DISCOVERY_INTERVAL_MS: "",
    DISCOVERY_ONCE: "",
    DISCOVERY_FILE_UID: String(process.getuid?.() ?? 0),
    DISCOVERY_FILE_GID: String(process.getgid?.() ?? 0),
    ...extra,
  };
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (chunk: string) => {
      out.push(chunk);
    },
    stderr: (chunk: string) => {
      err.push(chunk);
    },
  };
}

function readExport(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

describeIf(MISSING_UNIX_SOCKETS ?? MISSING_POSIX_FILE_MODES, "main - in process, every seam injected", () => {
  test("a configuration it cannot honour exits 2 before touching anything", async () => {
    const logs = capture();
    expect(await main({ env: { DISCOVERY_INTERVAL_MS: "5" }, stdout: logs.stdout, stderr: logs.stderr })).toBe(2);
    expect(logs.err).toEqual([
      'libredb-discovery: invalid configuration: DISCOVERY_INTERVAL_MS must be an integer of at least 2000, got "5"\n',
    ]);
    expect(logs.out).toEqual([]);
  });

  test("an output directory others can write exits 1 and writes nothing", async () => {
    const dir = tempDir();
    chmodSync(dir, 0o777);
    const logs = capture();
    const env = exporterEnv(join(dir, "none.sock"), join(dir, "services.json"), { DISCOVERY_ONCE: "1" });
    expect(await main({ env, stdout: logs.stdout, stderr: logs.stderr })).toBe(1);
    expect(logs.err).toEqual([
      `libredb-discovery: refusing to start: ${dir} is writable by group or others (mode 777)\n`,
    ]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("one scan writes the export, 0600, and logs counts but never a value", async () => {
    const docker = await fakeDocker(healthyDocker);
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const env = exporterEnv(docker.socket, output, { DISCOVERY_ONCE: "1" });
    expect(await main({ env, now: () => NOW, stdout: logs.stdout, stderr: logs.stderr })).toBe(0);

    expect(readExport(output)).toEqual({
      version: 1,
      platform: "caprover",
      generatedAt: "2026-10-04T12:00:00.000Z",
      checkedAt: "2026-10-04T12:00:00.000Z",
      status: { ok: true },
      network: { name: "captain-overlay-network", id: NETWORK_ID },
      services: selectServices(SERVICES_ANSWER, NETWORK, new Set()).services,
      excluded: [],
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(logs.out).toEqual([
      `libredb-discovery: watching captain-overlay-network every 10000 ms, writing ${output}\n`,
      "libredb-discovery: scan ok: 2 services exported, 0 values dropped\n",
    ]);
    expect(logs.err).toEqual([]);

    const file = readFileSync(output, "utf8");
    const logged = [...logs.out, ...logs.err].join("");
    expect(file).toContain("pg-secret-value");
    expect(file).toContain("redis-secret-value");
    expect(file).not.toContain("app-secret-value");
    for (const secret of SECRET_VALUES) expect(logged).not.toContain(secret);
  });

  test("before the first successful listing the file says why, and exports no service", async () => {
    const docker = await fakeDocker(() => json({ message: NOT_A_MANAGER }, 503));
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const env = exporterEnv(docker.socket, output, { DISCOVERY_ONCE: "1" });
    expect(await main({ env, now: () => NOW, stdout: logs.stdout, stderr: logs.stderr })).toBe(0);
    expect(readExport(output)).toEqual({
      version: 1,
      platform: "caprover",
      generatedAt: null,
      checkedAt: "2026-10-04T12:00:00.000Z",
      status: { ok: false, code: "swarm_unavailable", httpStatus: 503, message: NOT_A_MANAGER },
      network: null,
      services: [],
      excluded: [],
    });
    expect(logs.err).toEqual([`libredb-discovery: scan failed: swarm_unavailable: ${NOT_A_MANAGER}\n`]);
  });

  test("more than 500 services is still a listing, exported as limit_exceeded", async () => {
    const many = Array.from({ length: 501 }, (_, index) =>
      dockerService({ id: `id-${index}`, name: `app-${String(index).padStart(3, "0")}`, image: "redis:7" }),
    );
    const docker = await fakeDocker((url) => (url === SERVICES_PATH ? json(many) : json(NETWORKS_ANSWER)));
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const env = exporterEnv(docker.socket, output, { DISCOVERY_ONCE: "1" });
    expect(await main({ env, now: () => NOW, stdout: logs.stdout, stderr: logs.stderr })).toBe(0);
    const data = readExport(output);
    expect(data.generatedAt).toBe("2026-10-04T12:00:00.000Z");
    expect(data.status).toEqual({
      ok: false,
      code: "limit_exceeded",
      message: "more than 500 services on captain-overlay-network",
    });
    expect(data.services).toHaveLength(500);
    expect(logs.out[1]).toBe(
      "libredb-discovery: scan ok: 500 services exported, 0 values dropped, cut to the first 500 by name\n",
    );
  });

  test("a failed write is logged with its step, and once mode answers 1", async () => {
    const docker = await fakeDocker(healthyDocker);
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const fs = {
      ...nodeFs,
      renameSync: () => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      },
    };
    const env = exporterEnv(docker.socket, output, { DISCOVERY_ONCE: "1" });
    expect(await main({ env, fs, stdout: logs.stdout, stderr: logs.stderr })).toBe(1);
    expect(logs.err).toEqual(["libredb-discovery: write failed at rename: EROFS: read-only file system\n"]);
    expect(existsSync(output)).toBe(false);
  });

  test("an error after a good scan keeps its services and excluded apps; SIGTERM exits 0", async () => {
    let failing = false;
    const docker = await fakeDocker((url) => (failing ? json({ message: NOT_A_MANAGER }, 503) : healthyDocker(url)));
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const signals = new EventEmitter();
    let clock = NOW;
    let writes = 0;
    const fs = {
      ...nodeFs,
      renameSync: (from: string, to: string) => {
        nodeFs.renameSync(from, to);
        writes += 1;
      },
    };
    const env = exporterEnv(docker.socket, output, { DISCOVERY_INTERVAL_MS: "2000", DISCOVERY_EXCLUDE: "blog" });
    const running = main({ env, fs, now: () => clock, stdout: logs.stdout, stderr: logs.stderr, signals });

    await eventually(() => writes === 1, "the first export");
    const first = readExport(output);
    failing = true;
    clock = NOW + 2000;
    await eventually(() => writes === 3, "two failed scans after it", 8000);
    signals.emit("SIGTERM");
    expect(await running).toBe(0);

    expect(readExport(output)).toEqual({
      ...first,
      checkedAt: "2026-10-04T12:00:02.000Z",
      status: { ok: false, code: "swarm_unavailable", httpStatus: 503, message: NOT_A_MANAGER },
    });
    expect(first.generatedAt).toBe("2026-10-04T12:00:00.000Z");
    expect(first.services).toHaveLength(1);
    expect(first.excluded).toEqual(["blog"]);
    expect(first.network).toEqual({ name: "captain-overlay-network", id: NETWORK_ID });
    expect(logs.out).toEqual([
      `libredb-discovery: watching captain-overlay-network every 2000 ms, writing ${output}\n`,
      "libredb-discovery: scan ok: 1 services exported, 0 values dropped\n",
      "libredb-discovery: received SIGTERM, exiting\n",
    ]);
    expect(logs.err).toEqual([`libredb-discovery: scan failed: swarm_unavailable: ${NOT_A_MANAGER}\n`]);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  }, 15000);

  test("a network that disappears after a good scan writes network null and keeps the rest", async () => {
    // Spec section 8.5: network is null when no exact match was found, and the last good services,
    // excluded and generatedAt stay, so Studio keeps serving them until they turn stale.
    let vanished = false;
    const docker = await fakeDocker((url) =>
      vanished && url.startsWith("/v1.44/networks") ? json([NETWORKS_ANSWER[0]]) : healthyDocker(url),
    );
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const signals = new EventEmitter();
    let clock = NOW;
    let writes = 0;
    const fs = {
      ...nodeFs,
      renameSync: (from: string, to: string) => {
        nodeFs.renameSync(from, to);
        writes += 1;
      },
    };
    const env = exporterEnv(docker.socket, output, { DISCOVERY_INTERVAL_MS: "2000", DISCOVERY_EXCLUDE: "blog" });
    const running = main({ env, fs, now: () => clock, stdout: logs.stdout, stderr: logs.stderr, signals });

    await eventually(() => writes === 1, "the first export");
    const first = readExport(output);
    vanished = true;
    clock = NOW + 2000;
    await eventually(() => writes === 2, "the scan that finds no network", 5000);
    signals.emit("SIGTERM");
    expect(await running).toBe(0);

    expect(first.network).toEqual({ name: "captain-overlay-network", id: NETWORK_ID });
    expect(first.services.map((service: { name: string }) => service.name)).toEqual(["pgtest"]);
    expect(first.excluded).toEqual(["blog"]);
    expect(readExport(output)).toEqual({
      ...first,
      checkedAt: "2026-10-04T12:00:02.000Z",
      status: { ok: false, code: "network_not_found", message: "no network is named exactly captain-overlay-network" },
      network: null,
    });
    expect(logs.err).toEqual([
      "libredb-discovery: scan failed: network_not_found: no network is named exactly captain-overlay-network\n",
    ]);
  }, 10000);

  test("SIGINT while a request is in flight exits 0 at once and writes nothing", async () => {
    const docker = await fakeDocker(() => "hold");
    const output = join(tempDir(), "services.json");
    const logs = capture();
    const signals = new EventEmitter();
    const running = main({
      env: exporterEnv(docker.socket, output),
      stdout: logs.stdout,
      stderr: logs.stderr,
      signals,
    });
    await eventually(() => docker.seen.length === 1, "the first request");
    signals.emit("SIGINT");
    expect(await running).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(existsSync(output)).toBe(false);
    expect(logs.out.at(-1)).toBe("libredb-discovery: received SIGINT, exiting\n");
    expect(logs.err).toEqual([]);
  });
});

describeIf(MISSING_UNIX_SOCKETS ?? MISSING_POSIX_FILE_MODES, "running the exporter for real under node", () => {
  /** The child's exit code, or "still running" when it has not exited within `ms`: a bounded wait. */
  async function exitWithin(child: { readonly exited: Promise<number> }, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"still running">((resolve) => {
      timer = setTimeout(() => resolve("still running"), ms);
    });
    try {
      return await Promise.race([child.exited, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  test("one run against a missing socket writes the error status and exits 0", () => {
    const dir = tempDir();
    const output = join(dir, "services.json");
    const run = Bun.spawnSync(["node", EXPORTER], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...exporterEnv(join(dir, "missing.sock"), output, { DISCOVERY_ONCE: "1" }) },
    });
    expect(run.exitCode).toBe(0);
    const data = readExport(output);
    expect(data).toMatchObject({
      version: 1,
      platform: "caprover",
      generatedAt: null,
      network: null,
      services: [],
      excluded: [],
      status: { ok: false, code: "socket_unavailable" },
    });
    expect(data.status.message).toContain("the Docker socket is not mounted into this app");
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(run.stderr.toString()).toContain("libredb-discovery: scan failed: socket_unavailable: ");
  });

  // The two refusals below go through the entry guard, which alone turns main's answer into the exit code of
  // the process. DISCOVERY_ONCE is set so that a run which wrongly got past the check would end by itself,
  // and fail the test, instead of looping.
  test("a configuration it cannot honour exits 2 with the reason on stderr, and writes nothing", () => {
    const dir = tempDir();
    const run = Bun.spawnSync(["node", EXPORTER], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...exporterEnv(join(dir, "missing.sock"), join(dir, "services.json"), {
          DISCOVERY_INTERVAL_MS: "5",
          DISCOVERY_ONCE: "1",
        }),
      },
    });
    expect(run.exitCode).toBe(2);
    expect(run.stderr.toString()).toContain(
      'libredb-discovery: invalid configuration: DISCOVERY_INTERVAL_MS must be an integer of at least 2000, got "5"\n',
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("an output directory others can write exits 1 with the reason on stderr, and writes nothing", () => {
    const dir = tempDir();
    chmodSync(dir, 0o777);
    const run = Bun.spawnSync(["node", EXPORTER], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...exporterEnv(join(dir, "missing.sock"), join(dir, "services.json"), { DISCOVERY_ONCE: "1" }),
      },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stderr.toString()).toContain(
      `libredb-discovery: refusing to start: ${dir} is writable by group or others (mode 777)\n`,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test("SIGTERM stops a running exporter promptly with exit code 0", async () => {
    const docker = await fakeDocker(healthyDocker);
    const output = join(tempDir(), "services.json");
    const child = Bun.spawn(["node", EXPORTER], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...exporterEnv(docker.socket, output, { DISCOVERY_INTERVAL_MS: "2000" }) },
    });
    cleanups.push(() => child.kill("SIGKILL"));
    await eventually(() => existsSync(output), "the first export", 5000);
    const sent = Date.now();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect(Date.now() - sent).toBeLessThan(1500);
    expect(await new Response(child.stdout).text()).toContain("libredb-discovery: received SIGTERM, exiting");
  }, 10000);

  test("SIGTERM while a request is in flight aborts it: exit code 0 at once, and nothing written", async () => {
    // Left alone, the request keeps the process alive for its whole 10 s budget, which is Swarm's default
    // stop grace period, so a redeploy during a scan would end in SIGKILL. main's promise resolves either
    // way; only the process exiting shows that the request was aborted.
    const docker = await fakeDocker(() => "hold");
    const dir = tempDir();
    const child = Bun.spawn(["node", EXPORTER], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...exporterEnv(docker.socket, join(dir, "services.json")) },
    });
    cleanups.push(() => child.kill("SIGKILL"));
    await eventually(() => docker.seen.length === 1, "the first request to reach the fake Engine", 5000);
    child.kill("SIGTERM");
    expect(await exitWithin(child, 1500)).toBe(0);
    expect(docker.seen).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(await new Response(child.stdout).text()).toContain("libredb-discovery: received SIGTERM, exiting");
  }, 10000);
});

/** The guard that keeps an import inert; copied from bind-address.mjs, so it is pinned here too. */
describe("isDirectExecution", () => {
  const here = fileURLToPath(import.meta.url);
  const hereUrl = pathToFileURL(here).href;

  test("no argv[1] is never direct execution", () => {
    expect(isDirectExecution(undefined, hereUrl)).toBe(false);
    expect(isDirectExecution("", hereUrl)).toBe(false);
  });

  test("the module run as itself is direct execution, through its real path", () => {
    expect(isDirectExecution(here, pathToFileURL(realpathSync(here)).href)).toBe(true);
  });

  test("a different file is not", () => {
    expect(isDirectExecution(here, pathToFileURL(join(dirname(here), "other.mjs")).href)).toBe(false);
  });

  test("an argv[1] that cannot be resolved is not direct execution, and does not throw", () => {
    expect(isDirectExecution(join(tmpdir(), "libredb-discover-does-not-exist.mjs"), hereUrl)).toBe(false);
  });
});

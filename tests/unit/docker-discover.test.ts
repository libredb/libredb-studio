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
import { describe, expect, test } from "bun:test";
import {
  appNameOf,
  buildExport,
  classifyDockerError,
  DEFAULTS,
  ENV_ALLOW_LIST,
  hostOf,
  isStudioImage,
  LIMITS,
  parseExcludeList,
  projectEnv,
  readConfig,
  requirepassEnvOf,
  selectNetwork,
  selectServices,
} from "../../docker/discover.mjs";

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

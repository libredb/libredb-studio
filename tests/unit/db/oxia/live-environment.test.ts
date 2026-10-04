/**
 * The live Oxia fixtures in `database-compose.yml` and the files of `docker/oxia`, held to the rules of the Oxia
 * delivery design (SB3-5.1 to SB3-5.3).
 *
 * Every image is pinned by tag and digest, because a capture is a claim about one server build; every published port
 * is on 127.0.0.1, because the auth fixture's certificates and tokens are throwaway; every container is bounded; a
 * plain `up` starts one server and its seed, and no one-shot reaches a server of another profile; each server kind
 * has the healthcheck that was measured to pass on it. The seed is the Oxia CLI only, inside the Oxia image, so
 * `docker/oxia` holds no Node package and no lockfile, and no seeded value reaches the server's 64 MiB WAL segment.
 *
 * The third block holds `tests/live/oxia-seed-raw.ts`, the one file of the repository that writes to an Oxia server
 * (SB3-5.9): its fixed targets, the marker check before any write, its keys against the README's table, and that no
 * other `tests/live/oxia-*.ts` file names a write, nor keeps state under the system's temporary directory.
 *
 * Each rule is a pure function from the parsed fixtures to a list of findings, so it is proven both ways: the real
 * tree gives none, and a planted copy with one fault gives the finding that names it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { OXIA_DEFAULT_PORT } from "@/lib/db/providers/keyvalue/oxia/constants";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const OXIA_DIR = path.join(ROOT, "docker/oxia");

interface ComposeLimits {
  readonly cpus?: string;
  readonly memory?: string;
}

interface ComposeService {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly deploy?: { readonly resources?: { readonly limits?: ComposeLimits } };
  readonly memswap_limit?: string;
}

interface OxiaFixtures {
  /** The services whose name starts with "oxia". */
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes: Readonly<Record<string, unknown>>;
  /** docker/oxia/<name> to its text. */
  readonly files: Readonly<Record<string, string>>;
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function loadFixtures(): OxiaFixtures {
  // `merge: true` because the file shares a service's settings through `<<:` merge keys, which YAML 1.2 would
  // otherwise read as a key named "<<".
  const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
    readonly services: Readonly<Record<string, ComposeService>>;
    readonly volumes: Readonly<Record<string, unknown>>;
  };
  const services = Object.fromEntries(Object.entries(compose.services).filter(([name]) => name.startsWith("oxia")));
  const files = Object.fromEntries(
    readdirSync(OXIA_DIR).map((name) => [name, readFileSync(path.join(OXIA_DIR, name), "utf8")]),
  );
  return { services, volumes: compose.volumes, files };
}

/** A deep copy with one change, for the planted half of each rule. */
function planted(fixtures: OxiaFixtures, change: (draft: Mutable<OxiaFixtures>) => void): OxiaFixtures {
  const draft = structuredClone(fixtures) as Mutable<OxiaFixtures>;
  change(draft);
  return draft;
}

const IMAGE_016 = "oxia/oxia:0.16.10@sha256:da5133e862715b2ea03aada42593d0cb16b7b079bbba2035f82b870a3ccfb322";
const IMAGE_017 = "oxia/oxia:0.17.1@sha256:165bf4f3803153f23be3ba699f6430ab1463cdeaa46e341ff32c3eaed0d1b7d6";
const OPENSSL = "alpine/openssl:3.5.8@sha256:3f25da71f70eba788067daac3f3df03bd1de7a7c52ed89fa93b94ad2c92d986b";

type Kind = "standalone" | "cluster-server" | "coordinator" | "auth";

interface ServerRow {
  readonly profile?: string;
  readonly image: string;
  readonly port?: string;
  readonly kind: Kind;
  readonly memory: string;
}

interface OneShotRow {
  readonly profile?: string;
  readonly image: string;
  readonly waitsFor: Readonly<Record<string, string>>;
}

const SERVERS: Readonly<Record<string, ServerRow>> = {
  oxia: { image: IMAGE_016, port: `127.0.0.1:6648:${OXIA_DEFAULT_PORT}`, kind: "standalone", memory: "1G" },
  "oxia-natural": {
    profile: "oxia-natural",
    image: IMAGE_016,
    port: `127.0.0.1:6658:${OXIA_DEFAULT_PORT}`,
    kind: "standalone",
    memory: "512M",
  },
  "oxia-natural-blind": {
    profile: "oxia-natural",
    image: IMAGE_016,
    port: `127.0.0.1:6659:${OXIA_DEFAULT_PORT}`,
    kind: "standalone",
    memory: "256M",
  },
  "oxia-017": {
    profile: "oxia-017",
    image: IMAGE_017,
    port: `127.0.0.1:6668:${OXIA_DEFAULT_PORT}`,
    kind: "standalone",
    memory: "1G",
  },
  "oxia-auth": { profile: "oxia-auth", image: IMAGE_016, port: "127.0.0.1:6678:6678", kind: "auth", memory: "1G" },
  "oxia-cluster-coordinator": { profile: "oxia-cluster", image: IMAGE_016, kind: "coordinator", memory: "256M" },
  "oxia-cluster-1": {
    profile: "oxia-cluster",
    image: IMAGE_016,
    port: "127.0.0.1:6671:6671",
    kind: "cluster-server",
    memory: "512M",
  },
  "oxia-cluster-2": {
    profile: "oxia-cluster",
    image: IMAGE_016,
    port: "127.0.0.1:6672:6672",
    kind: "cluster-server",
    memory: "512M",
  },
  "oxia-cluster-3": {
    profile: "oxia-cluster",
    image: IMAGE_016,
    port: "127.0.0.1:6673:6673",
    kind: "cluster-server",
    memory: "512M",
  },
};

const ONE_SHOTS: Readonly<Record<string, OneShotRow>> = {
  "oxia-seed": { image: IMAGE_016, waitsFor: { oxia: "service_healthy" } },
  "oxia-natural-seed": {
    profile: "oxia-natural",
    image: IMAGE_016,
    waitsFor: { "oxia-natural": "service_healthy", "oxia-natural-blind": "service_healthy" },
  },
  "oxia-017-seed": { profile: "oxia-017", image: IMAGE_017, waitsFor: { "oxia-017": "service_healthy" } },
  "oxia-auth-certs": { profile: "oxia-auth", image: OPENSSL, waitsFor: {} },
};

const EXPECTED: Readonly<Record<string, ServerRow | OneShotRow>> = { ...SERVERS, ...ONE_SHOTS };

const STANDALONE_HEALTH = [
  "CMD",
  "oxia",
  "client",
  "-a",
  `localhost:${OXIA_DEFAULT_PORT}`,
  "--request-timeout",
  "3s",
  "list",
  "-s",
  "/",
  "-e",
  "/0",
];
const INTERNAL_HEALTH = ["CMD", "oxia", "health", "--host", "localhost", "--port", "6649", "--timeout", "3s"];
const COORDINATOR_HEALTH = ["CMD", "oxia", "health", "--host", "localhost", "--port", "6652", "--timeout", "3s"];
const HEALTH_BY_KIND: Readonly<Record<Kind, readonly string[]>> = {
  standalone: STANDALONE_HEALTH,
  "cluster-server": INTERNAL_HEALTH,
  auth: INTERNAL_HEALTH,
  coordinator: COORDINATOR_HEALTH,
};

const STANDALONE_COMMAND = [
  "oxia",
  "standalone",
  "--shards",
  "3",
  "--public-addr",
  `0.0.0.0:${OXIA_DEFAULT_PORT}`,
  "--metrics-addr",
  "0.0.0.0:8080",
  "--data-dir",
  "/data/db",
  "--wal-dir",
  "/data/wal",
];
const NATURAL_COMMAND = [
  ...STANDALONE_COMMAND.map((word, index) => (index === 3 ? "2" : word)),
  "--key-sorting",
  "natural",
];
const STANDALONE_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  oxia: STANDALONE_COMMAND,
  "oxia-017": STANDALONE_COMMAND,
  "oxia-natural": NATURAL_COMMAND,
  "oxia-natural-blind": NATURAL_COMMAND,
};

/** The data servers of the oxia-cluster profile, by service: the public port each advertises and publishes. */
const CLUSTER_SERVERS: Readonly<Record<string, number>> = {
  "oxia-cluster-1": 6671,
  "oxia-cluster-2": 6672,
  "oxia-cluster-3": 6673,
};

const AUTH_VOLUME = "oxia-auth-material";
const SCRIPTS_MOUNT = "./docker/oxia:/seed:ro";
const WAL_SEGMENT_BYTES = 64 * 1024 * 1024;
const OVER_CAP_BYTES = 17 * 1024 * 1024;

function only(fixtures: OxiaFixtures, name: string): ComposeService {
  return fixtures.services[name] ?? {};
}

function profileOf(service: ComposeService): string | undefined {
  return service.profiles?.[0];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function words(service: ComposeService): string {
  return [...(service.entrypoint ?? []), ...(service.command ?? [])].join(" ");
}

function limitsOf(service: ComposeService): ComposeLimits | undefined {
  return service.deploy?.resources?.limits;
}

// Rule 1.
function serviceSetFindings(fixtures: OxiaFixtures): string[] {
  const declared = Object.keys(fixtures.services);
  return [
    ...declared
      .filter((name) => !(name in EXPECTED))
      .map((name) => `${name} is an Oxia service the design does not name`),
    ...Object.keys(EXPECTED)
      .filter((name) => !declared.includes(name))
      .map((name) => `${name} is missing from database-compose.yml`),
  ];
}

// Rule 2.
function profileFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const [name, service] of Object.entries(fixtures.services)) {
    const expected = EXPECTED[name]?.profile;
    const wanted = expected === undefined ? undefined : [expected];
    if (!same(service.profiles, wanted))
      findings.push(
        `${name} has profiles ${JSON.stringify(service.profiles)}, the design gives ${JSON.stringify(wanted)}`,
      );
  }
  const plain = Object.keys(fixtures.services).filter((name) => fixtures.services[name].profiles === undefined);
  if (!same(plain.sort(), ["oxia", "oxia-seed"])) findings.push(`a plain up starts ${plain.join(", ")}`);
  return findings;
}

// Rule 3.
function containerNameFindings(fixtures: OxiaFixtures): string[] {
  return Object.entries(fixtures.services)
    .filter(([name, service]) => service.container_name !== `libredb-${name}`)
    .map(([name, service]) => `${name} is named ${service.container_name}, not libredb-${name}`);
}

// Rule 4.
function imageFindings(fixtures: OxiaFixtures): string[] {
  return Object.entries(EXPECTED)
    .filter(([name, row]) => only(fixtures, name).image !== row.image)
    .map(([name, row]) => `${name} runs ${only(fixtures, name).image}, the design pins ${row.image}`);
}

// Rule 5.
function portFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const [name, service] of Object.entries(fixtures.services)) {
    const port = SERVERS[name]?.port;
    const wanted = port === undefined ? undefined : [port];
    if (!same(service.ports, wanted))
      findings.push(`${name} publishes ${JSON.stringify(service.ports)}, the design gives ${JSON.stringify(wanted)}`);
  }
  return findings;
}

// Rule 6.
function oneShotScopeFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const name of Object.keys(ONE_SHOTS)) {
    const service = only(fixtures, name);
    const reached = [
      ...Object.keys(service.depends_on ?? {}),
      ...[...words(service).matchAll(/\b(oxia[a-z0-9-]*):\d+\b/g)].map((match) => match[1]),
    ];
    for (const target of reached) {
      const targetService = fixtures.services[target];
      if (targetService === undefined || profileOf(targetService) !== profileOf(service))
        findings.push(`${name} reaches ${target}, a service outside its own profile`);
    }
  }
  return findings;
}

// Rule 7.
function boundFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const [name, service] of Object.entries(fixtures.services)) {
    const limits = limitsOf(service);
    if (typeof limits?.cpus !== "string") findings.push(`${name} has no CPU bound`);
    if (typeof limits?.memory !== "string") findings.push(`${name} has no memory bound`);
    if (service.memswap_limit !== limits?.memory)
      findings.push(`${name} swaps past its memory bound (memswap_limit ${service.memswap_limit})`);
    const memory = SERVERS[name]?.memory;
    if (memory !== undefined && limits?.memory !== memory)
      findings.push(`${name} is bounded at ${limits?.memory}, the design gives ${memory}`);
  }
  return findings;
}

// Rule 8.
function healthcheckFindings(fixtures: OxiaFixtures): string[] {
  return Object.entries(SERVERS)
    .filter(([name, row]) => !same(only(fixtures, name).healthcheck?.test, HEALTH_BY_KIND[row.kind]))
    .map(([name, row]) => `${name} does not run the ${row.kind} healthcheck`);
}

// Rule 9.
function oneShotWaitFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const [name, row] of Object.entries(ONE_SHOTS)) {
    const service = only(fixtures, name);
    if (service.restart !== "no") findings.push(`${name} restarts (${service.restart})`);
    const waits = Object.fromEntries(
      Object.entries(service.depends_on ?? {}).map(([needed, { condition }]) => [needed, condition]),
    );
    if (!same(waits, row.waitsFor)) findings.push(`${name} waits for ${JSON.stringify(waits)}`);
  }
  return findings;
}

// Rule 10.
function standaloneCommandFindings(fixtures: OxiaFixtures): string[] {
  return Object.entries(STANDALONE_COMMANDS)
    .filter(([name, command]) => !same(only(fixtures, name).command, command))
    .map(([name]) => `${name} runs ${JSON.stringify(only(fixtures, name).command)}`);
}

interface ClusterYaml {
  readonly namespaces?: readonly unknown[];
  readonly servers?: readonly { readonly public?: string; readonly internal?: string }[];
}

const CLUSTER_NAMESPACES = [{ name: "default", initialShardCount: 3, replicationFactor: 1 }];

/** The word after `-p` in a server's command, for an exec form or a shell script alike. */
function publicListener(service: ComposeService): string | undefined {
  return / -p (\S+)/.exec(` ${words(service)}`)?.[1];
}

// Rule 11.
function clusterPortFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  const cluster = parseYaml(fixtures.files["cluster.yaml"] ?? "") as ClusterYaml | null;
  const auth = parseYaml(fixtures.files["cluster-auth.yaml"] ?? "") as ClusterYaml | null;
  if (!same(cluster?.namespaces, CLUSTER_NAMESPACES)) findings.push("cluster.yaml declares other namespaces");
  if (!same(auth?.namespaces, CLUSTER_NAMESPACES)) findings.push("cluster-auth.yaml declares other namespaces");
  const expectedCluster = Object.entries(CLUSTER_SERVERS).map(([name, port]) => ({
    public: `127.0.0.1:${port}`,
    internal: `${name}:6649`,
  }));
  if (!same(cluster?.servers, expectedCluster))
    findings.push(`cluster.yaml advertises ${JSON.stringify(cluster?.servers)}`);
  // The auth fixture advertises the name its certificate is issued for (R27), so a dial of `localhost` is not
  // leader-refused; a run that dials 127.0.0.1 lists localhost:6678 under its data servers.
  if (!same(auth?.servers, [{ public: "localhost:6678", internal: "localhost:6649" }]))
    findings.push(`cluster-auth.yaml advertises ${JSON.stringify(auth?.servers)}`);
  const advertised: [string, number][] = [...Object.entries(CLUSTER_SERVERS), ["oxia-auth", 6678]];
  for (const [name, port] of advertised) {
    const service = only(fixtures, name);
    if (!same(service.ports, [`127.0.0.1:${port}:${port}`]))
      findings.push(`${name} publishes ${JSON.stringify(service.ports)}, not the advertised port ${port}`);
    if (publicListener(service) !== `0.0.0.0:${port}`)
      findings.push(`${name} listens on ${publicListener(service)}, not the advertised port ${port}`);
  }
  if (!words(only(fixtures, "oxia-cluster-coordinator")).includes("--cconfig /seed/cluster.yaml "))
    findings.push("oxia-cluster-coordinator does not read /seed/cluster.yaml");
  if (!words(only(fixtures, "oxia-auth")).includes("--cconfig /seed/cluster-auth.yaml "))
    findings.push("oxia-auth does not read /seed/cluster-auth.yaml");
  return findings;
}

// Rule 12.
function authVolumeFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  if (!(AUTH_VOLUME in fixtures.volumes)) findings.push(`${AUTH_VOLUME} is not declared`);
  const expected: Readonly<Record<string, string>> = {
    "oxia-auth-certs": `${AUTH_VOLUME}:/certs`,
    "oxia-auth": `${AUTH_VOLUME}:/certs:ro`,
  };
  for (const [name, service] of Object.entries(fixtures.services)) {
    const mounts = (service.volumes ?? []).filter((mount) => mount.startsWith(`${AUTH_VOLUME}:`));
    const wanted = expected[name] === undefined ? [] : [expected[name]];
    if (!same(mounts, wanted)) findings.push(`${name} mounts ${JSON.stringify(mounts)}`);
  }
  const waits = only(fixtures, "oxia-auth").depends_on?.["oxia-auth-certs"]?.condition;
  if (waits !== "service_completed_successfully") findings.push(`oxia-auth waits for oxia-auth-certs by ${waits}`);
  return findings;
}

// Rule 13.
function scriptFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const name of Object.keys(ONE_SHOTS)) {
    const service = only(fixtures, name);
    if (!(service.volumes ?? []).includes(SCRIPTS_MOUNT)) findings.push(`${name} does not mount ${SCRIPTS_MOUNT}`);
    const scripts = [...words(service).matchAll(/\/seed\/([A-Za-z0-9._-]+)/g)].map((match) => match[1]);
    if (scripts.length === 0) findings.push(`${name} runs no script of docker/oxia`);
    for (const script of scripts)
      if (!(script in fixtures.files)) findings.push(`${name} runs /seed/${script}, which docker/oxia does not hold`);
  }
  return findings;
}

// Rule 14.
function secretFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const [name, text] of Object.entries(fixtures.files)) {
    if (/\.(pem|crt|key|csr|jwt|srl)$/.test(name)) findings.push(`docker/oxia/${name} is a certificate, key or token`);
    if (text.includes("-----BEGIN")) findings.push(`docker/oxia/${name} holds a PEM block`);
    if (/eyJ[A-Za-z0-9_-]{10,}\./.test(text)) findings.push(`docker/oxia/${name} holds a JWT`);
  }
  return findings;
}

const LOCKFILES = new Set([
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

// Rule 15.
function nodeFindings(fixtures: OxiaFixtures): string[] {
  return [
    ...Object.keys(fixtures.files)
      .filter((name) => LOCKFILES.has(name))
      .map((name) => `docker/oxia/${name} is a Node package file`),
    ...Object.entries(fixtures.services)
      .filter(([, service]) => /\bnode\b/.test(service.image ?? ""))
      .map(([name, service]) => `${name} runs the Node image ${service.image}`),
  ];
}

/** Every byte count seed.sh passes to its pattern helper. */
function patternSizes(seed: string): number[] {
  return [...seed.matchAll(/\bpattern (\d+)\b/g)].map((match) => Number(match[1]));
}

// Rule 16.
function walBoundFindings(fixtures: OxiaFixtures): string[] {
  const sizes = patternSizes(fixtures.files["seed.sh"] ?? "");
  const findings = sizes
    .filter((size) => size >= WAL_SEGMENT_BYTES)
    .map((size) => `seed.sh writes a value of ${size} bytes, at or past the server's 64 MiB WAL segment`);
  if (Math.max(...sizes) !== OVER_CAP_BYTES) findings.push(`the largest seeded value is ${Math.max(...sizes)} bytes`);
  return findings;
}

/** Asserts that a rule finds nothing on the real tree. */
function clean(findings: readonly string[]): void {
  expect(findings).toEqual([]);
}

/** Asserts that one finding names every needle. */
function finds(findings: readonly string[], ...needles: string[]): void {
  expect({ findings, named: findings.some((finding) => needles.every((needle) => finding.includes(needle))) }).toEqual({
    findings,
    named: true,
  });
}

const real = loadFixtures();

describe("the live Oxia fixtures in database-compose.yml", () => {
  test("the Oxia services are exactly the fixtures and one-shots the design names", () => {
    clean(serviceSetFindings(real));
    const extra = planted(real, (draft) => {
      draft.services["oxia-extra"] = { image: IMAGE_016 };
    });
    finds(serviceSetFindings(extra), "oxia-extra");
  });

  test("a plain up starts exactly oxia and oxia-seed", () => {
    clean(profileFindings(real));
    const unprofiled = planted(real, (draft) => {
      delete draft.services["oxia-017"].profiles;
    });
    finds(profileFindings(unprofiled), "oxia-017");
    finds(profileFindings(unprofiled), "a plain up starts", "oxia-017");
  });

  test("every container is named libredb-<service>", () => {
    clean(containerNameFindings(real));
    const renamed = planted(real, (draft) => {
      draft.services["oxia-natural"].container_name = "oxia-natural";
    });
    finds(containerNameFindings(renamed), "oxia-natural is named oxia-natural");
  });

  test("every server image is pinned by tag and digest, every helper image by digest", () => {
    clean(imageFindings(real));
    const undigested = planted(real, (draft) => {
      draft.services.oxia.image = "oxia/oxia:0.16.10";
    });
    finds(imageFindings(undigested), "oxia runs oxia/oxia:0.16.10,");
    const wrongLine = planted(real, (draft) => {
      draft.services["oxia-017"].image = IMAGE_016;
    });
    finds(imageFindings(wrongLine), "oxia-017 runs", IMAGE_016);
  });

  test("every published port is on 127.0.0.1, and no one-shot publishes any", () => {
    clean(portFindings(real));
    const open = planted(real, (draft) => {
      draft.services.oxia.ports = ["6648:6648"];
    });
    finds(portFindings(open), "oxia publishes", "6648:6648");
    const oneShot = planted(real, (draft) => {
      draft.services["oxia-seed"].ports = ["127.0.0.1:6690:6690"];
    });
    finds(portFindings(oneShot), "oxia-seed publishes");
  });

  test("no one-shot depends on, or names in its command, a service outside its own profile", () => {
    clean(oneShotScopeFindings(real));
    const crossing = planted(real, (draft) => {
      draft.services["oxia-seed"].entrypoint = ["sh", "/seed/seed.sh", "oxia-natural:6648", "full"];
    });
    finds(oneShotScopeFindings(crossing), "oxia-seed", "oxia-natural");
    const waiting = planted(real, (draft) => {
      draft.services["oxia-017-seed"].depends_on = { oxia: { condition: "service_healthy" } };
    });
    finds(oneShotScopeFindings(waiting), "oxia-017-seed reaches oxia,");
  });

  test("every container is bounded in CPU and memory, with no swap past the memory bound", () => {
    clean(boundFindings(real));
    const swapping = planted(real, (draft) => {
      delete draft.services["oxia-cluster-2"].memswap_limit;
    });
    finds(boundFindings(swapping), "oxia-cluster-2 swaps");
    const larger = planted(real, (draft) => {
      const limits = draft.services.oxia.deploy?.resources?.limits;
      if (limits === undefined) throw new Error("oxia has no limits");
      limits.memory = "2G";
      draft.services.oxia.memswap_limit = "2G";
    });
    finds(boundFindings(larger), "oxia is bounded at 2G");
    const unbounded = planted(real, (draft) => {
      delete draft.services["oxia-auth-certs"].deploy;
    });
    finds(boundFindings(unbounded), "oxia-auth-certs has no CPU bound");
    finds(boundFindings(unbounded), "oxia-auth-certs has no memory bound");
  });

  test("every server has the healthcheck its kind takes", () => {
    clean(healthcheckFindings(real));
    const standaloneOnCluster = planted(real, (draft) => {
      draft.services["oxia-cluster-1"].healthcheck = { test: [...STANDALONE_HEALTH] };
    });
    finds(healthcheckFindings(standaloneOnCluster), "oxia-cluster-1 does not run the cluster-server healthcheck");
    const internalOnStandalone = planted(real, (draft) => {
      draft.services.oxia.healthcheck = { test: [...INTERNAL_HEALTH] };
    });
    finds(healthcheckFindings(internalOnStandalone), "oxia does not run the standalone healthcheck");
  });

  test("every one-shot waits for service_healthy and never restarts", () => {
    clean(oneShotWaitFindings(real));
    const restarting = planted(real, (draft) => {
      draft.services["oxia-natural-seed"].restart = "unless-stopped";
    });
    finds(oneShotWaitFindings(restarting), "oxia-natural-seed restarts");
    const started = planted(real, (draft) => {
      draft.services["oxia-seed"].depends_on = { oxia: { condition: "service_started" } };
    });
    finds(oneShotWaitFindings(started), "oxia-seed waits for", "service_started");
  });

  test("the standalone servers take the command the design gives", () => {
    clean(standaloneCommandFindings(real));
    const hierarchical = planted(real, (draft) => {
      draft.services["oxia-natural-blind"].command = NATURAL_COMMAND.slice(0, -2);
    });
    finds(standaloneCommandFindings(hierarchical), "oxia-natural-blind runs");
    const sorted = planted(real, (draft) => {
      draft.services.oxia.command = [...STANDALONE_COMMAND, "--key-sorting", "natural"];
    });
    finds(standaloneCommandFindings(sorted), "oxia runs", "--key-sorting");
  });

  test("each cluster YAML's public port equals the published host port and the container port", () => {
    clean(clusterPortFindings(real));
    const advertised = planted(real, (draft) => {
      draft.files["cluster.yaml"] = draft.files["cluster.yaml"].replace("127.0.0.1:6672", "127.0.0.1:6680");
    });
    finds(clusterPortFindings(advertised), "cluster.yaml advertises", "127.0.0.1:6680");
    const published = planted(real, (draft) => {
      draft.services["oxia-cluster-1"].ports = ["127.0.0.1:6681:6671"];
    });
    finds(clusterPortFindings(published), "oxia-cluster-1 publishes", "6681");
    const authAdvertised = planted(real, (draft) => {
      draft.files["cluster-auth.yaml"] = draft.files["cluster-auth.yaml"].replace(
        "public: localhost:6678",
        "public: 127.0.0.1:6678",
      );
    });
    finds(clusterPortFindings(authAdvertised), "cluster-auth.yaml advertises");
    const listener = planted(real, (draft) => {
      draft.services["oxia-cluster-3"].command = ["oxia", "server", "-p", "0.0.0.0:6648"];
    });
    finds(clusterPortFindings(listener), "oxia-cluster-3 listens on 0.0.0.0:6648");
  });

  test("the auth material lives in a named volume that only the certificate one-shot writes", () => {
    clean(authVolumeFindings(real));
    const mounted = planted(real, (draft) => {
      draft.services.oxia.volumes = [`${AUTH_VOLUME}:/certs:ro`];
    });
    finds(authVolumeFindings(mounted), "oxia mounts", AUTH_VOLUME);
    const writable = planted(real, (draft) => {
      draft.services["oxia-auth"].volumes = [`${AUTH_VOLUME}:/certs`, SCRIPTS_MOUNT];
    });
    finds(authVolumeFindings(writable), "oxia-auth mounts");
    const undeclared = planted(real, (draft) => {
      delete draft.volumes[AUTH_VOLUME];
    });
    finds(authVolumeFindings(undeclared), `${AUTH_VOLUME} is not declared`);
    const early = planted(real, (draft) => {
      draft.services["oxia-auth"].depends_on = { "oxia-auth-certs": { condition: "service_started" } };
    });
    finds(authVolumeFindings(early), "oxia-auth waits for oxia-auth-certs by service_started");
  });

  test("every one-shot runs a script of docker/oxia that exists, mounted read-only", () => {
    clean(scriptFindings(real));
    const missing = planted(real, (draft) => {
      draft.services["oxia-017-seed"].entrypoint = ["sh", "/seed/missing.sh", "oxia-017:6648", "full"];
    });
    finds(scriptFindings(missing), "oxia-017-seed runs /seed/missing.sh");
    const writable = planted(real, (draft) => {
      draft.services["oxia-seed"].volumes = ["./docker/oxia:/seed"];
    });
    finds(scriptFindings(writable), "oxia-seed does not mount");
  });

  test("no certificate, key or token is committed under docker/oxia", () => {
    clean(secretFindings(real));
    const certificate = planted(real, (draft) => {
      draft.files["ca.crt"] = "";
    });
    finds(secretFindings(certificate), "docker/oxia/ca.crt");
    const token = planted(real, (draft) => {
      draft.files["README.md"] += "\neyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln\n";
    });
    finds(secretFindings(token), "README.md holds a JWT");
    const pem = planted(real, (draft) => {
      draft.files["certs.sh"] += "\n-----BEGIN PRIVATE KEY-----\n";
    });
    finds(secretFindings(pem), "certs.sh holds a PEM block");
  });

  test("docker/oxia holds no package.json and no lockfile, and no Oxia service uses a Node image", () => {
    clean(nodeFindings(real));
    const packaged = planted(real, (draft) => {
      draft.files["package.json"] = "{}";
    });
    finds(nodeFindings(packaged), "docker/oxia/package.json");
    const node = planted(real, (draft) => {
      draft.services["oxia-seed"].image = `node:24-slim@sha256:${"0".repeat(64)}`;
    });
    finds(nodeFindings(node), "oxia-seed runs the Node image");
  });

  test("no seeded value reaches the server's 64 MiB WAL segment", () => {
    clean(walBoundFindings(real));
    expect(Math.max(...patternSizes(real.files["seed.sh"]))).toBe(OVER_CAP_BYTES);
    const reaching = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(`pattern ${OVER_CAP_BYTES}`, "pattern 67108864");
    });
    finds(walBoundFindings(reaching), "67108864 bytes");
  });
});

type SeedSet = "full" | "small" | "blind";
const SETS: readonly SeedSet[] = ["full", "small", "blind"];
const MARKER = "/libredb-fixture/seeded";
const RAW_WRITER = "tests/live/oxia-seed-raw.ts";

interface Write {
  readonly key: string;
  readonly value?: string;
  readonly partition?: string;
  /** The index of the script line that writes it. */
  readonly line: number;
}

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** The bytes of a printf format with only `\t` and three-digit octal escapes, decoded as UTF-8. */
function printfText(format: string): string {
  const bytes: number[] = [];
  for (const [, octal, tab, plain] of format.matchAll(/\\([0-7]{3})|(\\t)|([^\\]+)/g)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else if (tab !== undefined) bytes.push(9);
    else bytes.push(...utf8.encode(plain));
  }
  return strictUtf8.decode(Uint8Array.from(bytes));
}

const QUOTED = String.raw`'([^']*)'|"([^"$\\` + "`" + String.raw`]*)"`;

/** A single-quoted literal, or a double-quoted one with no expansion or escape left in it. */
function literal(single: string | undefined, double: string | undefined): string {
  return single ?? double ?? "";
}

/** One write call of seed.sh, by forms 1 to 3 of the task's line grammar, or undefined. */
function parseWrite(text: string, line: number): Write | undefined {
  const put = new RegExp(`^put (?:${QUOTED}) (?:${QUOTED})$`).exec(text);
  if (put !== null) return { key: literal(put[1], put[2]), value: literal(put[3], put[4]), line };
  const empty = new RegExp(`^put_empty (?:${QUOTED})$`).exec(text);
  if (empty !== null) return { key: literal(empty[1], empty[2]), value: "", line };
  const stdin = /^.+ \| put_stdin '([^']*)'$/.exec(text);
  if (stdin !== null) return { key: stdin[1], line };
  const partitioned = new RegExp(`^put_p (?:${QUOTED}) (?:${QUOTED}) (?:${QUOTED})$`).exec(text);
  if (partitioned !== null)
    return {
      partition: literal(partitioned[1], partitioned[2]),
      key: literal(partitioned[3], partitioned[4]),
      value: literal(partitioned[5], partitioned[6]),
      line,
    };
  const escaped = /^put "\$\(printf '([^'%]*)'\)" '([^']*)'$/.exec(text);
  if (escaped !== null) return { key: printfText(escaped[1]), value: escaped[2], line };
  const long = /^put "\/odd\/long\/\$\(pattern (\d+) \| tr x k\)" '([^']*)'$/.exec(text);
  if (long !== null) return { key: `/odd/long/${"k".repeat(Number(long[1]))}`, value: long[2], line };
  return undefined;
}

/** The lines of a shell function `<name>() { ... }`, without blank lines and comments. */
function functionLines(seed: string, name: string): string[] {
  const found = new RegExp(String.raw`^${name}\(\) \{\n([\s\S]*?)^\}`, "m").exec(seed);
  if (found === null) throw new Error(`seed.sh has no function ${name}`);
  return found[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

/** Every write of one set, in order, by the line grammar of seed.sh; a line that matches no form throws. */
function writes(seed: string, set: SeedSet): Write[] {
  const found: Write[] = [];
  functionLines(seed, `seed_${set}`).forEach((text, line) => {
    if (text.startsWith("wipe ")) return;
    const loop = /^for i in ([^;]+); do (.+); done$/.exec(text);
    const counted =
      /^i=0; while \[ "\$i" -lt (\d+) \]; do put "\$\(printf -- '([^']*)' "\$i"\)" '([^']*)'; i=\$\(\(i \+ 1\)\); done$/.exec(
        text,
      );
    if (loop !== null) {
      for (const word of loop[1].split(" ")) {
        const write = parseWrite(loop[2].replaceAll("$i", word), line);
        if (write === undefined) throw new Error(`seed.sh: a loop body matches no write form: ${text}`);
        found.push(write);
      }
    } else if (counted !== null) {
      const [, count, format, value] = counted;
      const width = /^(.*)%0(\d)d$/.exec(format);
      if (width === null) throw new Error(`seed.sh: a counted loop with an unread format: ${text}`);
      for (let i = 0; i < Number(count); i++)
        found.push({ key: width[1] + String(i).padStart(Number(width[2]), "0"), value, line });
    } else {
      const write = parseWrite(text, line);
      if (write === undefined) throw new Error(`seed.sh: a line of seed_${set} matches no write form: ${text}`);
      found.push(write);
    }
  });
  return found;
}

/** The distinct keys one set writes, in the order of their first write. */
function seededKeys(seed: string, set: SeedSet): string[] {
  return [...new Set(writes(seed, set).map((write) => write.key))];
}

interface ReadmeRow {
  readonly keys: readonly string[];
  readonly writer: string;
}

interface ReadmeSet {
  readonly stated: { readonly total: number; readonly seed: number; readonly raw: number } | undefined;
  readonly rows: readonly ReadmeRow[];
}

function count(text: string): number {
  return Number(text.replaceAll(",", ""));
}

/** The bytes of a hex list, `00 0a`, as one character each. */
function hexBytes(hex: string): number[] {
  return (hex.replace(/\s/g, "").match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16));
}

/** The keys one key cell of the README's table names. */
function cellKeys(cell: string): string[] {
  const family = /^`([^`]+?)(\d+)` to `([^`]+?)(\d+)`, [\d,]+ keys$/.exec(cell);
  if (family !== null) {
    const [, prefix, first, , last] = family;
    const keys: string[] = [];
    for (let i = Number(first); i <= Number(last); i++) keys.push(prefix + String(i).padStart(first.length, "0"));
    return keys;
  }
  const repeated = /^`([^`]+)` followed by ([\d,]+) `(.)`$/.exec(cell);
  if (repeated !== null) return [repeated[1] + repeated[3].repeat(count(repeated[2]))];
  const withBytes = /^`([^`]+)` followed by the bytes `([0-9a-f ]+)`(?: and `([^`]+)`)?$/.exec(cell);
  if (withBytes !== null) {
    const [, before, hex, after] = withBytes;
    return [
      strictUtf8.decode(Uint8Array.from([...utf8.encode(before), ...hexBytes(hex), ...utf8.encode(after ?? "")])),
    ];
  }
  const plain = /^`([^`]+)`$/.exec(cell);
  if (plain !== null) return [plain[1]];
  throw new Error(`README: a key cell in no form: ${cell}`);
}

/** The table of one set under `## The seeded keys`, and the counts the sentence before it states. */
function readmeSet(readme: string, set: SeedSet): ReadmeSet {
  const heading = `### ${set}\n`;
  const start = readme.indexOf(heading);
  if (start === -1) throw new Error(`README has no section ${heading}`);
  const rest = readme.slice(start + heading.length);
  const end = rest.search(/^##/m);
  const section = end === -1 ? rest : rest.slice(0, end);
  const sentence = new RegExp(
    `^\`${set}\` holds ([\\d,]+) keys: ([\\d,]+) from \`seed\\.sh\` and ([\\d,]+) from \`tests/live/oxia-seed-raw\\.ts\`\\.$`,
    "m",
  ).exec(section);
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const cells = line.split(" | ").map((cell) => cell.replace(/^\| /, "").replace(/ \|$/, ""));
      return { keys: cellKeys(cells[0]), writer: cells[2]?.replaceAll("`", "") ?? "" };
    });
  return {
    stated:
      sentence === null ? undefined : { total: count(sentence[1]), seed: count(sentence[2]), raw: count(sentence[3]) },
    rows,
  };
}

function keysBy(set: ReadmeSet, writer: string): string[] {
  return set.rows.filter((row) => row.writer === writer).flatMap((row) => row.keys);
}

// Rule 17.
function keyTableFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  const seed = fixtures.files["seed.sh"];
  for (const set of SETS) {
    const all = writes(seed, set);
    const lines = new Map<string, Set<number>>();
    for (const write of all) lines.set(write.key, (lines.get(write.key) ?? new Set()).add(write.line));
    for (const [key, where] of lines)
      if (where.size > 1) findings.push(`seed.sh writes ${JSON.stringify(key)} of ${set} on ${where.size} lines`);
    const table = readmeSet(fixtures.files["README.md"], set);
    for (const row of table.rows)
      if (row.writer !== "seed.sh" && row.writer !== RAW_WRITER)
        findings.push(`the ${set} row ${JSON.stringify(row.keys[0])} names the writer ${row.writer}`);
    const seeded = seededKeys(seed, set);
    const listed = keysBy(table, "seed.sh");
    if (!same([...listed].sort(), [...seeded].sort()))
      findings.push(`the README's ${set} table does not name the keys seed.sh writes`);
    const raw = keysBy(table, RAW_WRITER);
    const rows = { total: listed.length + raw.length, seed: listed.length, raw: raw.length };
    if (!same(table.stated, rows))
      findings.push(
        `the README states ${JSON.stringify(table.stated)} for ${set}, its rows hold ${JSON.stringify(rows)}`,
      );
    if (new Set([...listed, ...raw]).size !== rows.total) findings.push(`the README's ${set} table names a key twice`);
  }
  return findings;
}

const BULK_KEYS = Array.from({ length: 20_000 }, (_, i) => `/bulk/key-${String(i).padStart(5, "0")}`);
const NUL_KEYS = ["/nul/a\u0000b", "/nul/\u0000", "a\u0000"];
const RAW_KEYS: Readonly<Record<SeedSet, readonly string[]>> = {
  full: [...NUL_KEYS, ...BULK_KEYS],
  small: NUL_KEYS,
  blind: [],
};

// Rule 18.
function rawKeyFindings(fixtures: OxiaFixtures): string[] {
  return SETS.filter((set) => {
    const raw = keysBy(readmeSet(fixtures.files["README.md"], set), RAW_WRITER);
    return !same([...raw].sort(), [...RAW_KEYS[set]].sort());
  }).map((set) => `the README's ${set} table does not name the raw seeder's keys`);
}

const SPEC_KEYS = [
  // Pulsar subtree with empty parents (OxiaMetadataStore.createParents)
  "/admin",
  "/admin/policies",
  "/admin/policies/public",
  "/admin/policies/public/default",
  "/admin/clusters",
  "/admin/clusters/standalone",
  "/admin/partitioned-topics",
  "/admin/partitioned-topics/public",
  "/admin/partitioned-topics/public/default",
  "/admin/partitioned-topics/public/default/persistent",
  "/admin/partitioned-topics/public/default/persistent/orders",
  "/managed-ledgers",
  "/managed-ledgers/public",
  "/managed-ledgers/public/default",
  "/managed-ledgers/public/default/persistent",
  "/managed-ledgers/public/default/persistent/orders-partition-0",
  "/managed-ledgers/public/default/persistent/orders-partition-1",
  "/managed-ledgers/public/default/persistent/orders-partition-2",
  "/loadbalance",
  "/loadbalance/brokers",
  "/loadbalance/brokers/broker-1:8080",
  "/ledgers",
  "/ledgers/LAYOUT",
  "/ledgers/available",
  "/ledgers/available/bookie-1:3181",
  "/schemas",
  "/schemas/public",
  "/schemas/public/default",
  "/schemas/public/default/orders",
  // the orphan subtree: no parent keys
  "/orphan/a/b/c/leaf-1",
  "/orphan/a/b/c/leaf-2",
  "/orphan/x/y",
  // ordering probes
  "/a",
  "/a/b",
  "/a/b/c",
  "/a/bb",
  "/a/b/",
  "/a/c",
  "/ab",
  "/b",
  "/b/c",
  "/a/b/c/d",
  "/z",
  // keys ending in //
  "/trail//",
  "/trail/x//",
  "/odd//",
  // flat keys
  "config",
  "feature-flag.dark-mode",
  "user:42",
  "zz-last-flat",
  // odd keys
  "/odd/with space",
  "/odd/100%",
  "/odd/tab\tkey",
  '/odd/"quoted"',
  "/odd/back\\slash",
  "/odd/emoji-\u{1F642}",
  "/odd/max-\u{10FFFF}",
  `/odd/long/${"k".repeat(4000)}`,
  // values
  "/values/json",
  "/values/json-int64",
  "/values/text-utf8",
  "/values/text-c0",
  "/values/binary-non-utf8",
  "/values/protobuf-like",
  "/values/empty",
  "/values/text-100KiB",
  "/values/pattern-5MiB",
  "/values/pattern-5MiB-b",
  "/values/over-cap",
  "/versions/counter",
  "/pk/tenant-a/1",
  "/pk/tenant-a/2",
  "/pk/tenant-a/3",
  MARKER,
];
const SMALL_KEYS = [
  "/a",
  "/a/b",
  "/a/b/c",
  "/a/bb",
  "/a/b/",
  "/a/c",
  "/ab",
  "/b",
  "/b/c",
  "/a/b/c/d",
  "/z",
  "/trail//",
  "/trail/x//",
  "/odd//",
  "config",
  "feature-flag.dark-mode",
  "user:42",
  "zz-last-flat",
  "-dash",
  ".dot",
  "!bang",
  MARKER,
];
const BLIND_KEYS = [
  ...Array.from({ length: 600 }, (_, i) => `-k${String(i).padStart(4, "0")}`),
  "-a/b",
  "-a/bb",
  "-a/c",
  ".b/x",
  MARKER,
];
const ORPHAN_PARENTS = ["/orphan", "/orphan/a", "/orphan/a/b", "/orphan/a/b/c", "/orphan/x"];

// Rule 19.
function keyClassFindings(fixtures: OxiaFixtures): string[] {
  const seed = fixtures.files["seed.sh"];
  const full = new Set(seededKeys(seed, "full"));
  const small = new Set(seededKeys(seed, "small"));
  return [
    ...SPEC_KEYS.filter((key) => !full.has(key)).map((key) => `full does not seed ${JSON.stringify(key)}`),
    ...SMALL_KEYS.filter((key) => !small.has(key)).map((key) => `small does not seed ${JSON.stringify(key)}`),
    ...ORPHAN_PARENTS.filter((key) => full.has(key)).map((key) => `full seeds the orphan's parent ${key}`),
    ...(same(seededKeys(seed, "blind"), BLIND_KEYS) ? [] : ["blind is not the blind-spot keyset"]),
  ];
}

// Rule 20.
function markerFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const set of SETS) {
    const all = writes(fixtures.files["seed.sh"], set);
    const last = all.at(-1);
    if (last?.key !== MARKER || last.value !== set) findings.push(`the last write of ${set} is not the marker ${set}`);
    if (all.filter((write) => write.key === MARKER).length !== 1)
      findings.push(`${set} writes the marker more than once`);
  }
  return findings;
}

const WIPES: Readonly<Record<SeedSet, string>> = {
  full: String.raw`wipe "$(printf '/%.0s' $(seq 1 201))~"`,
  small: String.raw`wipe "$(printf '\364\217\277\277')"`,
  blind: String.raw`wipe "$(printf '\364\217\277\277')"`,
};

// Rule 21.
function wipeFindings(fixtures: OxiaFixtures): string[] {
  const seed = fixtures.files["seed.sh"];
  const findings: string[] = [];
  for (const set of SETS) {
    const lines = functionLines(seed, `seed_${set}`);
    if (lines[0] !== WIPES[set]) findings.push(`seed_${set} does not begin with its wipe`);
    // `writes` passes over a wipe line, so a second wipe would delete keys the table still lists.
    if (lines.slice(1).some((line) => line.startsWith("wipe "))) findings.push(`seed_${set} wipes again after a write`);
    for (const key of seededKeys(seed, set).filter((name) => name.startsWith("__oxia/")))
      findings.push(`${set} writes the internal key ${key}`);
  }
  return findings;
}

// Rule 22.
function versionAndPartitionFindings(fixtures: OxiaFixtures): string[] {
  const all = writes(fixtures.files["seed.sh"], "full");
  const findings: string[] = [];
  const counter = all.filter((write) => write.key === "/versions/counter").map((write) => write.value);
  if (!same(counter, ["v1", "v2", "v3", "v4", "v5"]))
    findings.push(`/versions/counter is written ${counter.length} times`);
  for (const write of all.filter((entry) => entry.key.startsWith("/pk/")))
    if (write.partition !== "tenant-a") findings.push(`${write.key} is written without -p tenant-a`);
  return findings;
}

const VERSION_NOTE =
  "An Oxia 0.16 standalone server (measured on 0.16.10) stops sending shard assignments to every client after one request whose authority is not `host:port`, which Studio never sends, until restarted (upstream #1450, about standalone mode only). 0.17.1 is not affected; fixed on main by #1450, in no 0.16 release as of 2026-10-04.";

const HEADINGS = [
  "## The services",
  "## Bringing them up",
  "## The seeded keys",
  "## Healthchecks",
  "## Certificates and tokens",
  "## Server versions",
];
const HOST_PORTS = ["6648", "6658", "6659", "6668", "6671", "6672", "6673", "6678"];
const PROFILES = ["oxia-natural", "oxia-017", "oxia-auth", "oxia-cluster"];

// Rule 24.
function readmeNameFindings(fixtures: OxiaFixtures): string[] {
  const readme = fixtures.files["README.md"];
  const lines = readme.split("\n");
  return [
    ...[...Object.keys(EXPECTED), ...HOST_PORTS, ...PROFILES]
      .filter((name) => !readme.includes(`\`${name}\``) && !readme.includes(`:${name}`))
      .map((name) => `the README does not name ${name}`),
    ...HEADINGS.filter((heading) => !lines.includes(heading)).map((heading) => `the README has no ${heading}`),
  ];
}

const VOLUME_FILES = [
  "ca.crt",
  "server.crt",
  "server.key",
  "client.crt",
  "client.key",
  "other-ca.crt",
  "jwt.key",
  "jwt.pub",
  "jwt-wrong.key",
  "token.jwt",
  "token-expired.jwt",
  "token-bad-signature.jwt",
  "token-bad-audience.jwt",
  "token-bad-issuer.jwt",
  ".complete",
];

/** The files certs.sh writes: the literal outputs of openssl, mint and touch, and `<name>.crt` and `.key` of a ca or issue call. */
function certsOutputs(certs: string): Set<string> {
  const outputs = new Set<string>();
  for (const [, name] of certs.matchAll(/(?:-out|-keyout|>|touch|mint) ?([A-Za-z0-9._-]+)(?=\s|$)/gm))
    outputs.add(name);
  for (const [, name] of certs.matchAll(/^(?:ca|issue) ([A-Za-z0-9-]+) /gm)) {
    outputs.add(`${name}.crt`);
    outputs.add(`${name}.key`);
  }
  return outputs;
}

// Rule 25.
function certsFindings(fixtures: OxiaFixtures): string[] {
  const certs = fixtures.files["certs.sh"];
  const outputs = certsOutputs(certs);
  return [
    ...VOLUME_FILES.filter((name) => !outputs.has(name)).map((name) => `certs.sh does not write ${name}`),
    ...(certs.includes("subjectAltName=DNS:localhost,IP:127.0.0.1\n") ? [] : ["certs.sh has another server SAN"]),
    ...(/^set -eu\ncd "\$1"\n\[ -f \.complete \] && \{ .*; exit 0; \}$/m.test(certs)
      ? []
      : ["certs.sh does not begin with the .complete guard"]),
    ...(/^chmod 644 /m.test(certs) ? [] : ["certs.sh leaves a file unreadable to the host-side tools"]),
  ];
}

const WAL_WORDS = ["poison", "corrupt", "restart the shard", "invalid next offset", "segment is full"];

// Rule 26.
function walWordingFindings(fixtures: OxiaFixtures): string[] {
  const findings: string[] = [];
  for (const name of ["README.md", "seed.sh"]) {
    const text = fixtures.files[name];
    if (!text.includes("64 MiB WAL segment")) findings.push(`${name} does not name the 64 MiB WAL segment`);
    for (const word of WAL_WORDS)
      if (text.toLowerCase().includes(word)) findings.push(`${name} words the WAL bound with "${word}"`);
  }
  return findings;
}

describe("the scripts and the README of docker/oxia", () => {
  test("seed.sh writes each key of a set once, the README's table names the same keys with their writer, and the counts match", () => {
    clean(keyTableFindings(real));
    const fullRows = readmeSet(real.files["README.md"], "full");
    expect(fullRows.stated?.raw).toBe(20_003);
    const dropped = planted(real, (draft) => {
      draft.files["README.md"] = draft.files["README.md"].replace(/^\| `\/z` \|.*\n/m, "");
    });
    finds(keyTableFindings(dropped), "the README's full table does not name the keys seed.sh writes");
    const miscounted = planted(real, (draft) => {
      draft.files["README.md"] = draft.files["README.md"].replace(/^`small` holds (\d+)/m, "`small` holds 999");
    });
    finds(keyTableFindings(miscounted), "the README states", "for small");
    const twice = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(
        "put '/libredb-fixture/seeded' 'blind'",
        "put '-a/b' 'v'\n  put '/libredb-fixture/seeded' 'blind'",
      );
    });
    finds(keyTableFindings(twice), 'seed.sh writes "-a/b" of blind on 2 lines');
    expect(() => writes(real.files["seed.sh"].replace("put '-a/b' 'v'", "put -- '-a/b' 'v'"), "blind")).toThrow(
      "matches no write form",
    );
  });

  test("the README's table names the keys the raw seeder writes", () => {
    clean(rawKeyFindings(real));
    const dropped = planted(real, (draft) => {
      draft.files["README.md"] = draft.files["README.md"].replace(
        "| `a` followed by the bytes `00` |",
        "| `a` followed by the bytes `01` |",
      );
    });
    finds(rawKeyFindings(dropped), "full table does not name the raw seeder's keys");
  });

  test("every key class of SB3-5.2 is seeded", () => {
    clean(keyClassFindings(real));
    const orphaned = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(
        "put '/orphan/x/y'",
        "put_empty '/orphan/x'\n  put '/orphan/x/y'",
      );
    });
    finds(keyClassFindings(orphaned), "full seeds the orphan's parent /orphan/x");
    const noTab = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(String.raw`/odd/tab\tkey`, "/odd/tab-key");
    });
    finds(keyClassFindings(noTab), String.raw`full does not seed "/odd/tab\tkey"`);
  });

  test("the marker is written last in every set, with the set name as its value", () => {
    clean(markerFindings(real));
    const first = planted(real, (draft) => {
      const seed = draft.files["seed.sh"].replace("  put '/libredb-fixture/seeded' 'small'\n", "");
      draft.files["seed.sh"] = seed.replace(
        "seed_small() {\n",
        "seed_small() {\n  put '/libredb-fixture/seeded' 'small'\n",
      );
    });
    finds(markerFindings(first), "the last write of small is not the marker small");
  });

  test("seed.sh wipes before it writes, and never writes under __oxia/", () => {
    clean(wipeFindings(real));
    const late = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(
        "seed_blind() {\n",
        "seed_blind() {\n  put 'early' 'v'\n",
      );
    });
    finds(wipeFindings(late), "seed_blind does not begin with its wipe");
    const again = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace(
        "  put '-a/b' 'v'\n",
        `  ${WIPES.blind}\n  put '-a/b' 'v'\n`,
      );
    });
    finds(wipeFindings(again), "seed_blind wipes again after a write");
    const internal = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace("put 'config'", "put '__oxia/config'");
    });
    finds(wipeFindings(internal), "full writes the internal key __oxia/config");
  });

  test("/versions/counter is written five times, and the partition-key keys carry -p tenant-a", () => {
    clean(versionAndPartitionFindings(real));
    const fewer = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace("for i in 1 2 3 4 5; do", "for i in 1 2 3; do");
    });
    finds(versionAndPartitionFindings(fewer), "/versions/counter is written 3 times");
    const unpartitioned = planted(real, (draft) => {
      draft.files["seed.sh"] = draft.files["seed.sh"].replace("put_p 'tenant-a'", "put_p 'tenant-b'");
    });
    finds(versionAndPartitionFindings(unpartitioned), "/pk/tenant-a/1 is written without -p tenant-a");
  });

  test("the README quotes the 0.16 standalone version note word for word", () => {
    expect(real.files["README.md"]).toContain(VERSION_NOTE);
    expect(real.files["README.md"]).toContain(`${VERSION_NOTE}\nRecommended: 0.17.1.`);
  });

  test("the README names every service, port and profile, and the six headings", () => {
    clean(readmeNameFindings(real));
    const unnamed = planted(real, (draft) => {
      draft.files["README.md"] = draft.files["README.md"].replaceAll("oxia-cluster-coordinator", "the coordinator");
    });
    finds(readmeNameFindings(unnamed), "the README does not name oxia-cluster-coordinator");
    const heading = planted(real, (draft) => {
      draft.files["README.md"] = draft.files["README.md"].replace("## Healthchecks\n", "## Health\n");
    });
    finds(readmeNameFindings(heading), "the README has no ## Healthchecks");
  });

  test("certs.sh writes every file the fixtures and the live tools read, and nothing is world-secret", () => {
    clean(certsFindings(real));
    const noIssuer = planted(real, (draft) => {
      draft.files["certs.sh"] = draft.files["certs.sh"].replace(/^mint token-bad-issuer\.jwt .*\n/m, "");
    });
    finds(certsFindings(noIssuer), "certs.sh does not write token-bad-issuer.jwt");
    const san = planted(real, (draft) => {
      draft.files["certs.sh"] = draft.files["certs.sh"].replace(
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
        "subjectAltName=DNS:localhost\n",
      );
    });
    finds(certsFindings(san), "certs.sh has another server SAN");
    const unguarded = planted(real, (draft) => {
      draft.files["certs.sh"] = draft.files["certs.sh"].replace(/^\[ -f \.complete \].*\n/m, "");
    });
    finds(certsFindings(unguarded), "certs.sh does not begin with the .complete guard");
  });

  test("no repository file under docker/oxia words the WAL bound beyond its size", () => {
    clean(walWordingFindings(real));
    const worded = planted(real, (draft) => {
      draft.files["README.md"] += `\n${WAL_WORDS[1].toUpperCase()}\n`;
    });
    finds(walWordingFindings(worded), "README.md words the WAL bound", "corrupt");
  });
});

// -- tests/live/oxia-seed-raw.ts, the one writer (SB3-5.3, SB3-5.9) ----------------------------------------------------

const LIVE_DIR = path.join(ROOT, "tests/live");
const SEEDER = "oxia-seed-raw.ts";

/** tests/live/oxia-*.ts by file name, and the README of docker/oxia: what the writer's rules read. */
interface LiveFiles {
  readonly live: Readonly<Record<string, string>>;
  readonly readme: string;
}

function loadLiveFiles(): LiveFiles {
  const live = Object.fromEntries(
    readdirSync(LIVE_DIR)
      .filter((name) => name.startsWith("oxia-") && name.endsWith(".ts"))
      .map((name) => [name, readFileSync(path.join(LIVE_DIR, name), "utf8")]),
  );
  return { live, readme: real.files["README.md"] };
}

function plantedLive(files: LiveFiles, change: (draft: Mutable<LiveFiles>) => void): LiveFiles {
  const draft = structuredClone(files) as Mutable<LiveFiles>;
  change(draft);
  return draft;
}

/** The seeder's text, or the finding that it is missing. */
function seederText(files: LiveFiles): string | undefined {
  return files.live[SEEDER];
}

/** A file's code with every comment removed, as the TypeScript printer writes it. */
function codeOf(name: string, text: string): string {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  return ts.createPrinter({ removeComments: true }).printFile(source);
}

const SEED_TARGETS: Readonly<Record<string, { readonly marker: SeedSet; readonly bulk: boolean }>> = {
  "127.0.0.1:6648": { marker: "full", bulk: true },
  "127.0.0.1:6658": { marker: "small", bulk: false },
};
const TARGETS_TABLE = /^const TARGETS = \{\n([\s\S]*?)\n\} as const;$/m;
const TARGET_ROW = /^ {2}"([^"]+)": \{ marker: "(\w+)", bulk: (true|false) \},?$/;
const HOST_PORT = /\b(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|\[[0-9a-f:]+\]):\d+\b/gi;
const MISSING_SEEDER = `tests/live/${SEEDER} is missing`;

/** The TARGETS table's rows, or undefined when the file holds no table in that form. */
function targetsTable(text: string): Record<string, { marker: string; bulk: boolean }> | undefined {
  const table = TARGETS_TABLE.exec(text);
  if (table === null) return undefined;
  const rows: Record<string, { marker: string; bulk: boolean }> = {};
  for (const line of table[1].split("\n")) {
    const row = TARGET_ROW.exec(line);
    if (row === null) return undefined;
    rows[row[1]] = { marker: row[2], bulk: row[3] === "true" };
  }
  return rows;
}

// Rule 27.
function seederTargetFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  const findings: string[] = [];
  const table = targetsTable(text);
  if (table === undefined) findings.push("the raw seeder holds no TARGETS table in the fixed form");
  else if (!same(table, SEED_TARGETS)) findings.push(`the raw seeder's TARGETS are ${JSON.stringify(table)}`);
  for (const literal of new Set(text.match(HOST_PORT) ?? []))
    if (!Object.hasOwn(SEED_TARGETS, literal)) findings.push(`the raw seeder names the address ${literal}`);
  if (/2664\d/.test(text)) findings.push("the raw seeder names a shared probe port");
  return findings;
}

const REFUSAL_SENTENCE = "is not a compose fixture; this script writes to 127.0.0.1:6648 and 127.0.0.1:6658 only.";
const REFUSAL_BLOCK = /^if \(target === undefined \|\| !Object\.hasOwn\(TARGETS, target\)\) \{\n[\s\S]*?\n\}\n/m;
const CHANNEL = "new grpc.Client(";

// Rule 28.
function seederRefusalFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  const block = REFUSAL_BLOCK.exec(text);
  const channel = text.indexOf(CHANNEL);
  if (block === null || !block[0].includes(REFUSAL_SENTENCE) || !block[0].includes("process.exit(2);"))
    return ["the raw seeder does not refuse an unlisted target with exit 2"];
  if (channel === -1) return [`the raw seeder opens no ${CHANNEL}`];
  return block.index < channel ? [] : ["the raw seeder refuses an unlisted target only after it builds a channel"];
}

const MARKER_DECLARATION = `const OXIA_MARKER_KEY = "${MARKER}";`;
const MARKER_COMPARISON = /readRecord\(\s*snapshot,\s*OXIA_MARKER_KEY\s*\)[\s\S]*?!== fixture\.marker/;

// Rule 29.
function seederMarkerFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  const code = codeOf(SEEDER, text);
  const findings: string[] = [];
  if (!text.includes(MARKER_DECLARATION)) findings.push(`the raw seeder does not declare ${MARKER_DECLARATION}`);
  const compared = code.search(MARKER_COMPARISON);
  const write = code.search(/\bWrite\b/);
  if (compared === -1) findings.push("the raw seeder does not compare the marker with the fixture's value");
  else if (write !== -1 && write < compared) findings.push("the raw seeder names Write before its marker check");
  else if (writesBeforeMarker(text)) findings.push("the raw seeder writes before its marker check");
  return findings;
}

/**
 * Whether a top-level statement that runs before the marker comparison reaches Write. The functions that send Write
 * are declared below the check and hoisted, so the text order of the name Write proves nothing about when it runs:
 * a writer is a function whose body names Write or calls another writer, and no statement ahead of the one that
 * compares the marker may name a writer.
 */
function writesBeforeMarker(text: string): boolean {
  const source = ts.createSourceFile(SEEDER, codeOf(SEEDER, text), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(ts.isFunctionDeclaration);
  const writers = new Set<string>();
  const names = (node: ts.Node): string => node.getText(source);
  const reaches = (body: string): boolean =>
    /\bWrite\b/.test(body) || [...writers].some((name) => new RegExp(`\\b${name}\\b`).test(body));
  for (let grown = true; grown; ) {
    grown = false;
    for (const declared of functions) {
      const name = declared.name?.text;
      if (name !== undefined && !writers.has(name) && reaches(names(declared))) {
        writers.add(name);
        grown = true;
      }
    }
  }
  const run = source.statements.filter((statement) => !ts.isFunctionDeclaration(statement));
  const check = run.findIndex((statement) => /!== fixture\.marker/.test(names(statement)));
  return run.slice(0, check === -1 ? run.length : check + 1).some((statement) => reaches(names(statement)));
}

const WRITE_WORDS = /\bWrite\b|\bWriteStream\b|\bputs\b|\bput\b|delete-range|DeleteRange/;

// Rule 30.
function writeSurfaceFindings(files: LiveFiles): string[] {
  return Object.entries(files.live)
    .filter(([name, text]) => name !== SEEDER && WRITE_WORDS.test(codeOf(name, text)))
    .map(([name]) => `tests/live/${name} names a write`)
    .sort();
}

const NUL_KEYS_DECLARATION = /^const NUL_KEYS = (\[.*\]) as const;$/m;
const BULK_COUNT_DECLARATION = /^const BULK_COUNT = ([\d_]+);$/m;
const BULK_KEY_TEMPLATE = 'const bulkKey = (index: number): string => `/bulk/key-${String(index).padStart(5, "0")}`;';

/** The keys the seeder's text writes to the fixture of one marker. */
function seederKeys(text: string, marker: SeedSet): string[] | undefined {
  const nul = NUL_KEYS_DECLARATION.exec(text);
  const bulk = BULK_COUNT_DECLARATION.exec(text);
  if (nul === null || bulk === null || !text.includes(BULK_KEY_TEMPLATE)) return undefined;
  const nulKeys = JSON.parse(nul[1]) as string[];
  const target = Object.entries(targetsTable(text) ?? {}).find(([, row]) => row.marker === marker)?.[1];
  if (target === undefined) return marker === "blind" ? [] : undefined;
  const bulkKeys = Array.from(
    { length: target.bulk ? Number(bulk[1].replaceAll("_", "")) : 0 },
    (_, i) => `/bulk/key-${String(i).padStart(5, "0")}`,
  );
  return [...nulKeys, ...bulkKeys];
}

// Rule 31.
function seederKeyFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  const findings: string[] = [];
  for (const set of SETS) {
    const written = seederKeys(text, set);
    if (written === undefined) {
      findings.push(`the raw seeder's keys for ${set} cannot be read`);
      continue;
    }
    const listed = keysBy(readmeSet(files.readme, set), RAW_WRITER);
    if (!same([...written].sort(), [...listed].sort()))
      findings.push(`the raw seeder writes ${written.length} keys to ${set}, the README names ${listed.length}`);
    if (!same([...written].sort(), [...RAW_KEYS[set]].sort()))
      findings.push(`the raw seeder's keys for ${set} are not the design's`);
  }
  return findings;
}

const VALUE_CONSTANTS: Readonly<Record<string, string>> = { NUL_VALUE: '"nul"', BULK_VALUE: '"v"' };

// Rule 32.
function seederValueFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  return Object.entries(VALUE_CONSTANTS)
    .filter(([name, value]) => new RegExp(`^const ${name} = (.+);$`, "m").exec(text)?.[1] !== value)
    .map(([name, value]) => `the raw seeder's ${name} is not ${value}`);
}

const ROUTING_IMPORT = /^import \{[^}]*\bshardFor\b[^}]*\} from "@\/lib\/db\/providers\/keyvalue\/oxia\/routing";$/m;

// Rule 33.
function seederRoutingFindings(files: LiveFiles): string[] {
  const text = seederText(files);
  if (text === undefined) return [MISSING_SEEDER];
  const findings: string[] = [];
  if (!ROUTING_IMPORT.test(text)) findings.push("the raw seeder does not import shardFor from oxia/routing");
  if (!/routing cross-check/.test(text) || !/process\.exit\(1\)/.test(text))
    findings.push("the raw seeder holds no routing cross-check that exits 1");
  return findings;
}

const TEMPORARY_WORDS = /\btmpdir\b|\bTMPDIR\b|\bmkdtemp(?:Sync)?\b/;

// Rule 34.
function repositoryStateFindings(files: LiveFiles): string[] {
  return Object.entries(files.live)
    .filter(([name, text]) => TEMPORARY_WORDS.test(codeOf(name, text)))
    .map(([name]) => `tests/live/${name} keeps state under the system's temporary directory`)
    .sort();
}

const liveFiles = loadLiveFiles();

describe("tests/live/oxia-seed-raw.ts, the one writer", () => {
  test("the raw seeder writes to the two fixture addresses and nowhere else", () => {
    clean(seederTargetFindings(liveFiles));
    const probe = plantedLive(liveFiles, (draft) => {
      draft.live[SEEDER] = draft.live[SEEDER].replace(
        '  "127.0.0.1:6658": { marker: "small", bulk: false },\n',
        '  "127.0.0.1:6658": { marker: "small", bulk: false },\n  "127.0.0.1:26640": { marker: "full", bulk: false },\n',
      );
    });
    finds(seederTargetFindings(probe), "the raw seeder's TARGETS are");
    finds(seederTargetFindings(probe), "the raw seeder names the address 127.0.0.1:26640");
    finds(seederTargetFindings(probe), "the raw seeder names a shared probe port");
  });

  test("it refuses a target outside the table before any socket", () => {
    clean(seederRefusalFindings(liveFiles));
    const moved = plantedLive(liveFiles, (draft) => {
      const text = draft.live[SEEDER];
      const block = (REFUSAL_BLOCK.exec(text) as RegExpExecArray)[0];
      draft.live[SEEDER] = `${text.replace(block, "")}\n${block}`;
    });
    finds(seederRefusalFindings(moved), "refuses an unlisted target only after it builds a channel");
  });

  test("it reads the marker before any write and refuses a server that is not the seeded fixture", () => {
    clean(seederMarkerFindings(liveFiles));
    const unchecked = plantedLive(liveFiles, (draft) => {
      draft.live[SEEDER] = draft.live[SEEDER].replace("!== fixture.marker", "!== undefined");
    });
    finds(seederMarkerFindings(unchecked), "does not compare the marker with the fixture's value");
    // The write call itself moved above the check: the function that sends Write is still declared below it.
    const early = plantedLive(liveFiles, (draft) => {
      const call = "let written = await seedKeys(snapshot, NUL_KEYS, NUL_VALUE);\n";
      const text = draft.live[SEEDER];
      expect(text).toContain(call);
      draft.live[SEEDER] = text
        .replace(call, "")
        .replace("const marker = await readRecord(", `${call}const marker = await readRecord(`);
    });
    finds(seederMarkerFindings(early), "the raw seeder writes before its marker check");
  });

  test("the write surface is one file", () => {
    clean(writeSurfaceFindings(liveFiles));
    expect(Object.keys(liveFiles.live)).toContain(SEEDER);
    expect(WRITE_WORDS.test(codeOf(SEEDER, liveFiles.live[SEEDER]))).toBe(true);
    const harness = plantedLive(liveFiles, (draft) => {
      draft.live["oxia-evidence.ts"] = `${draft.live["oxia-evidence.ts"] ?? ""}\nclient.Write(request);\n`;
    });
    finds(writeSurfaceFindings(harness), "tests/live/oxia-evidence.ts names a write");
    const commented = plantedLive(liveFiles, (draft) => {
      draft.live["oxia-evidence.ts"] = `${draft.live["oxia-evidence.ts"] ?? ""}\n// never a Write\n`;
    });
    clean(writeSurfaceFindings(commented));
  });

  test("no live file keeps state outside the repository: the fixtures README is the harness's provenance store", () => {
    clean(repositoryStateFindings(liveFiles));
    const temporary = plantedLive(liveFiles, (draft) => {
      draft.live["oxia-evidence.ts"] =
        `import { tmpdir } from "node:os";\nconst kept = path.join(tmpdir(), "x.json");\n${draft.live["oxia-evidence.ts"] ?? ""}`;
    });
    finds(
      repositoryStateFindings(temporary),
      "tests/live/oxia-evidence.ts keeps state under the system's temporary directory",
    );
    const commented = plantedLive(liveFiles, (draft) => {
      draft.live["oxia-evidence.ts"] = `${draft.live["oxia-evidence.ts"] ?? ""}\n// never tmpdir\n`;
    });
    clean(repositoryStateFindings(commented));
  });

  test("the keys it writes are the README's rows for it, and the counts match", () => {
    clean(seederKeyFindings(liveFiles));
    const dropped = plantedLive(liveFiles, (draft) => {
      draft.live[SEEDER] = draft.live[SEEDER].replace(', "a\\u0000"] as const;', "] as const;");
    });
    finds(seederKeyFindings(dropped), "the raw seeder writes 20002 keys to full, the README names 20003");
    finds(seederKeyFindings(dropped), "the raw seeder writes 2 keys to small, the README names 3");
  });

  test("no value it writes reaches the server's 64 MiB WAL segment", () => {
    clean(seederValueFindings(liveFiles));
    const large = plantedLive(liveFiles, (draft) => {
      draft.live[SEEDER] = draft.live[SEEDER].replace(
        'const BULK_VALUE = "v";',
        'const BULK_VALUE = "x".repeat(67108864);',
      );
    });
    finds(seederValueFindings(large), 'the raw seeder\'s BULK_VALUE is not "v"');
  });

  test("it routes with the provider's own routing module and checks it against keys the CLI wrote", () => {
    clean(seederRoutingFindings(liveFiles));
    const unrouted = plantedLive(liveFiles, (draft) => {
      draft.live[SEEDER] = draft.live[SEEDER].replace(ROUTING_IMPORT, "");
    });
    finds(seederRoutingFindings(unrouted), "does not import shardFor from oxia/routing");
  });
});

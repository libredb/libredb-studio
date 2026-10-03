/**
 * The live vector fixtures in `database-compose.yml`, held to the rules the vector-family design sets for them (its
 * section 7) under the etcd fixtures' rules: every image pinned by tag and by digest, every published port on a
 * loopback address, every container bounded in CPU and memory with no swap past it, every container named
 * libredb-<service>, and every credential generated into a volume by a one-shot and never committed. Milvus's
 * documented default root password is the one exception: it is the server's built-in default, so no setting here
 * names it.
 *
 * The scripts of `docker/milvus` and `docker/qdrant` are held to the same section, and every command in their READMEs
 * names the compose project and the services it starts, because `up` with no service names starts the whole fleet of
 * this file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const COMPOSE_TEXT = readFileSync(path.join(ROOT, "database-compose.yml"), "utf8");

interface ComposeService {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly extra_hosts?: readonly string[];
  readonly security_opt?: readonly string[];
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly deploy?: { readonly resources?: { readonly limits?: { readonly cpus?: string; readonly memory?: string } } };
  readonly memswap_limit?: string;
  readonly platform?: string;
}

// `merge: true` because the file shares settings through `<<:` merge keys.
const compose = parseYaml(COMPOSE_TEXT, { merge: true }) as {
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes: Readonly<Record<string, unknown>>;
};

function service(name: string): ComposeService {
  const found = compose.services[name];
  if (found === undefined) throw new Error(`database-compose.yml has no service ${name}`);
  return found;
}

const script = (file: string): string => readFileSync(path.join(ROOT, "docker", file), "utf8");

const MILVUS_IMAGE = "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0";
const OPENSSL_IMAGE = "alpine/openssl:3.5.8@sha256:3f25da71f70eba788067daac3f3df03bd1de7a7c52ed89fa93b94ad2c92d986b";

/** The Milvus servers: profile, published ports, data volume and TLS mode. */
const MILVUS_SERVERS: Readonly<
  Record<
    string,
    { readonly profile?: string; readonly ports: readonly string[]; readonly volume: string; readonly tlsMode?: string }
  >
> = {
  milvus: { ports: ["127.0.0.1:19530:19530", "127.0.0.1:19091:9091"], volume: "milvus-data" },
  "milvus-tls": {
    profile: "milvus-tls",
    ports: ["127.0.0.1:19531:19530", "127.0.0.1:19541:8080"],
    volume: "milvus-tls-data",
    tlsMode: "1",
  },
  "milvus-mtls": { profile: "milvus-tls", ports: ["127.0.0.1:19532:19530"], volume: "milvus-mtls-data", tlsMode: "2" },
};

const MILVUS_ENV = {
  ETCD_USE_EMBED: "true",
  ETCD_DATA_DIR: "/var/lib/milvus/etcd",
  ETCD_CONFIG_PATH: "/milvus/configs/embedEtcd.yaml",
  COMMON_STORAGETYPE: "local",
  DEPLOY_MODE: "STANDALONE",
  COMMON_SECURITY_AUTHORIZATIONENABLED: "true",
};

function limits(name: string): { cpus?: string; memory?: string; swap?: string } {
  const bound = service(name).deploy?.resources?.limits;
  return { cpus: bound?.cpus, memory: bound?.memory, swap: service(name).memswap_limit };
}

describe("the Milvus servers in database-compose.yml", () => {
  test("each runs Milvus 3.0.2 pinned by digest, named libredb-<service>, behind the profile the design names", () => {
    for (const [name, expected] of Object.entries(MILVUS_SERVERS)) {
      expect({
        name,
        image: service(name).image,
        container: service(name).container_name,
        profiles: service(name).profiles,
      }).toEqual({
        name,
        image: MILVUS_IMAGE,
        container: `libredb-${name}`,
        profiles: expected.profile === undefined ? undefined : [expected.profile],
      });
    }
  });

  test("each follows standalone_embed.sh: the standalone command, seccomp unconfined, the embedded etcd, authorization on", () => {
    for (const name of Object.keys(MILVUS_SERVERS)) {
      expect(service(name).command).toEqual(["milvus", "run", "standalone"]);
      expect(service(name).security_opt).toEqual(["seccomp:unconfined"]);
      expect(service(name).environment).toMatchObject(MILVUS_ENV);
      expect(service(name).restart).toBe("unless-stopped");
    }
  });

  test("each keeps its data in a named volume of its own and mounts the two configuration files", () => {
    for (const [name, expected] of Object.entries(MILVUS_SERVERS)) {
      expect(service(name).volumes).toEqual(
        expect.arrayContaining([
          `${expected.volume}:/var/lib/milvus`,
          "./docker/milvus/embedEtcd.yaml:/milvus/configs/embedEtcd.yaml",
          "./docker/milvus/user.yaml:/milvus/configs/user.yaml",
        ]),
      );
      expect(compose.volumes).toHaveProperty(expected.volume);
    }
  });

  test("each publishes exactly its ports on loopback, the management port as 19091 on milvus alone, and never 2379", () => {
    for (const [name, expected] of Object.entries(MILVUS_SERVERS)) {
      expect({ name, ports: service(name).ports }).toEqual({ name, ports: expected.ports });
    }
    for (const name of Object.keys(MILVUS_SERVERS)) {
      expect(service(name).ports?.some((port) => port.endsWith(":2379"))).toBe(false);
    }
  });

  test("the TLS servers set their mode, serve REST on a listener of their own and read the generated certificates", () => {
    for (const [name, expected] of Object.entries(MILVUS_SERVERS)) {
      if (expected.tlsMode === undefined) {
        expect(service(name).environment?.COMMON_SECURITY_TLSMODE).toBeUndefined();
        continue;
      }
      expect(service(name).environment).toMatchObject({
        COMMON_SECURITY_TLSMODE: expected.tlsMode,
        PROXY_HTTP_PORT: "8080",
        TLS_SERVERPEMPATH: "/milvus/tls/server.pem",
        TLS_SERVERKEYPATH: "/milvus/tls/server.key",
        TLS_CAPEMPATH: "/milvus/tls/ca.pem",
      });
      expect(service(name).volumes).toContain("milvus-certs:/milvus/tls:ro");
      expect(service(name).depends_on).toEqual({ "milvus-certs": { condition: "service_completed_successfully" } });
    }
  });

  test("each has the management port's health probe and is bounded to 2 CPUs and 4 GiB with no swap", () => {
    for (const name of Object.keys(MILVUS_SERVERS)) {
      expect(service(name).healthcheck?.test).toEqual(["CMD", "curl", "-f", "http://localhost:9091/healthz"]);
      expect(limits(name)).toEqual({ cpus: "2", memory: "4G", swap: "4G" });
    }
  });

  test("milvus-certs is a bounded one-shot in the pinned openssl image, behind the TLS profile, publishing nothing", () => {
    const certs = service("milvus-certs");
    expect(certs).toMatchObject({
      image: OPENSSL_IMAGE,
      container_name: "libredb-milvus-certs",
      profiles: ["milvus-tls"],
      restart: "no",
      entrypoint: ["sh", "/milvus/certs.sh", "/certs"],
    });
    expect(certs.ports).toBeUndefined();
    expect(certs.volumes).toEqual(["milvus-certs:/certs", "./docker/milvus:/milvus:ro"]);
    expect(limits("milvus-certs")).toEqual({ cpus: "0.5", memory: "64M", swap: "64M" });
  });

  test("no setting names root's default password: it is the server's built-in default", () => {
    expect(COMPOSE_TEXT).not.toContain("root:Milvus");
    for (const name of [...Object.keys(MILVUS_SERVERS), "milvus-certs"]) {
      for (const value of Object.values(service(name).environment ?? {})) expect(value).not.toBe("Milvus");
    }
  });
});

describe("docker/milvus/certs.sh", () => {
  const certs = script("milvus/certs.sh");

  test("generates the CA, the server certificate and the client variants mutual TLS is measured with", () => {
    for (const file of ["server", "client", "client-serverauth", "client-expired"]) {
      expect(certs).toMatch(new RegExp(`^issue ${file} `, "m"));
    }
    expect(certs).toContain("openssl genrsa -out client-mismatched.key 2048");
    expect(certs).toContain("-not_before 20250101000000Z -not_after 20250102000000Z");
  });

  test("names the server for every way a client reaches it, and gives each certificate one usage", () => {
    expect(certs).toContain("subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:milvus-tls,DNS:milvus-mtls");
    expect(certs.match(/extendedKeyUsage=clientAuth/g)).toHaveLength(2);
    expect(certs.match(/extendedKeyUsage=serverAuth/g)).toHaveLength(2);
  });

  test("runs once, behind a marker, and leaves every file readable by the server's uid 999", () => {
    expect(certs).toContain('[ -f .complete ] && { echo "certificates already in $1"; exit 0; }');
    expect(certs).toContain("chmod 644 ./*");
  });
});

/** Every `docker compose` command of a README's sh blocks, its continuation lines joined. */
function composeCommands(readme: string): string[] {
  return [...readme.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((block) => block[1].replace(/\\\n\s*/g, " ").split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.startsWith("docker compose"));
}

/** The services a compose command names after its verb: every word for up and rm, the first for run. */
function namedServices(command: string): string[] {
  const words = command.split(/\s+/);
  const verb = words.findIndex((word) => word === "up" || word === "run" || word === "rm");
  if (verb === -1) return [];
  const rest = words.slice(verb + 1).filter((word) => !word.startsWith("-"));
  return words[verb] === "run" ? rest.slice(0, 1) : rest;
}

function expectCommandsNameProjectAndServices(readme: string, services: readonly string[]): void {
  const commands = composeCommands(readme);
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect({ command, project: command.includes("-p libredb-studio -f database-compose.yml") }).toEqual({
      command,
      project: true,
    });
    const named = namedServices(command);
    expect({ command, names: named.length > 0 }).toEqual({ command, names: true });
    for (const name of named)
      expect({ command, name, known: services.includes(name) }).toEqual({ command, name, known: true });
  }
}

/**
 * Every `docker cp` of a README copies keys or passwords out of a volume, so its destination is a path under a
 * directory the same block made with `mktemp -d`: fresh, so the copy never nests into an earlier one, and readable by
 * its owner alone.
 */
function expectCopiesIntoAPrivateDirectory(readme: string): void {
  const blocks = readme.split("```").filter((_block, index) => index % 2 === 1);
  const copies = blocks.filter((block) => block.includes("docker cp"));
  expect(copies.length).toBeGreaterThan(0);
  for (const block of copies) {
    const lines = block.split("\n").filter((line) => line.trim() !== "" && line.trim() !== "sh");
    expect({ block, first: lines[0] }).toEqual({ block, first: "dir=$(mktemp -d)" });
    for (const line of lines.filter((entry) => entry.startsWith("docker cp"))) {
      expect(line).toMatch(/^docker cp libredb-[a-z-]+:\/[a-z]+ "\$dir\/[a-z-]+"$/);
    }
  }
}

const MILVUS_SEED_IMAGE = "python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016";
const MILVUS_SERVICES = ["milvus", "milvus-seed", "milvus-certs", "milvus-tls", "milvus-mtls"];

describe("the seeds' platform", () => {
  test("each seed one-shot runs as linux/amd64, the platform of every wheel its requirements.txt hashes", () => {
    expect(service("milvus-seed").platform).toBe("linux/amd64");
    expect(service("qdrant-seed").platform).toBe("linux/amd64");
  });
});

describe("the Milvus seed", () => {
  test("milvus-seed is a one-shot in the pinned Python image that waits for a healthy milvus and installs by hash", () => {
    const seed = service("milvus-seed");
    expect(seed).toMatchObject({
      image: MILVUS_SEED_IMAGE,
      container_name: "libredb-milvus-seed",
      restart: "no",
      depends_on: { milvus: { condition: "service_healthy" } },
      command: ["--uri", "http://milvus:19530", "--credentials", "/credentials"],
    });
    expect(seed.profiles).toBeUndefined();
    expect(seed.ports).toBeUndefined();
    expect(seed.volumes).toEqual(["./docker/milvus:/seed:ro", "milvus-credentials:/credentials"]);
    // The file writes $$@, which compose reads as the shell's $@: the arguments of `run ... milvus-seed <arguments>`.
    expect(seed.entrypoint?.[2]).toBe(
      'pip install --quiet --no-cache-dir --require-hashes -r /seed/requirements.txt 1>&2 && exec python /seed/seed.py "$$@"',
    );
    expect(limits("milvus-seed")).toEqual({ cpus: "1", memory: "1G", swap: "1G" });
    expect(compose.volumes).toHaveProperty("milvus-credentials");
  });

  test("seed.py creates the research's objects and the ones the fixtures add, in two databases", () => {
    const seed = script("milvus/seed.py");
    for (const name of [
      "docs_int64",
      "docs_varchar",
      "fts",
      "unloaded_big",
      "scratch",
      "edge_values",
      "pk_partitioned",
      "large_topk",
      "shadowed",
      "wide_768",
      "emb_list",
      "notes",
    ]) {
      expect(seed).toContain(`"${name}", "`);
    }
    expect(seed).toContain('"probe_db", "notes"');
    expect(seed).toContain('properties={"query_mode": "large_topk"}');
    expect(seed).toContain("num_partitions=1024");
    expect(seed).toContain('c.add_collection_field(spec.name, field_name="zeta"');
    // An embedding list: a struct array whose vector subfield is indexed with a MAX_SIM metric.
    expect(seed).toContain("element_type=DataType.STRUCT");
    expect(seed).toContain('"chunks[emb]": ("HNSW", "MAX_SIM_COSINE"');
  });

  test("seed.py names root's documented default once, and generates every other password", () => {
    const seed = script("milvus/seed.py");
    expect(seed.match(/root:Milvus/g)).toHaveLength(1);
    expect(seed).toContain('ROOT_TOKEN = "root:Milvus"');
    expect(seed).toContain("secrets.token_hex(16)");
    expect(seed).not.toMatch(/password\s*=\s*"/i);
  });

  test("docker/milvus/README.md names every service, and every command names the project and its services", () => {
    const readme = script("milvus/README.md");
    for (const name of MILVUS_SERVICES) expect(readme).toContain(`\`${name}\``);
    expectCommandsNameProjectAndServices(readme, MILVUS_SERVICES);
    expectCopiesIntoAPrivateDirectory(readme);
  });
});

const QDRANT_IMAGE =
  "ghcr.io/qdrant/qdrant/qdrant:v1.19.1@sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822";

/** The Qdrant servers: profile, published port, the local.yaml it reads, and its health probe. */
const QDRANT_SERVERS: Readonly<
  Record<
    string,
    { readonly profile?: string; readonly port: string; readonly config?: string; readonly probe: "http" | "tcp" }
  >
> = {
  qdrant: { port: "127.0.0.1:6333:6333", probe: "http" },
  "qdrant-auth": { profile: "qdrant-auth", port: "127.0.0.1:6343:6333", config: "auth", probe: "http" },
  "qdrant-tls": { profile: "qdrant-tls", port: "127.0.0.1:6353:6333", config: "tls", probe: "tcp" },
  "qdrant-mtls": { profile: "qdrant-tls", port: "127.0.0.1:6363:6333", config: "mtls", probe: "tcp" },
};

describe("the Qdrant servers in database-compose.yml", () => {
  test("each runs Qdrant 1.19.1 pinned by digest, named libredb-<service>, behind the profile the design names", () => {
    for (const [name, expected] of Object.entries(QDRANT_SERVERS)) {
      expect({
        name,
        image: service(name).image,
        container: service(name).container_name,
        profiles: service(name).profiles,
      }).toEqual({
        name,
        image: QDRANT_IMAGE,
        container: `libredb-${name}`,
        profiles: expected.profile === undefined ? undefined : [expected.profile],
      });
      expect(service(name).restart).toBe("unless-stopped");
    }
  });

  test("each publishes REST alone on loopback, never gRPC 6334 or the internal 6335, and has no data volume", () => {
    for (const [name, expected] of Object.entries(QDRANT_SERVERS)) {
      expect({ name, ports: service(name).ports }).toEqual({ name, ports: [expected.port] });
      expect(service(name).volumes ?? []).toEqual(expected.config === undefined ? [] : ["qdrant-keys:/keys:ro"]);
    }
  });

  test("each turns telemetry off, and none takes a key or a TLS setting from its environment", () => {
    for (const name of Object.keys(QDRANT_SERVERS)) {
      expect(service(name).environment?.QDRANT__TELEMETRY_DISABLED).toBe("true");
      for (const key of Object.keys(service(name).environment ?? {})) {
        expect({ name, key, keyOrTls: /^QDRANT__(SERVICE|TLS)__/.test(key) }).toEqual({ name, key, keyOrTls: false });
      }
    }
  });

  test("each keyed server reads its own generated local.yaml and waits for qdrant-keys", () => {
    for (const [name, expected] of Object.entries(QDRANT_SERVERS)) {
      if (expected.config === undefined) {
        expect(service(name).entrypoint).toBeUndefined();
        continue;
      }
      expect(service(name).entrypoint).toEqual([
        "bash",
        "-c",
        `cp /keys/${expected.config}/local.yaml /qdrant/config/local.yaml && exec ./entrypoint.sh`,
      ]);
      expect(service(name).depends_on).toEqual({ "qdrant-keys": { condition: "service_completed_successfully" } });
    }
  });

  test("qdrant-auth points its inference address at the harness listener, and says only that it must receive nothing", () => {
    expect(service("qdrant-auth").environment?.QDRANT__INFERENCE__ADDRESS).toBe(
      "http://host.docker.internal:18904/infer",
    );
    expect(service("qdrant-auth").extra_hosts).toEqual(["host.docker.internal:host-gateway"]);
    expect(COMPOSE_TEXT).toContain(
      "      # inference listener must receive nothing\n      QDRANT__INFERENCE__ADDRESS:",
    );
    expect(COMPOSE_TEXT.match(/inference/gi)).toHaveLength(2);
    for (const name of ["qdrant", "qdrant-tls", "qdrant-mtls"]) {
      expect(service(name).environment?.QDRANT__INFERENCE__ADDRESS).toBeUndefined();
    }
  });

  test("each has a health probe its transport allows, and is bounded to 2 CPUs and 2 GiB with no swap", () => {
    for (const [name, expected] of Object.entries(QDRANT_SERVERS)) {
      const probe = service(name).healthcheck?.test ?? [];
      expect(probe.slice(0, 3)).toEqual(["CMD", "bash", "-c"]);
      expect(probe[3]).toContain(expected.probe === "http" ? "GET /readyz" : "</dev/tcp/127.0.0.1/6333");
      expect(limits(name)).toEqual({ cpus: "2", memory: "2G", swap: "2G" });
    }
  });

  test("qdrant-keys is a bounded one-shot in the pinned openssl image, behind both keyed profiles", () => {
    expect(service("qdrant-keys")).toMatchObject({
      image: OPENSSL_IMAGE,
      container_name: "libredb-qdrant-keys",
      profiles: ["qdrant-auth", "qdrant-tls"],
      restart: "no",
      entrypoint: ["sh", "/qdrant-scripts/keys.sh", "/keys"],
      volumes: ["qdrant-keys:/keys", "./docker/qdrant:/qdrant-scripts:ro"],
    });
    expect(service("qdrant-keys").ports).toBeUndefined();
    expect(limits("qdrant-keys")).toEqual({ cpus: "0.5", memory: "64M", swap: "64M" });
    expect(compose.volumes).toHaveProperty("qdrant-keys");
  });
});

describe("docker/qdrant/keys.sh", () => {
  const keys = script("qdrant/keys.sh");

  test("generates an admin and a read-only key of 32 random bytes for each keyed server", () => {
    expect(keys).toContain("for server in auth tls mtls; do");
    expect(keys).toContain('openssl rand -hex 32 >"$server/admin.key"');
    expect(keys).toContain('openssl rand -hex 32 >"$server/read-only.key"');
  });

  test("writes JWT RBAC into the auth server's local.yaml, and TLS, verifying the client on mtls, into the others", () => {
    expect(keys).toContain("  jwt_rbac: true");
    expect(keys).toContain("  enable_tls: true");
    expect(keys).toContain('verify_https_client_certificate: $([ "$server" = mtls ] && echo true || echo false)');
    expect(keys).toContain("subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:qdrant-tls,DNS:qdrant-mtls");
    expect(keys).toContain("extendedKeyUsage=clientAuth");
  });

  test("runs once, behind a marker", () => {
    expect(keys).toContain('[ -f .complete ] && { echo "keys already in $1"; exit 0; }');
  });
});

const QDRANT_SEED_IMAGE = "python:3.14-slim@sha256:0741d101873c12ab927e6f8653feb8862b9bd58771177acb1b885b95141f91b4";
const QDRANT_SERVICES = ["qdrant", "qdrant-seed", "qdrant-keys", "qdrant-auth", "qdrant-tls", "qdrant-mtls"];

describe("the Qdrant seed", () => {
  test("qdrant-seed is a one-shot in the pinned Python image that waits for a healthy qdrant and installs by hash", () => {
    const seed = service("qdrant-seed");
    expect(seed).toMatchObject({
      image: QDRANT_SEED_IMAGE,
      container_name: "libredb-qdrant-seed",
      restart: "no",
      depends_on: { qdrant: { condition: "service_healthy" } },
      command: ["--url", "http://qdrant:6333"],
    });
    expect(seed.profiles).toBeUndefined();
    expect(seed.ports).toBeUndefined();
    expect(seed.volumes).toEqual(["./docker/qdrant:/seed:ro", "qdrant-keys:/keys:ro"]);
    // The file writes $$@, which compose reads as the shell's $@: the arguments of `run ... qdrant-seed <arguments>`.
    expect(seed.entrypoint?.[2]).toBe(
      'pip install --quiet --no-cache-dir --require-hashes -r /seed/requirements.txt 1>&2 && exec python /seed/seed.py "$$@"',
    );
    expect(limits("qdrant-seed")).toEqual({ cpus: "1", memory: "1G", swap: "1G" });
  });

  test("seed.py creates the research's collections and aliases and the two the fixtures add, from fixed seeds", () => {
    const seed = script("qdrant/seed.py");
    expect(seed).toContain(
      'COLLECTIONS = ["docs", "small_dtypes", "plain", "scratch", "empty_novec", "edge_values", "payload_spread"]',
    );
    expect(seed).toContain('ALIASES = {"docs_alias": "docs", "plain_alias": "plain"}');
    for (const seedValue of ["20261002", "default_rng(7)", "default_rng(11)", "20261003"])
      expect(seed).toContain(seedValue);
    expect(seed).not.toMatch(/api_key\s*=\s*"/);
  });

  test("docker/qdrant/README.md names every service, and every command names the project and its services", () => {
    const readme = script("qdrant/README.md");
    for (const name of QDRANT_SERVICES) expect(readme).toContain(`\`${name}\``);
    expectCommandsNameProjectAndServices(readme, QDRANT_SERVICES);
    expectCopiesIntoAPrivateDirectory(readme);
  });
});

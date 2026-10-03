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

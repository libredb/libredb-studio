/**
 * The live etcd fixtures in `database-compose.yml`, held to the rules the etcd provider design
 * sets for them (its section 9) and the Kafka fixtures set before it.
 *
 * Every image is pinned to the exact build by tag and digest, because a capture is a claim about
 * one server build; every published port is bound to a loopback address, because the auth
 * fixtures' certificates and generated passwords are throwaway; every container is bounded,
 * because unbounded fixtures once loaded the host until it locked up; and every server sets its
 * own member name and cluster token, because two single-member servers started with the defaults
 * answered with the same cluster and member ids, and a capture must say which server answered.
 * The auth fixtures differ in exactly one way, whether the server reads client certificates, so
 * a password over server-verified TLS is exercised live as well as certificate authentication.
 *
 * `docker/etcd/README.md` says how to bring each one up and what it holds.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface ComposeService {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly command?: readonly string[];
  readonly entrypoint?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly deploy?: { readonly resources?: { readonly limits?: { readonly cpus?: string; readonly memory?: string } } };
  readonly memswap_limit?: string;
  readonly networks?: Readonly<Record<string, { readonly aliases?: readonly string[] }>>;
}

// `merge: true` because the file shares a service's settings through `<<:` merge keys, which
// YAML 1.2 would otherwise read as a key named "<<".
const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
  readonly services: Readonly<Record<string, ComposeService>>;
  readonly volumes: Readonly<Record<string, unknown>>;
};

const ETCD_IMAGE = /^gcr\.io\/etcd-development\/etcd:v3\.7\.2@sha256:[0-9a-f]{64}$/;
const PINNED_IMAGE = /^[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/;

/** The etcd servers: profile, the one published port, and the cluster token they share or own. */
const SERVERS: Readonly<Record<string, { readonly profile?: string; readonly port: string; readonly token: string }>> =
  {
    etcd: { port: "127.0.0.1:2379:2379", token: "libredb-etcd" },
    "etcd-cluster-1": { profile: "etcd-cluster", port: "127.0.0.2:2379:2379", token: "libredb-etcd-cluster" },
    "etcd-cluster-2": { profile: "etcd-cluster", port: "127.0.0.3:2379:2379", token: "libredb-etcd-cluster" },
    "etcd-cluster-3": { profile: "etcd-cluster", port: "127.0.0.4:2379:2379", token: "libredb-etcd-cluster" },
    "etcd-auth": { profile: "etcd-auth", port: "127.0.0.1:12379:2379", token: "libredb-etcd-auth" },
    "etcd-auth-password": { profile: "etcd-auth", port: "127.0.0.1:12479:2379", token: "libredb-etcd-auth-password" },
  };

/** The one-shot services: profile, and what each waits for and in which state. */
const ONE_SHOTS: Readonly<
  Record<string, { readonly profile?: string; readonly waitsFor: Readonly<Record<string, string>> }>
> = {
  "etcd-seed": { waitsFor: { etcd: "service_healthy" } },
  "etcd-cluster-seed": {
    profile: "etcd-cluster",
    waitsFor: {
      "etcd-cluster-1": "service_healthy",
      "etcd-cluster-2": "service_healthy",
      "etcd-cluster-3": "service_healthy",
    },
  },
  "etcd-auth-certs": { profile: "etcd-auth", waitsFor: {} },
  "etcd-auth-init": { profile: "etcd-auth", waitsFor: { "etcd-auth": "service_healthy" } },
  "etcd-auth-password-init": { profile: "etcd-auth", waitsFor: { "etcd-auth-password": "service_healthy" } },
};

const NAMES = [...Object.keys(SERVERS), ...Object.keys(ONE_SHOTS)];

function service(name: string): ComposeService {
  const found = compose.services[name];
  if (found === undefined) throw new Error(`database-compose.yml has no service ${name}`);
  return found;
}

/** The value of `--<flag>=<value>` in a server's command, or undefined; a repeated flag throws. */
function flag(name: string, flagName: string): string | undefined {
  const prefix = `--${flagName}=`;
  const values = (service(name).command ?? [])
    .filter((word) => word.startsWith(prefix))
    .map((word) => word.slice(prefix.length));
  if (values.length > 1) throw new Error(`${name} sets --${flagName} ${values.length} times`);
  return values[0];
}

function hasFlag(name: string, flagName: string): boolean {
  return service(name).command?.includes(`--${flagName}`) === true || flag(name, flagName) !== undefined;
}

describe("the live etcd fixtures in database-compose.yml", () => {
  test("the etcd services are exactly the fixtures and one-shots the design names", () => {
    const declared = Object.keys(compose.services).filter((name) => name.startsWith("etcd"));
    expect(declared.sort()).toEqual([...NAMES].sort());
  });

  test("the single member starts on a plain up, the cluster and the auth fixtures only by profile", () => {
    for (const [name, expected] of Object.entries({ ...SERVERS, ...ONE_SHOTS })) {
      expect({ name, profiles: service(name).profiles }).toEqual({
        name,
        profiles: expected.profile === undefined ? undefined : [expected.profile],
      });
    }
  });

  test("every container is named libredb-<service>", () => {
    for (const name of NAMES) expect(service(name).container_name).toBe(`libredb-${name}`);
  });

  test("every server runs etcd v3.7.2 pinned by digest, and every helper image is pinned by digest", () => {
    for (const name of Object.keys(SERVERS)) expect(service(name).image).toMatch(ETCD_IMAGE);
    const serverImages = new Set(Object.keys(SERVERS).map((name) => service(name).image));
    expect(serverImages.size).toBe(1);
    for (const name of Object.keys(ONE_SHOTS)) expect(service(name).image).toMatch(PINNED_IMAGE);
  });

  test("each server publishes its one client port on a loopback address, and no one-shot publishes any", () => {
    for (const [name, expected] of Object.entries(SERVERS)) expect(service(name).ports).toEqual([expected.port]);
    for (const name of Object.keys(ONE_SHOTS)) expect(service(name).ports).toBeUndefined();
  });

  test("every container is bounded in CPU and memory, with no swap past the memory bound", () => {
    for (const name of NAMES) {
      const limits = service(name).deploy?.resources?.limits;
      expect({ name, cpus: typeof limits?.cpus }).toEqual({ name, cpus: "string" });
      expect({ name, memory: typeof limits?.memory }).toEqual({ name, memory: "string" });
      expect(service(name).memswap_limit).toBe(limits?.memory);
    }
  });

  test("every server has an etcdctl healthcheck, and every one-shot waits for what it needs and never restarts", () => {
    for (const name of Object.keys(SERVERS)) {
      expect(service(name).healthcheck?.test?.slice(0, 2)).toEqual(["CMD", "etcdctl"]);
      expect(service(name).restart).toBe("unless-stopped");
    }
    for (const [name, expected] of Object.entries(ONE_SHOTS)) {
      expect(service(name).restart).toBe("no");
      const waits = Object.fromEntries(
        Object.entries(service(name).depends_on ?? {}).map(([needed, { condition }]) => [needed, condition]),
      );
      expect({ name, waits }).toEqual({ name, waits: expected.waitsFor });
    }
  });

  test("every server names itself after its container and carries its fixture's own cluster token", () => {
    for (const [name, expected] of Object.entries(SERVERS)) {
      expect(flag(name, "name")).toBe(`libredb-${name}`);
      expect({ name, token: flag(name, "initial-cluster-token") }).toEqual({ name, token: expected.token });
      expect(flag(name, "initial-cluster")?.split(",")).toContain(`libredb-${name}=http://${name}:2380`);
    }
  });

  test("the three cluster members form one cluster and share one network alias", () => {
    const members = ["etcd-cluster-1", "etcd-cluster-2", "etcd-cluster-3"];
    const expected = members.map((member) => `libredb-${member}=http://${member}:2380`).join(",");
    for (const member of members) {
      expect(flag(member, "initial-cluster")).toBe(expected);
      expect(service(member).networks?.default?.aliases).toEqual(["etcd-cluster"]);
    }
  });

  test("both auth fixtures serve TLS with a short token TTL, and only etcd-auth reads client certificates", () => {
    for (const name of ["etcd-auth", "etcd-auth-password"]) {
      expect(flag(name, "listen-client-urls")).toBe("https://0.0.0.0:2379");
      expect(flag(name, "cert-file")).toBe("/certs/server.crt");
      expect(flag(name, "key-file")).toBe("/certs/server.key");
      expect(flag(name, "auth-token")).toBe("simple");
      expect(Number(flag(name, "auth-token-ttl"))).toBeLessThanOrEqual(60);
      expect(service(name).volumes).toEqual(["etcd-auth-certs:/certs:ro"]);
    }
    expect(hasFlag("etcd-auth", "client-cert-auth")).toBe(true);
    expect(flag("etcd-auth", "trusted-ca-file")).toBe("/certs/ca.pem");
    expect(hasFlag("etcd-auth-password", "client-cert-auth")).toBe(false);
    expect(hasFlag("etcd-auth-password", "trusted-ca-file")).toBe(false);
    for (const name of ["etcd", "etcd-cluster-1", "etcd-cluster-2", "etcd-cluster-3"]) {
      expect(flag(name, "listen-client-urls")).toBe("http://0.0.0.0:2379");
      expect(service(name).volumes).toBeUndefined();
    }
  });

  test("the certificates live in a named volume that only the certificate one-shot writes", () => {
    expect(Object.keys(compose.volumes)).toContain("etcd-auth-certs");
    const mounts = NAMES.flatMap((name) =>
      (service(name).volumes ?? [])
        .filter((mount) => mount.startsWith("etcd-auth-certs:"))
        .map((mount) => ({ name, mount })),
    );
    for (const { name, mount } of mounts) {
      expect({ name, mount }).toEqual({
        name,
        mount: name === "etcd-auth-certs" ? "etcd-auth-certs:/certs" : "etcd-auth-certs:/certs:ro",
      });
    }
    expect(mounts.map(({ name }) => name).sort()).toEqual(
      ["etcd-auth", "etcd-auth-certs", "etcd-auth-init", "etcd-auth-password", "etcd-auth-password-init"].sort(),
    );
  });

  test("every one-shot runs a script of docker/etcd that exists, mounted read-only", () => {
    for (const name of Object.keys(ONE_SHOTS)) {
      expect(service(name).volumes).toContain("./docker/etcd:/etcd:ro");
      const scripts = (service(name).entrypoint ?? []).join(" ").match(/\/etcd\/[a-z-]+\.sh/g) ?? [];
      expect({ name, runs: scripts.length > 0 }).toEqual({ name, runs: true });
      for (const script of scripts) expect(existsSync(path.join(ROOT, "docker", script))).toBe(true);
    }
  });

  test("no certificate, key or password is committed under docker/etcd", () => {
    for (const entry of readdirSync(path.join(ROOT, "docker/etcd"))) {
      expect(entry).not.toMatch(/\.(pem|crt|key|csr|password)$/);
      expect(readFileSync(path.join(ROOT, "docker/etcd", entry), "utf8")).not.toContain("-----BEGIN");
    }
  });
});

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
 * The scripts of `docker/etcd` are held to the same section: the seed writes every key it names,
 * each only while absent, so a rerun leaves the revision the captures record; the RBAC init grants
 * role reader nothing but READ on `/app/` and `/config/a`, gives cert-only no password, and turns
 * auth on last; and each user's certificate carries its name as its Common Name.
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

function script(name: string): string {
  return readFileSync(path.join(ROOT, "docker/etcd", name), "utf8");
}

/** The body of a shell function `<name>() { ... }` of a script, from its opening line to its closing brace. */
function shellFunction(source: string, name: string): string {
  const found = new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "m").exec(source);
  if (found === null) throw new Error(`no shell function ${name}`);
  return found[1];
}

/** One byte per character, so a key that is not UTF-8 compares as its exact bytes. */
function bytes(hex: string): string {
  return (hex.replace(/\s/g, "").match(/../g) ?? [])
    .map((byte) => String.fromCharCode(Number.parseInt(byte, 16)))
    .join("");
}

/** The written keys of seed.sh, by the helper that writes each: new, put_new or put_at_version. */
function seededKeys(): string[] {
  const keys: string[] = [];
  for (const line of script("seed.sh").split("\n")) {
    const plain = /^new (\S+) /.exec(line) ?? /^(?:.*; do )?put_(?:new|at_version) "\$\(text (\S+)\)"/.exec(line);
    const escaped = /^put_new "\$\(printf '([^']*)' \| b64\)"/.exec(line);
    if (plain !== null) keys.push(plain[1]);
    else if (escaped !== null)
      keys.push(
        escaped[1].replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8))),
      );
  }
  return keys;
}

/** The keys of the README's seeded-keys table, from the first cell of each row. */
function readmeKeys(): { readonly count: number; readonly keys: string[] } {
  const readme = script("README.md");
  const section = readme.slice(
    readme.indexOf("## The seeded keys"),
    readme.indexOf("## Users, roles and certificates"),
  );
  const count = Number(/The same (\d+) keys/.exec(section)?.[1]);
  const keys: string[] = [];
  for (const row of section.split("\n").filter((line) => line.startsWith("| `"))) {
    const cell = row.split("|")[1];
    // A key that is not UTF-8 is written "`<text>` followed by the bytes `<hex>`", then optionally "and `<text>`".
    for (const [, before, hex, after, plain] of cell.matchAll(
      /`([^`]+)` followed by the bytes `([0-9a-f ]+)`(?: and `([^`]+)`)?|`([^`]+)`/g,
    )) {
      keys.push(plain ?? before + bytes(hex) + (after ?? ""));
    }
  }
  return { count, keys };
}

/** The value argument seed.sh writes for a key, as the source text of the call. */
function seedLine(key: string): string {
  const lines = script("seed.sh")
    .split("\n")
    .filter((line) => line.startsWith(`new ${key} `) || line.startsWith(`put_new "$(text ${key})" `));
  if (lines.length !== 1) throw new Error(`seed.sh writes ${key} ${lines.length} times`);
  return lines[0];
}

/** Every `call <path> <json>` of a script, in order, as its path and its JSON text. */
function calls(source: string): { readonly path: string; readonly body: string }[] {
  return [...source.matchAll(/^call (\S+) (?:'([^']*)'|"((?:[^"\\]|\\.)*)")/gm)].map(
    ([, callPath, single, double]) => ({
      path: callPath,
      body: single ?? double,
    }),
  );
}

// Every key section 9 of the design names, so dropping one from both seed.sh and the README
// still fails. The layouts of R09, the prefix-group shapes, the keys that are not UTF-8 in each
// arm of rule 7 of 4.1 (R13 D8), the values of 4.4, the history key, the leases, the Kubernetes
// subtree, the root compaction key and the custom-prefix stand-ins.
const SPEC_KEYS = [
  "/apisix/routes/1",
  "/apisix/plugins",
  "/service/batman/leader",
  "/skydns/local/example/www",
  "/feature-flag",
  "/config/a",
  "/config/b",
  "/app/cfg",
  "/app/a/b",
  "/app/x/y",
  "/bin/ok/x",
  `/bin/${bytes("fffe")}/x`,
  `/${bytes("fffe")}/x`,
  "/values/not-utf8",
  "/values/large",
  "/values/empty",
  "/values/whitespace",
  `/values/key-${bytes("fffe")}`,
  "/history/counter",
  "/leases/session-1",
  "/leases/session-2",
  "/registry/events/default/nginx.1",
  "/registry/pods/default/nginx",
  "/registry/secrets/default/db-creds",
  "/registry/configmaps/default/encrypted",
  "/registry/cbor.example.com/gadgets/default/g1",
  "/registry/example.com/widgets/default/w1",
  "registry/secrets/default/legacy",
  "compact_rev_key",
  "/tenant-a/configmaps/default/cm",
  "/tenant-a/configmaps/default/cm-encrypted",
];

describe("the scripts of docker/etcd", () => {
  test("seed.sh writes each key once, the README's table names the same keys, and the count matches", () => {
    const seeded = seededKeys();
    expect(new Set(seeded).size).toBe(seeded.length);
    const readme = readmeKeys();
    expect([...readme.keys].sort()).toEqual([...seeded].sort());
    expect(readme.count).toBe(seeded.length);
  });

  test("seed.sh writes every key the design's section 9 names", () => {
    const seeded = new Set(seededKeys());
    for (const key of SPEC_KEYS) expect({ key, seeded: seeded.has(key) }).toEqual({ key, seeded: true });
  });

  test("the values of 4.4: not UTF-8, past 256 KiB, empty and whitespace only", () => {
    const notUtf8 = /"\$\(hex ([0-9a-f]+)\)"$/.exec(seedLine("/values/not-utf8"))?.[1] ?? "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(() => decoder.decode(Uint8Array.from(bytes(notUtf8), (char) => char.charCodeAt(0)))).toThrow();
    const large = Number(/head -c (\d+) \/dev\/zero/.exec(seedLine("/values/large"))?.[1]);
    expect(large).toBeGreaterThan(256 * 1024);
    expect(seedLine("/values/empty")).toEndWith(' ""');
    expect(seedLine("/values/whitespace")).toEndWith(` "$(printf '  \\n\\t ' | b64)"`);
  });

  test("/history/counter gets exactly three revisions, each guarded by the version before it", () => {
    expect(script("seed.sh")).toContain(
      'for version in 0 1 2; do put_at_version "$(text /history/counter)" "$(text $((version + 1)))" "$version"; done',
    );
  });

  test("two long leases with fixed ids past 2^53, the second holding a protected key beside an ordinary one", () => {
    const seed = script("seed.sh");
    const [first, second] = ["7587863092875085000", "7587863092875085001"];
    for (const id of [first, second]) {
      expect(BigInt(id) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
      expect(Number(new RegExp(`^lease_new ${id} (\\d+)$`, "m").exec(seed)?.[1])).toBeGreaterThanOrEqual(86400);
    }
    expect(seedLine("/leases/session-1")).toEndWith(` ${first}`);
    expect(seedLine("/leases/session-2")).toEndWith(` ${second}`);
    expect(seedLine("/registry/events/default/nginx.1")).toEndWith(` ${second}`);
  });

  test("the Kubernetes values: envelopes, the encrypted prefix, CBOR, JSON, and the root compaction key", () => {
    const envelope = /"\$\(hex (6b387300[0-9a-f]*)\)"$/;
    for (const key of [
      "/registry/pods/default/nginx",
      "/registry/secrets/default/db-creds",
      "/tenant-a/configmaps/default/cm",
    ])
      expect({ key, line: seedLine(key) }).toEqual({ key, line: expect.stringMatching(envelope) });
    expect(bytes(envelope.exec(seedLine("/registry/secrets/default/db-creds"))?.[1] ?? "")).toContain(
      "libredb-fixture-secret",
    );
    for (const key of ["/registry/configmaps/default/encrypted", "/tenant-a/configmaps/default/cm-encrypted"])
      expect(seedLine(key)).toEndWith(' "$(encrypted)"');
    expect(script("seed.sh")).toContain("encrypted() { { printf 'k8s:enc:aescbc:v1:key1:';");
    expect(seedLine("/registry/cbor.example.com/gadgets/default/g1")).toContain('"$(hex d9d9f7');
    // The slash-less Secret keeps the marker under the data entry marker: the required Secret Scan's gitleaks
    // decodes a capture's base64, and it read the same entry named password as a leaked credential.
    expect(seedLine("registry/secrets/default/legacy")).toContain(
      `"data":{"marker":"'"$(text libredb-fixture-secret)"'"}`,
    );
    expect(seedLine("compact_rev_key")).toMatch(/^new compact_rev_key '\d+'$/);
  });

  test("put_new writes only while the key does not exist, put_at_version only at the version it names", () => {
    const lib = script("lib.sh");
    expect(shellFunction(lib, "put_new")).toContain(
      '\\"compare\\":[{\\"key\\":\\"$1\\",\\"target\\":\\"CREATE\\",\\"result\\":\\"EQUAL\\",\\"create_revision\\":\\"0\\"}]',
    );
    expect(shellFunction(lib, "put_at_version")).toContain(
      '\\"compare\\":[{\\"key\\":\\"$1\\",\\"target\\":\\"VERSION\\",\\"result\\":\\"EQUAL\\",\\"version\\":\\"$3\\"}]',
    );
  });

  test("rbac.sh grants role reader READ on /app/ and on /config/a alone, and nothing else", () => {
    const grants = calls(script("rbac.sh")).filter((call) => call.path === "/v3/auth/role/grant");
    expect(grants.map((grant) => grant.body)).toEqual([
      '{\\"name\\":\\"reader\\",\\"perm\\":{\\"permType\\":\\"READ\\",\\"key\\":\\"$(text /app/)\\",\\"range_end\\":\\"$(text /app0)\\"}}',
      '{\\"name\\":\\"reader\\",\\"perm\\":{\\"permType\\":\\"READ\\",\\"key\\":\\"$(text /config/a)\\"}}',
    ]);
  });

  test("rbac.sh gives each user its role, and cert-only no password", () => {
    const all = calls(script("rbac.sh"));
    expect(all.filter((call) => call.path === "/v3/auth/user/grant").map((call) => call.body)).toEqual([
      '{"user":"root","role":"root"}',
      '{"user":"reader","role":"reader"}',
      '{"user":"cert-only","role":"reader"}',
    ]);
    const added = all.filter((call) => call.path === "/v3/auth/user/add").map((call) => call.body);
    expect(added).toContain('{"name":"cert-only","options":{"no_password":true}}');
    expect(added.filter((body) => body.includes("cert-only"))).toHaveLength(1);
  });

  test("rbac.sh stops when auth is already on, and turns auth on last", () => {
    const rbac = script("rbac.sh");
    const guard = rbac.indexOf('if auth_enabled; then\n  echo "auth already enabled on $ETCD_URL"\n  exit 0\nfi');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rbac.search(/^call /m));
    const all = calls(rbac);
    expect(all.at(-1)).toEqual({ path: "/v3/auth/enable", body: "{}" });
    expect(all.filter((call) => call.path === "/v3/auth/enable")).toHaveLength(1);
  });

  test("certs.sh names each user's certificate by its Common Name, and the gateway's certificate by none", () => {
    const certs = script("certs.sh");
    const issue = shellFunction(certs, "issue");
    expect(issue).toContain('subject="/CN=$2"');
    expect(issue).toContain('[ -n "$2" ] || subject="/O=libredb-etcd-fixture"');
    expect(issue).toContain('-subj "$subject"');
    const loop = /^for user in ([^;]+); do issue "\$user" "\$user" ca "extendedKeyUsage=clientAuth"; done$/m.exec(
      certs,
    );
    expect(loop?.[1].split(" ")).toEqual(["root", "reader", "cert-only", "unknown-user"]);
    expect(certs).toMatch(/^issue gateway-client "" ca "extendedKeyUsage=clientAuth"$/m);
    expect(certs).toMatch(/^issue other-ca-root root other-ca "extendedKeyUsage=clientAuth"$/m);
  });
});

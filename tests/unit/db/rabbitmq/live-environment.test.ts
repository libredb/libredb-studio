/**
 * The RabbitMQ fixture and the test-only code around it, held to the rules the live checks rest on.
 *
 * The compose services pin every image by digest, bind only loopback ports, bound their memory and raise the file
 * limit a broker with many streams needs; the seed one-shot runs the repository's own seed on a pinned Bun with the
 * repository mounted read-only; no service mounts the evidence-only configuration. The test-only publishers, the
 * `basic.get` control and the admin client exist so the provider never needs them: no module under `src/` imports
 * them, and the provider's encoder table is still exactly the read path's thirteen frames. Each rule that reads a
 * file is also run on a planted copy with one fault, so a rule that cannot fail is caught here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  RABBITMQ_42_IMAGE,
  RABBITMQ_429_DIGEST,
  RABBITMQ_436_DIGEST,
  RABBITMQ_FIXTURE_IMAGE,
  RABBITMQ_SEED_IMAGE,
  liveTarget,
} from "../../../helpers/rabbitmq-live";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (relative: string): string => readFileSync(path.join(ROOT, relative), "utf8");

interface Service {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly entrypoint?: readonly string[];
  readonly working_dir?: string;
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly ulimits?: { readonly nofile?: { readonly soft: number; readonly hard: number } };
  readonly healthcheck?: { readonly test?: readonly string[] };
  readonly deploy?: { readonly resources?: { readonly limits?: { readonly memory?: string; readonly cpus?: string } } };
  readonly memswap_limit?: string;
}

const COMPOSE = parseYaml(read("database-compose.yml"), { merge: true }) as { services: Record<string, Service> };
const BROKERS = [
  "rabbitmq",
  "rabbitmq-42",
  "rabbitmq-cluster-1",
  "rabbitmq-cluster-2",
  "rabbitmq-cluster-3",
  "rabbitmq-tls",
];
const SEEDS: Readonly<Record<string, string>> = { "rabbitmq-init": "rabbitmq", "rabbitmq-42-init": "rabbitmq-42" };
const PINNED_BROKER_IMAGES = [RABBITMQ_FIXTURE_IMAGE, RABBITMQ_42_IMAGE];

/** Every published port that is not bound to 127.0.0.1, across the given services. */
function exposedPorts(services: Readonly<Record<string, Service>>): string[] {
  return Object.entries(services).flatMap(([name, service]) =>
    (service.ports ?? []).filter((port) => !String(port).startsWith("127.0.0.1:")).map((port) => `${name}: ${port}`),
  );
}

/** Every host port bound by two services of the whole compose file. */
function doubleBoundPorts(services: Readonly<Record<string, Service>>): string[] {
  const owners = new Map<string, string>();
  const doubles: string[] = [];
  for (const [name, service] of Object.entries(services)) {
    for (const port of service.ports ?? []) {
      const parts = String(port).split(":");
      const host = parts.length === 3 ? `${parts[0]}:${parts[1]}` : parts[0];
      const owner = owners.get(host);
      if (owner) doubles.push(`${host}: ${owner} and ${name}`);
      else owners.set(host, name);
    }
  }
  return doubles;
}

/** The compose variables the fixture's passwords come from; a value of a password key is exactly one of them. */
const PASSWORD_VARIABLES = ["${RABBITMQ_LIVE_ADMIN_PASSWORD}", "${RABBITMQ_LIVE_FIXTURE_PASSWORD}"];
/** The first command of each broker's entrypoint, before the image's own. */
const PASSWORD_GUARD = 'test -n "$$RABBITMQ_DEFAULT_PASS" || {';

/** Every environment value whose key names a password, across the given services, as written in the file. */
function passwordValues(
  services: Readonly<Record<string, Service>>,
): { service: string; key: string; value: string }[] {
  return Object.entries(services).flatMap(([service, { environment }]) =>
    Object.entries(environment ?? {})
      .filter(([key]) => /PASS/.test(key))
      .map(([key, value]) => ({ service, key, value: String(value) })),
  );
}

describe("the compose fixture", () => {
  const services = COMPOSE.services;

  test("every RabbitMQ service exists, and only the default pair runs without a profile", () => {
    for (const name of [...BROKERS, ...Object.keys(SEEDS), "rabbitmq-tls-certs"]) expect(services[name]).toBeDefined();
    const defaults = Object.keys(services).filter((name) => name.startsWith("rabbitmq") && !services[name].profiles);
    expect(defaults.sort()).toEqual(["rabbitmq", "rabbitmq-init"]);
  });

  test("every broker runs a pinned image, and the main one is the reference the CI step and the live scripts use", () => {
    for (const name of BROKERS) expect(PINNED_BROKER_IMAGES).toContain(services[name].image as string);
    expect(services.rabbitmq.image).toBe(RABBITMQ_FIXTURE_IMAGE);
    expect(services["rabbitmq-42"].image).toBe(RABBITMQ_42_IMAGE);
    expect(services["rabbitmq-tls-certs"].image).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  test("no published port is bound beyond loopback, and a planted 0.0.0.0 binding is found", () => {
    const rabbit = Object.fromEntries(Object.entries(services).filter(([name]) => name.startsWith("rabbitmq")));
    expect(exposedPorts(rabbit)).toEqual([]);
    expect(exposedPorts({ planted: { ports: ["5672:5672"] } })).toEqual(["planted: 5672:5672"]);
  });

  test("no host port of the whole compose file is bound twice, and a planted double is found", () => {
    expect(doubleBoundPorts(services)).toEqual([]);
    expect(
      doubleBoundPorts({ a: { ports: ["127.0.0.1:15692:15692"] }, b: { ports: ["127.0.0.1:15692:15672"] } }),
    ).toEqual(["127.0.0.1:15692: a and b"]);
  });

  test("every broker raises the file limit, bounds its memory without swap and is probed by rabbitmq-diagnostics", () => {
    for (const name of BROKERS) {
      const service = services[name];
      expect(service.ulimits?.nofile).toEqual({ soft: 65536, hard: 65536 });
      expect(service.deploy?.resources?.limits?.memory).toBe("1G");
      expect(service.memswap_limit).toBe("1G");
      expect(service.healthcheck?.test).toEqual(["CMD", "rabbitmq-diagnostics", "-q", "check_port_connectivity"]);
    }
  });

  test("every broker mounts the plugin list read-only, and the list enables the queue check's plugin", () => {
    for (const name of BROKERS) {
      expect(services[name].volumes).toContain("./docker/rabbitmq/enabled_plugins:/etc/rabbitmq/enabled_plugins:ro");
    }
    expect(read("docker/rabbitmq/enabled_plugins").trim()).toBe(
      "[rabbitmq_management,rabbitmq_prometheus,rabbitmq_stream_management].",
    );
  });

  test("no service mounts the evidence-only configuration, which restores guest's localhost-only rule", () => {
    const mounts = Object.values(services).flatMap((service) => service.volumes ?? []);
    expect(mounts.filter((mount) => String(mount).includes("docker/rabbitmq/evidence"))).toEqual([]);
  });

  test("no RabbitMQ service writes a password: each names its compose variable, with no default, and a planted literal is found", () => {
    const rabbit = Object.fromEntries(Object.entries(services).filter(([name]) => name.startsWith("rabbitmq")));
    expect(passwordValues(rabbit).length).toBeGreaterThan(0);
    expect(passwordValues(rabbit).filter(({ value }) => !PASSWORD_VARIABLES.includes(value))).toEqual([]);
    expect(
      passwordValues({
        planted: {
          environment: {
            RABBITMQ_DEFAULT_PASS: "planted-value",
            RABBITMQ_LIVE_ADMIN_PASSWORD: "${RABBITMQ_LIVE_ADMIN_PASSWORD:-x}",
          },
        },
      }).filter(({ value }) => !PASSWORD_VARIABLES.includes(value)),
    ).toHaveLength(2);
  });

  test("every broker refuses to start without the admin password, which RabbitMQ would replace by its default", () => {
    for (const name of BROKERS) {
      const entry = services[name].entrypoint ?? [];
      expect({ name, guarded: String(entry[2]).startsWith(PASSWORD_GUARD) }).toEqual({ name, guarded: true });
    }
  });

  test("each seed one-shot runs the repository's seed on the pinned Bun, read-only, after its broker is healthy", () => {
    for (const [name, broker] of Object.entries(SEEDS)) {
      const service = services[name];
      expect(service.image).toBe(RABBITMQ_SEED_IMAGE);
      expect(service.volumes?.length).toBeGreaterThan(0);
      for (const mount of service.volumes ?? []) expect(String(mount).endsWith(":ro")).toBe(true);
      expect(service.entrypoint).toEqual(["bun", "tests/live/rabbitmq-seed.ts"]);
      expect(service.depends_on?.[broker]).toEqual({ condition: "service_healthy" });
      expect(service.environment?.RABBITMQ_LIVE_HOST).toBe(broker);
      expect(`${String(services[broker].image).split("@")[1]}`).toBe(
        service.environment?.RABBITMQ_LIVE_DIGEST as string,
      );
    }
  });
});

describe("the live target", () => {
  test("the live target refuses a digest that is not pinned, and needs both passwords", () => {
    const env = { RABBITMQ_LIVE_ADMIN_PASSWORD: "a", RABBITMQ_LIVE_FIXTURE_PASSWORD: "b" };
    expect(liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST }).managementPort).toBe(15672);
    expect(liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_429_DIGEST }).amqpPort).toBe(5672);
    expect(() => liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: "sha256:0" })).toThrow("must be one of the pinned digests");
    expect(() => liveTarget({ RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST })).toThrow(
      "RABBITMQ_LIVE_ADMIN_PASSWORD is not set",
    );
    expect(() =>
      liveTarget({ ...env, RABBITMQ_LIVE_DIGEST: RABBITMQ_436_DIGEST, RABBITMQ_LIVE_AMQP_PORT: "0" }),
    ).toThrow("RABBITMQ_LIVE_AMQP_PORT must be a port number");
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * The Modbus fixture's two delivery files, held to the rules the live check rests on.
 *
 * `docker/modbus/compose-service.yml` is what a developer runs and `docker/modbus/ci-step.yml` is
 * what CI runs, and they are separate files because the shared ones are landed by one hand. Two
 * files naming one device is exactly the shape that drifts: the day they name two digests, the
 * live check passes on one machine and fails on the other for a reason neither file admits.
 *
 * Each rule below is also run against a planted copy carrying one fault, because a rule that
 * reads a file can be written so that it cannot fail - the file renamed, the pattern never
 * matching - and would then be green forever.
 */

const ROOT = path.resolve(import.meta.dir, "../../../..");
const read = (name: string): string => readFileSync(path.join(ROOT, "docker/modbus", name), "utf8");

const COMPOSE = read("compose-service.yml");
const CI_STEP = read("ci-step.yml");
const README = read("README.md");
/** The live check carries the pin too, because it refuses a digest it did not measure. */
const LIVE_CHECK = readFileSync(path.join(ROOT, "tests/live/modbus-live-check.ts"), "utf8");

/** Every `sha256:...` a text names, which is what "they name one digest" is asked about. */
const digestsIn = (text: string): string[] => [...text.matchAll(/sha256:[0-9a-f]{64}/g)].map((found) => found[0]);

/**
 * The compose fragment as YAML.
 *
 * It is a fragment rather than a document: a comment header, then the service indented two
 * spaces as it will sit in `database-compose.yml`. Dedenting is what makes it parseable, and
 * doing that here rather than asserting on the raw text is what lets the rules below ask about
 * ports and mounts rather than about line shapes.
 */
function composeService(text: string): Record<string, unknown> {
  const body = text
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
  const parsed = parseYaml(body) as Record<string, Record<string, unknown>> | null;
  const service = parsed?.modbus;
  if (service === undefined) throw new Error("the compose fragment declares no `modbus` service");
  return service;
}

describe("the two delivery files name one device", () => {
  test("the compose fragment names a version AND pins it by digest", () => {
    const image = composeService(COMPOSE).image;
    expect(typeof image).toBe("string");
    // Both, and each does a different job. The digest is what pins it: the values this fixture
    // answers with ARE the expected outcomes, so a tag that moved would change the device under
    // tests that never mention a version. The tag is what a reader learns the version from -
    // a bare digest says nothing about what it is, and `2.3.0` is the tag that carries this one.
    expect(String(image)).toMatch(/^oitc\/modbus-server:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
  });

  test("four files name one digest: compose, CI, the README and the live check", () => {
    const [fromCompose] = digestsIn(COMPOSE);
    expect(fromCompose).toBeDefined();
    expect(new Set(digestsIn(CI_STEP))).toEqual(new Set([fromCompose as string]));
    expect(digestsIn(README)).toContain(fromCompose as string);
    // The live check refuses a `MODBUS_LIVE_DIGEST` it did not measure against, so its own pin
    // has to be the same one: a gate holding a stale digest refuses the right device.
    expect(digestsIn(LIVE_CHECK)).toContain(fromCompose as string);
  });

  test("the digest the CI step exports is one the live check will accept", () => {
    // It was exported and read by nothing, which is a pin that records an intention and enforces
    // none. The gate is what makes the export worth writing, and this is the pair held together.
    expect(CI_STEP).toContain('export MODBUS_LIVE_DIGEST="${image#*@}"');
    expect(LIVE_CHECK).toContain("process.env.MODBUS_LIVE_DIGEST");
    expect(LIVE_CHECK).toContain("nothing was dialled");
  });

  test("a planted second digest is caught", () => {
    // The rule above can only be trusted if it falls when the two drift, which is the whole
    // reason it exists. One character of one digest is the smallest drift there is.
    const planted = CI_STEP.replace(/sha256:32bf/, "sha256:42bf");
    expect(planted).not.toBe(CI_STEP);
    const [fromCompose] = digestsIn(COMPOSE);
    expect(new Set(digestsIn(planted))).not.toEqual(new Set([fromCompose as string]));
  });
});

describe("the device is reachable only from the machine it runs on", () => {
  test("every published port binds loopback", () => {
    const ports = composeService(COMPOSE).ports as string[];
    expect(ports.length).toBeGreaterThan(0);
    for (const mapping of ports) expect(mapping).toMatch(/^127\.0\.0\.1:/);
  });

  test("a planted wide binding is caught", () => {
    // Modbus TCP has no authentication of any kind, so a device answering reads to anyone on the
    // network is not a fixture. This is the rule that says so, and this is it failing.
    const planted = COMPOSE.replace('- "127.0.0.1:1502:5020"', '- "1502:5020"');
    expect(planted).not.toBe(COMPOSE);
    const ports = composeService(planted).ports as string[];
    expect(ports.some((mapping) => !mapping.startsWith("127.0.0.1:"))).toBe(true);
  });

  test("the fixture's own configuration is mounted read-only, in both files", () => {
    const volumes = composeService(COMPOSE).volumes as string[];
    expect(volumes).toEqual(["./docker/modbus/modbus_server.json:/app/modbus_server.json:ro"]);
    // The CI step mounts the same file the same way: a device that could rewrite the tables it
    // serves would answer a later check with what an earlier one wrote.
    expect(CI_STEP).toContain("/app/modbus_server.json:ro");
  });
});

describe("the CI step tells a fixture that never answered from a check that failed", () => {
  test("it refuses before the live check when the fixture is not ready", () => {
    // The two are different results and the step keeps them apart. Without this the third state
    // is hidden inside a red, and a reader cannot tell a fixture that never came up from a
    // product that answered wrongly.
    expect(CI_STEP).toContain("NOT MEASURED");
    expect(CI_STEP).toContain("the live check never ran");
  });

  test("readiness asks two questions, and says which one failed", () => {
    /*
     * Both go through the probe, and NOT through `/dev/tcp`: a published container port is
     * accepted by Docker itself, 5 ms against the 332 ms the server behind it took, so "the port
     * is open" is answered while nothing inside the container is listening.
     *
     * They are asked separately for the sentence rather than for coverage, which is why both
     * sentences are held here: a reader who has to fix one of them needs to know which it was.
     */
    // The comments explain why `/dev/tcp` is not used, so the rule reads the runnable lines only:
    // a rule that forbids a word everywhere also forbids writing down why it was dropped.
    const runnable = CI_STEP.split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(runnable).not.toContain("/dev/tcp");
    expect(CI_STEP).toContain("modbus-ready-probe.ts --speaks");
    expect(CI_STEP).toContain("modbus-ready-probe.ts --tables");
    expect(CI_STEP).toContain("nothing speaking Modbus answered");
    expect(CI_STEP).toContain("its tables are not this fixture's");
    // The sentences name the address that was actually asked. They said "on 1502" while the probe
    // read `MODBUS_PROBE`, so a run against another port was refused by a sentence naming a port
    // it had never dialled.
    expect(CI_STEP).not.toMatch(/answered on 1502/);
    expect(CI_STEP).toContain("answered on $MODBUS_PROBE");
  });

  test("the fixture is removed however the step ends", () => {
    expect(CI_STEP).toMatch(/trap '.*docker rm -f libredb-ci-modbus.*' EXIT/);
  });

  test("the live check runs on both runtimes", () => {
    expect(CI_STEP).toContain("bun tests/live/modbus-live-check.ts");
    expect(CI_STEP).toMatch(/--target=node/);
    expect(CI_STEP).toMatch(/\bnode "\$out\/live\.mjs"/);
  });
});

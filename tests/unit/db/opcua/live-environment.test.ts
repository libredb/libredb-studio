import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

/**
 * The OPC UA fixture's own environment: where it publishes, and what image it is.
 *
 * WHY THIS FILE EXISTS. The rule that a fixture publishes on loopback alone is held ENGINE BY
 * ENGINE, by a file of this name: databend, etcd, oxia, rabbitmq, s3 and vector each have one, and
 * OPC UA had none. MEASURED, and it is why this was written: the fixture's command line read
 * `-p 54840:50000`, which is Docker's default of `0.0.0.0`, and reverting it turned NOTHING red.
 * The server is started `--autoaccept --unsecuretransport`, so that binding put a server which
 * accepts any client on every interface of whatever machine ran it, CI included.
 *
 * Wider than this engine, and recorded here because this file is where someone will look:
 * `database-compose.yml` publishes 61 ports on 127.0.0.1 and 49 with no address at all. The
 * convention is followed about half the time and guarded only where an engine wrote its own check.
 *
 * It reads the README rather than a compose service because OPC UA has no compose service yet: the
 * fixture is a `docker run` line. When that line becomes a service, this file reads the service and
 * the assertions below do not change.
 */
const ROOT = path.resolve(import.meta.dir, "../../../..");
const README = readFileSync(path.join(ROOT, "tests/fixtures/opcua/README.md"), "utf8");
const CI_STEP = readFileSync(path.join(ROOT, "docker/opcua/ci-step.yml"), "utf8");
const SERVICE = readFileSync(path.join(ROOT, "docker/opcua/compose-service.yml"), "utf8");

/** The `docker run` line the capture is started with, which is the fixture's definition. */
const runLine = (): string => {
  const line = README.split("\n").find((candidate) => candidate.includes("docker run -d --name opcua-evidence"));
  // An absent line is a fault, not a pass: every assertion below would be vacuous against undefined.
  if (line === undefined) throw new Error("the fixture README no longer carries its `docker run` line");
  return line;
};

/** Every published port of a `docker run` line, as written: `-p <value>`. */
const publishedPorts = (line: string): string[] => [...line.matchAll(/-p\s+(\S+)/g)].map((match) => match[1]);

describe("the OPC UA fixture's environment", () => {
  test("the README is the real one: it names the image and the capture's container", () => {
    // The guard that makes the rest measurements rather than reads of an empty string.
    expect(README.length).toBeGreaterThan(1000);
    expect(runLine()).toContain("opcua-evidence");
  });

  test("every published port is bound to loopback, and a planted 0.0.0.0 binding is found", () => {
    const published = publishedPorts(runLine());
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((port) => !port.startsWith("127.0.0.1:"))).toEqual([]);
    // The planted case, in the shape the defect had: `-p 54840:50000` with no host address is
    // Docker's `0.0.0.0`, and the filter above is what catches it.
    expect(
      publishedPorts("docker run -d --name opcua-evidence -p 54840:50000 \\").filter(
        (port) => !port.startsWith("127.0.0.1:"),
      ),
    ).toEqual(["54840:50000"]);
  });

  test("the image is pinned by tag AND digest, in the README and in the CI step alike", () => {
    // A digest says what ran; a tag says which release it was, which is what a reader needs when
    // the figures in `docs/providers/opcua.md` are re-measured against a newer server.
    const pin = /mcr\.microsoft\.com\/iotedge\/opc-plc:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}/;
    expect(README).toMatch(pin);
    expect(CI_STEP).toMatch(pin);
  });

  test("the CI step runs the image the README documents, not another one", () => {
    // The two drift apart silently otherwise: the step would measure a server the captures were
    // never taken from, and every figure the provider's comments carry would be about the old one.
    const of = (text: string): string | undefined =>
      text.match(/mcr\.microsoft\.com\/iotedge\/opc-plc:[\d.]+@sha256:[0-9a-f]{64}/)?.[0];
    expect(of(CI_STEP)).toBeDefined();
    expect(of(CI_STEP)).toBe(of(README));
  });

  test("the compose service publishes on loopback and runs the same image", () => {
    // The block is written to be merged into `database-compose.yml`; until it is, this is the only
    // thing holding it to the two files beside it. A third copy of an image reference is a third
    // thing to drift.
    expect(SERVICE).toContain('"127.0.0.1:54840:50000"');
    expect(SERVICE.match(/mcr\.microsoft\.com\/iotedge\/opc-plc:[\d.]+@sha256:[0-9a-f]{64}/)?.[0]).toBe(
      README.match(/mcr\.microsoft\.com\/iotedge\/opc-plc:[\d.]+@sha256:[0-9a-f]{64}/)?.[0],
    );
  });

  test("the compose service carries the flags the captures were measured against", () => {
    // The flags ARE the fixture: `--hn` is what adds the one historized node, and every node count
    // in the provider's comments was measured with this list. A service missing one would serve a
    // different server under the same name.
    //
    // Read from the PARSED command rather than from the file's text, and the difference is not
    // cosmetic: `--hn` appears twice in the file, once in the comment that explains it, so a
    // `toContain` over the text stayed green with the flag deleted from the command. The canary
    // caught that, which is what canaries are for.
    const command = (parseYaml(SERVICE) as { opcua: { command: readonly string[] } }).opcua.command;
    expect(command).toEqual([
      "--pn=50000",
      "--autoaccept",
      "--unsecuretransport",
      "--ut",
      "--sph",
      "--hn",
      "--slownodes=3",
      "--fastnodes=3",
    ]);
  });

  test("the CI step publishes on loopback too, and silences nothing", () => {
    expect(CI_STEP).toContain("-p 127.0.0.1:54840:50000");
    // The four shapes that would turn a red step green without anyone deciding to.
    for (const silencer of ["continue-on-error", "|| true", "set +e"]) expect(CI_STEP).not.toContain(silencer);
  });
});

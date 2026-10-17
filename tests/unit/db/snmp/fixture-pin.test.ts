/**
 * The fixture's base image is pinned in two files, and this holds them equal.
 *
 * WHY. `docker/snmp/Dockerfile` pins `debian:trixie-slim` by digest, and `docker/snmp/ci-step.yml`
 * carries the same digest so that the CI run can say which image it measured. A value that lives
 * in two files and is compared by nobody is two values: the day one of them moves, the step keeps
 * reporting the digest of an image it no longer builds, and every number it prints is attributed
 * to the wrong thing.
 *
 * This is the pin's only reader. The packages are pinned in the Dockerfile alone (`snmpd=` and
 * `snmp=`), so there is nothing to compare for them, and this file says so rather than leaving a
 * reader to wonder whether it forgot them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DOCKER = join(import.meta.dirname, "..", "..", "..", "..", "docker", "snmp");
const dockerfile = readFileSync(join(DOCKER, "Dockerfile"), "utf8");
const ciStep = readFileSync(join(DOCKER, "ci-step.yml"), "utf8");

describe("the SNMP fixture's pin", () => {
  test("the Dockerfile pins its base by digest, not by tag alone", () => {
    const from = /^FROM debian:trixie-slim@(sha256:[0-9a-f]{64})$/m.exec(dockerfile);
    expect(from?.[1]).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("the CI step names the same digest the Dockerfile builds from", () => {
    const built = /@(sha256:[0-9a-f]{64})/.exec(dockerfile)?.[1];
    const announced = /base="(sha256:[0-9a-f]{64})"/.exec(ciStep)?.[1];
    expect({ built, announced }).toEqual({ built, announced: built });
  });

  test("the two Net-SNMP packages are pinned to an exact version", () => {
    // Pinned in one place only, so there is nothing to compare: the assertion is that the pin
    // exists at all, because `apt-get install snmpd` takes whatever the archive holds that day.
    expect(dockerfile).toMatch(/snmpd=\d+\.\d+\.\d+\+dfsg-\d+\+deb\d+u\d+/);
    expect(dockerfile).toMatch(/snmp=\d+\.\d+\.\d+\+dfsg-\d+\+deb\d+u\d+/);
  });

  test("the fixture is published to loopback only, in both files that publish it", () => {
    // A fixture that binds every interface is a device on the network of whoever runs the suite.
    expect(ciStep).toContain("-p 127.0.0.1:1161:161/udp");
    expect(readFileSync(join(DOCKER, "compose-service.yml"), "utf8")).toContain('"127.0.0.1:1161:161/udp"');
  });
});

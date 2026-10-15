/**
 * This instance's id under governance (docs/GOVERNANCE.md#instance-id).
 *
 * The id keys the heartbeat row and names the listener's ping channel, so it must survive a restart. A container's
 * host name is its id and changes on every recreate, which would leave a dead heartbeat row each time, so
 * `GOVERNANCE_INSTANCE_ID` is required and nothing stands in for it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { CONTRACT_OBJECTS } from "@/lib/governance/contract";
import { governanceInstanceId } from "@/lib/governance/instance";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const POD_NAME = "libredb-studio-7d9f8c6b5-x2kq7";

let savedId: string | undefined;
let savedHostname: string | undefined;

beforeEach(() => {
  savedId = process.env.GOVERNANCE_INSTANCE_ID;
  savedHostname = process.env.HOSTNAME;
  delete process.env.GOVERNANCE_INSTANCE_ID;
  // What a Kubernetes pod or a Docker container would offer as a fallback, were there one.
  process.env.HOSTNAME = POD_NAME;
});

afterEach(() => {
  if (savedId === undefined) delete process.env.GOVERNANCE_INSTANCE_ID;
  else process.env.GOVERNANCE_INSTANCE_ID = savedId;
  if (savedHostname === undefined) delete process.env.HOSTNAME;
  else process.env.HOSTNAME = savedHostname;
});

/** The error governanceInstanceId() throws, or a failure when it returns. */
function refusal(): Error {
  try {
    const id = governanceInstanceId();
    throw new Error(`expected a refusal, got the id ${JSON.stringify(id)}`);
  } catch (error) {
    return error as Error;
  }
}

describe("governanceInstanceId", () => {
  test("a missing or malformed GOVERNANCE_INSTANCE_ID is refused and no hostname is used in its place", () => {
    for (const value of [undefined, ""]) {
      if (value === undefined) delete process.env.GOVERNANCE_INSTANCE_ID;
      else process.env.GOVERNANCE_INSTANCE_ID = value;
      const error = refusal();
      expect(error.message).toContain("GOVERNANCE_INSTANCE_ID is not set");
      expect(error.message).not.toContain(POD_NAME);
      expect(error.message).not.toContain(hostname());
    }

    for (const value of [
      "libredb studio",
      "libredb/studio",
      " libredb-studio",
      "studio\n",
      "stüdio",
      "a".repeat(129),
    ]) {
      process.env.GOVERNANCE_INSTANCE_ID = value;
      const error = refusal();
      expect(error.message, value).toContain(
        "GOVERNANCE_INSTANCE_ID must be 1 to 128 ASCII letters, digits, dots, underscores, colons or hyphens",
      );
      expect(error.message, value).toContain(JSON.stringify(value));
      expect(error.message, value).not.toContain(POD_NAME);
    }
  });

  test("a well-formed id is returned exactly as set", () => {
    for (const value of ["libredb-studio", "studio-0", "eu.west:studio_2", "a".repeat(128)]) {
      process.env.GOVERNANCE_INSTANCE_ID = value;
      expect(governanceInstanceId()).toBe(value);
    }
  });

  test("the rule is the CHECK on the heartbeat's instance_id column", () => {
    const table = CONTRACT_OBJECTS.find((object) => object.name === "studio_instance");
    if (table === undefined || table.kind === "function") throw new Error("no studio_instance table in the contract");
    const check = table.columns.find((column) => column.name === "instance_id")?.check;
    if (check?.kind !== "pattern") throw new Error("instance_id has no pattern CHECK");
    const rule = new RegExp(check.pattern);
    for (const value of [
      "libredb-studio",
      "a.b_c:d-e",
      "a".repeat(128),
      "a".repeat(129),
      "libredb studio",
      "a/b",
      "ü",
    ]) {
      process.env.GOVERNANCE_INSTANCE_ID = value;
      let accepted = true;
      try {
        governanceInstanceId();
      } catch {
        accepted = false;
      }
      expect(accepted, value).toBe(rule.test(value));
    }
  });

  test("instance.ts reads GOVERNANCE_INSTANCE_ID and nothing else, and imports nothing", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/governance/instance.ts"), "utf8");
    expect([...source.matchAll(/^\s*import\s/gm)]).toHaveLength(0);
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    expect([...source.matchAll(/process\.env(?:\.(\w+)|\[)/g)].map((match) => match[1])).toEqual([
      "GOVERNANCE_INSTANCE_ID",
    ]);
  });
});

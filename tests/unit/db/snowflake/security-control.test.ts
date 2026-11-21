/**
 * docs/SECURITY.md names the Snowflake provider's HTTP controls: row 0.6 gains the account reader, which builds the
 * one origin Studio connects to from the Account field, and the transport, with the tests that drive them. This test
 * holds that every file and test the row cites is linked by its full repository path and exists;
 * scripts/security-check.mjs, run by tests/unit/security-check.test.ts, then proves every linked test runs.
 *
 * The address policy is proven here on the provider's own connect path rather than in
 * `tests/unit/db/http/egress-policy-providers.test.ts`: that census connects each provider to a loopback listener by
 * the host `localhost`, while a Snowflake Account is always read into a Snowflake host, so a private address can
 * only come from DNS. The resolver is stubbed (the runner gives this file its own process, so the module mock reaches
 * no other test file): a PrivateLink host answering 10.0.0.5 under DB_HTTP_BLOCK_PRIVATE_HOSTS is refused at the
 * lookup, before any socket, and no name is resolved by a real resolver.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { LookupAddress } from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setEgressFlag } from "../../../helpers/egress-flag";

const realDns = { ...(await import("node:dns")) };
const lookups: string[] = [];
const PRIVATE_ANSWER: LookupAddress = { address: "10.0.0.5", family: 4 };
type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  addresses: LookupAddress[] | string,
  family?: number,
) => void;
const stubLookup = (hostname: string, options: unknown, callback?: LookupCallback) => {
  const done = (typeof options === "function" ? options : callback) as LookupCallback;
  lookups.push(hostname);
  const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
  if (all) done(null, [PRIVATE_ANSWER]);
  else done(null, PRIVATE_ANSWER.address, PRIVATE_ANSWER.family);
};
mock.module("node:dns", () => ({ ...realDns, lookup: stubLookup, default: { ...realDns, lookup: stubLookup } }));

const { DatabaseConfigError } = await import("@/lib/db/errors");
const { BLOCKED_HOST } = await import("@/lib/db/http/egress-policy");
const { SnowflakeProvider } = await import("@/lib/db/providers/sql/snowflake/index");

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const DIRECTORY = "src/lib/db/providers/sql/snowflake";
const TESTS = "tests/unit/db/snowflake";

function controlRow(id: string): { status: string; control: string; enforcedIn: string; verifiedBy: string } {
  const row = SECURITY.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
  const [, control = "", status = "", enforcedIn = "", verifiedBy = ""] = row.split(" | ");
  return { status, control, enforcedIn, verifiedBy };
}

function link(file: string): string {
  return `[\`${file}\`](../${file})`;
}

const ENFORCED_IN = [`${DIRECTORY}/account.ts`, `${DIRECTORY}/transport.ts`];

const VERIFIED_BY = [
  `${TESTS}/account.test.ts`,
  `${TESTS}/transport.test.ts`,
  `${TESTS}/wire.test.ts`,
  `${TESTS}/seam-guard.test.ts`,
  `${TESTS}/security-control.test.ts`,
];

describe("row 0.6 names the Snowflake transport", () => {
  const row = controlRow("0.6");

  test("is an implemented control", () => {
    expect(row.status).toBe("Implemented");
  });

  test.each(ENFORCED_IN)("is enforced in %s, which exists", (file) => {
    expect(row.enforcedIn).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });

  test.each(VERIFIED_BY)("is verified by %s, which exists", (file) => {
    expect(row.verifiedBy).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });
});

describe("the address policy on the Snowflake connect path", () => {
  const flag = "DB_HTTP_BLOCK_PRIVATE_HOSTS";
  const original = process.env[flag];

  afterEach(() => {
    setEgressFlag(original);
    lookups.length = 0;
  });

  test("a PrivateLink host resolving to a private address is refused at the lookup, before any socket", async () => {
    setEgressFlag("true");
    const provider = new SnowflakeProvider({
      id: "blocked-snowflake",
      name: "Blocked Snowflake",
      type: "snowflake",
      host: "xy12345.us-east-1.privatelink",
      user: "studio_svc",
      role: "STUDIO_RO",
      authMethod: "pat",
      password: "pat-value",
      createdAt: new Date(0),
    } as never);
    const failure = await provider.connect().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DatabaseConfigError);
    expect((failure as Error).message).toContain(BLOCKED_HOST);
    expect(lookups).toEqual(["xy12345.us-east-1.privatelink.snowflakecomputing.com"]);
    await provider.disconnect();
  });
});

import { describe, expect, test } from "bun:test";
import { databendCloudHostWarehouse, isDatabendCloudHost } from "@/lib/db/providers/sql/databend/cloud-host";
import { DATABEND_ERROR_SENTENCES } from "@/lib/db/providers/sql/databend/errors";
import { DatabendProvider } from "@/lib/db/providers/sql/databend/index";
import { LOGOUT_PATH, QUERY_PATH } from "@/lib/db/providers/sql/databend/routes";
import {
  idsOf,
  ok,
  pathsOf,
  type ScriptedStep,
  scriptedNodeTransport,
  testConnection,
  transportDeps,
} from "../../../helpers/databend-node-transport";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import { parseConnectionString } from "@/lib/connection-string-parser";
import { DATABEND_DEFAULT_PORT } from "@/lib/db/providers/sql/databend/connection-options";
import { type DatabaseConnection } from "@/lib/types";

/**
 * Which hosts are Databend Cloud's, and the warehouse an older one names (section 4.4 of the provider doc).
 *
 * BendSQL's `check_presign` (`core/src/client.rs`) and databend-jdbc's `initializePresign`
 * (`DatabendSessionHandle.java`) count a host ending in `.databend.com`, `.databend.cn` or `.tidbcloud.com` as
 * Databend Cloud's when they choose their presign mode. Studio takes the same three domains for the question of billed
 * compute, and reads the older host form, which Databend's docs show under the first two only, there alone.
 */
describe("isDatabendCloudHost", () => {
  test.each([
    ["the gateway host", "tn3ftqihs.gw.aws-us-east-2.default.databend.com"],
    ["a host in China", "tnf34b0rm.gw.aliyun-cn-beijing.default.databend.cn"],
    ["a host under tidbcloud.com, which both clients count with the two", "tn3ftqihs.gw.aws-us-east-2.tidbcloud.com"],
    ["a host in capitals, with a trailing dot", "TN3FTQIHS.GW.AWS-US-EAST-2.TIDBCLOUD.COM."],
  ])("%s is Databend Cloud's", (_case, host) => {
    expect(isDatabendCloudHost(host)).toBe(true);
  });

  test.each([
    "tidbcloud.com",
    "nottidbcloud.com",
    "tn3ftqihs.gw.tidbcloud.com.example.net",
    "databend.com",
    "databend.internal",
  ])("%s is not", (host) => {
    expect(isDatabendCloudHost(host)).toBe(false);
  });
});

describe("databendCloudHostWarehouse", () => {
  test("names the warehouse of an older host under databend.com and databend.cn, the domains its form is shown under", () => {
    expect(databendCloudHostWarehouse("tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com")).toBe("eric");
    expect(databendCloudHostWarehouse("tnf34b0rm--elt-wh-medium.gw.aliyun-cn-beijing.default.databend.cn")).toBe(
      "elt-wh-medium",
    );
    expect(databendCloudHostWarehouse("tn3ftqihs--eric.gw.aws-us-east-2.default.tidbcloud.com")).toBeUndefined();
    expect(databendCloudHostWarehouse("tn3ftqihs.gw.aws-us-east-2.default.databend.com")).toBeUndefined();
  });
});

describe("a Databend Cloud host through the provider", () => {
  test("a host under tidbcloud.com with Warehouse empty declares resumesBilledCompute, so no background check runs", () => {
    const provider = new DatabendProvider(
      testConnection({ host: "tn3ftqihs.gw.aws-us-east-2.tidbcloud.com", port: 443, warehouse: "" }),
    );
    expect(provider.getCapabilities().resumesBilledCompute).toBe(true);
  });

  const OLDER = "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com";

  /**
   * A provider on the older host with Warehouse empty, connected through the version probe and the `no_password` read,
   * then running `SELECT 1` against `steps`. Answers the failure's message and every request's warehouse header.
   */
  async function failedStatement(steps: readonly ScriptedStep[]) {
    const script = scriptedNodeTransport([
      { method: "POST", path: QUERY_PATH, reply: ok(idsOf(1)) },
      { method: "POST", path: QUERY_PATH, reply: ok(idsOf(2)) },
      ...steps,
    ]);
    const time = transportDeps(script);
    const provider = new DatabendProvider(
      testConnection({ host: OLDER, port: 443, warehouse: "", ssl: { mode: "verify-system" } }),
      { queryTimeout: 60_000 },
      { egress: ALLOWS_PRIVATE_HOSTS },
      time.deps,
    );
    await provider.connect();
    const failure = await provider.query("SELECT 1").catch((error: unknown) => error);
    await provider.disconnect();
    script.expectDone();
    return {
      message: (failure as Error).message,
      headers: script.requests.map((request): string | undefined => request.headers["x-databend-warehouse"]),
    };
  }

  // Section 10: connect() names the host's warehouse in the options every failure sentence reads, while the header
  // stays the Warehouse field's.
  test("an older host's POST that gets no answer says its warehouse may still be starting, and no header is sent", async () => {
    const { message, headers } = await failedStatement([
      { method: "POST", path: QUERY_PATH, reply: { status: 502 } },
      // The statement may have reached the warehouse, so it is killed and its session ended.
      { method: "GET", path: pathsOf(idsOf(3).queryId).kill, reply: { status: 200 } },
      { method: "POST", path: LOGOUT_PATH, reply: { status: 200 } },
    ]);
    expect(message).toBe(
      `${DATABEND_ERROR_SENTENCES.noAnswer("HTTP 502")} ${DATABEND_ERROR_SENTENCES.warehouseStarting}`,
    );
    expect(headers).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  test("an older host's GET answered 503 past its retries reads as its warehouse resuming", async () => {
    const ids = idsOf(3);
    const paths = pathsOf(ids.queryId);
    const busy: ScriptedStep = { method: "GET", path: paths.page(1), reply: { status: 503 } };
    const { message } = await failedStatement([
      { method: "POST", path: QUERY_PATH, reply: ok(ids, { state: "Running", next_uri: paths.page(1) }) },
      busy,
      busy,
      busy,
      { method: "GET", path: paths.kill, reply: { status: 200 } },
    ]);
    expect(message).toBe(DATABEND_ERROR_SENTENCES.resuming("eric", "60"));
  });
});

const CONNECTION: DatabaseConnection = {
  id: "databend-doc",
  name: "Databend",
  type: "databend",
  host: "localhost",
  port: DATABEND_DEFAULT_PORT,
  user: "root",
  createdAt: new Date(0),
};

describe("the billed Cloud hosts", () => {
  test("both Cloud host forms resume billed compute, and only the older one names its warehouse", () => {
    const older = "tn3ftqihs--eric.gw.aws-us-east-2.default.databend.com";
    expect(new DatabendProvider({ ...CONNECTION, host: older }).getCapabilities().resumesBilledCompute).toBe(true);
    expect(parseConnectionString(`databend://cloudapp@${older}:443/default`)?.warehouse).toBe("eric");
    const lake = "tn3ftqihs--eric.gw.aws-us-east-2.default.tidbcloud.com";
    expect(new DatabendProvider({ ...CONNECTION, host: lake }).getCapabilities().resumesBilledCompute).toBe(true);
    expect(parseConnectionString(`databend://cloudapp@${lake}:443/default`)?.warehouse).toBeUndefined();
  });
});

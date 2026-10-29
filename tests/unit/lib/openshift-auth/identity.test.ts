import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readOpenShiftIdentity } from "@/lib/openshift-auth/identity";
import {
  ACCESS_TOKEN,
  type FakeCluster,
  startFakeCluster,
  USER_PATH,
} from "../../../helpers/openshift-auth/fake-cluster";

let cluster: FakeCluster;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  cluster.reset();
  cluster.useEnv();
});

const UID = "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f";
/** 21 + 1 + 245 * 2 = 512 bytes of UTF-8. */
const NAME_512 = `dev.a+ops@example.com${"x"}${"é".repeat(245)}`;

describe("readOpenShiftIdentity", () => {
  test("answers the user's name and uid only: groups and identities are not read", async () => {
    cluster.user = { name: "dev-a", uid: UID, groups: ["system:authenticated", "system:cluster-admins"] };
    const reading = await readOpenShiftIdentity(ACCESS_TOKEN);
    expect(reading).toEqual({ kind: "ok", identity: { name: "dev-a", uid: UID } });
    if (reading.kind === "ok") expect(Object.keys(reading.identity).sort()).toEqual(["name", "uid"]);
  });

  test("sends the access token as the bearer and no other credential", async () => {
    await readOpenShiftIdentity(ACCESS_TOKEN);
    expect(cluster.requests).toHaveLength(1);
    const [request] = cluster.requests;
    expect(request.server).toBe("api");
    expect(request.method).toBe("GET");
    expect(request.path).toBe(USER_PATH);
    expect(request.query).toBe("");
    expect(request.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.body).toBe("");
  });

  test("accepts a 512-byte UTF-8 name with dots, @ and +", async () => {
    expect(Buffer.byteLength(NAME_512)).toBe(512);
    cluster.user = { name: NAME_512, uid: UID, groups: [] };
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "ok", identity: { name: NAME_512, uid: UID } });
  });

  test("a 404 means an external OIDC cluster", async () => {
    cluster.script(USER_PATH, { status: 404, body: "{}" });
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "external-oidc" });
  });

  test("a 401, a 403, a 302 or a body that is not a User fails with its status", async () => {
    expect(await readOpenShiftIdentity("sha256~not-a-real-token-2")).toEqual({ kind: "failed", status: 401 });
    cluster.script(USER_PATH, { status: 403, body: "{}" });
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "failed", status: 403 });
    cluster.script(USER_PATH, { status: 302, headers: { location: "https://elsewhere.example.com/" } });
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "failed", status: 302 });
    for (const body of [
      JSON.stringify({ kind: "Group", metadata: { name: "dev-a", uid: UID } }),
      "not json",
      "null",
      "[]",
    ]) {
      cluster.script(USER_PATH, { status: 200, body });
      expect(await readOpenShiftIdentity(ACCESS_TOKEN), body).toEqual({ kind: "failed", status: 200 });
    }
  });

  test("a 5xx or a transport failure is unreachable", async () => {
    cluster.script(USER_PATH, { status: 500, body: "{}" });
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "unreachable", reason: "status", status: 500 });
    writeFileSync(cluster.caFile, "no certificate");
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "unreachable", reason: "ca" });
  });

  test("no uid, or a name the rules refuse, fails closed as no-uid", async () => {
    const cases: [Partial<{ name: unknown; uid: unknown }>, string | null][] = [
      [{ name: "kube:admin", uid: undefined }, "kube:admin"],
      [{ name: "dev-a", uid: "" }, "dev-a"],
      [{ name: "dev-a", uid: "u".repeat(129) }, "dev-a"],
      [{ name: "dev-a", uid: "uid\nwith-newline" }, "dev-a"],
      [{ name: "dev-a", uid: 7 }, "dev-a"],
      [{ name: "", uid: UID }, null],
      [{ name: "system:admin", uid: UID }, null],
      [{ name: "dev\u0007a", uid: UID }, null],
      [{ name: "dev\u0085a", uid: UID }, null],
      [{ name: `${NAME_512}x`, uid: UID }, null],
      [{ name: undefined, uid: UID }, null],
    ];
    for (const [user, name] of cases) {
      cluster.script(USER_PATH, {
        status: 200,
        body: JSON.stringify({ kind: "User", metadata: { name: user.name, uid: user.uid } }),
      });
      expect(await readOpenShiftIdentity(ACCESS_TOKEN), JSON.stringify(user).slice(0, 60)).toEqual({
        kind: "no-uid",
        name,
      });
    }
    cluster.script(USER_PATH, { status: 200, body: JSON.stringify({ kind: "User" }) });
    expect(await readOpenShiftIdentity(ACCESS_TOKEN)).toEqual({ kind: "no-uid", name: null });
  });
});

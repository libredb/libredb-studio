/**
 * The openshift sign-in role seam (src/lib/openshift-auth/role.ts): the role is the self review's, made with the new
 * access token, and the identity changes nothing; the detail of every branch is in
 * tests/unit/lib/kubernetes-access/openshift-admin.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { openShiftSignInRole } from "@/lib/openshift-auth/role";
import { ACCESS_TOKEN, type FakeCluster, startFakeCluster } from "../../../helpers/openshift-auth/fake-cluster";

const UID = "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f";
const UPDATE_STUDIO = {
  user: "dev-a",
  verb: "update",
  apiGroup: "apps",
  resource: "deployments",
  namespace: "os-lab-studio",
  name: "studio",
};
const KEYS = ["KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT", "KUBERNETES_ACCESS_REVIEW_SIGN_IN"] as const;

let cluster: FakeCluster;
let saved: Record<string, string | undefined>;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
  delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
  cluster.reset();
  cluster.useEnv();
});

afterEach(() => {
  cluster.restoreEnv();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("openShiftSignInRole", () => {
  test("is admin only when the token's own review allows update on Studio's Deployment, whatever the identity says", async () => {
    for (const name of ["dev-a", "os-admin", "kube:admin", "system:cluster-admins"]) {
      expect(await openShiftSignInRole({ name, uid: UID }, ACCESS_TOKEN), name).toBe("user");
    }
    cluster.grants = [UPDATE_STUDIO];
    expect(await openShiftSignInRole({ name: "someone-else", uid: UID }, ACCESS_TOKEN)).toBe("admin");
    expect(cluster.selfReviews().every((request) => request.headers.authorization === `Bearer ${ACCESS_TOKEN}`)).toBe(
      true,
    );
  });

  test("is null, which refuses the sign-in, when the optional sign-in review does not allow it", async () => {
    process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN = "get services/studio -n os-lab-studio";
    cluster.grants = [UPDATE_STUDIO];
    expect(await openShiftSignInRole({ name: "dev-a", uid: UID }, ACCESS_TOKEN)).toBeNull();
  });
});

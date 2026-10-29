/**
 * The admin check `readSession` runs on every request of an openshift session (src/lib/auth.ts, with
 * `reviewedSessionRole` of src/lib/kubernetes-access/gate.ts): an admin session keeps admin only while its own token's
 * review allows update on Studio's Deployment, read through the decision cache; a deny or a failure demotes the request
 * to user and keeps the session; a 401 signs it out, clears its cookie and settles the retry marker from the marker
 * the request carried, so the loop guard applies. A user session sends no request.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import {
  ACCESS_TOKEN,
  type FakeCluster,
  SELF_REVIEW_PATH,
  startFakeCluster,
} from "../../helpers/openshift-auth/fake-cluster";

const T = Date.parse("2026-10-29T08:00:00.000Z");
const T_SECONDS = T / 1000;

let jar: Record<string, { value: string } | undefined> = {};
let writes: { op: string; name: string; value?: string }[] = [];

mock.module("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar[name],
    set: (name: string, value: string) => writes.push({ op: "set", name, value }),
    delete: (cookie: string | { name: string }) =>
      writes.push({ op: "delete", name: typeof cookie === "string" ? cookie : cookie.name }),
  }),
  headers: async () => ({ get: () => null }),
}));

const { getSession, signJWT } = await import("@/lib/auth");
type UserPayload = import("@/lib/auth").UserPayload;
const { resetOpenShiftSessions, storeOpenShiftSession, openShiftBearerToken } = await import(
  "@/lib/openshift-auth/token-store"
);
const { resetAccessReviewDecisions } = await import("@/lib/kubernetes-access/decisions");
const { connectionsUnderAccessReview } = await import("@/lib/kubernetes-access/gate");
const { logger } = await import("@/lib/logger");

const UID = "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f";
const H = "handle-h-not-a-real-handle-0000000000000000";
const UPDATE_STUDIO = {
  user: "dev-a",
  verb: "update",
  apiGroup: "apps",
  resource: "deployments",
  namespace: "os-lab-studio",
  name: "studio",
};
const KEYS = [
  "JWT_SECRET",
  "KUBERNETES_ACCESS_REVIEW",
  "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
  "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
  "AUTH_SESSION_TTL_SECONDS",
] as const;

let cluster: FakeCluster;
let saved: Record<string, string | undefined>;
let info: ReturnType<typeof spyOn>;

beforeAll(async () => {
  cluster = await startFakeCluster();
});

afterAll(async () => {
  await cluster.close();
});

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  cluster.reset();
  cluster.useEnv();
  setSystemTime(new Date(T));
  resetOpenShiftSessions();
  resetAccessReviewDecisions();
  jar = {};
  writes = [];
  process.env.JWT_SECRET = "a-test-secret-that-is-32-chars!!";
  process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT = "os-lab-studio/studio";
  delete process.env.KUBERNETES_ACCESS_REVIEW;
  delete process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS;
  delete process.env.AUTH_SESSION_TTL_SECONDS;
  info = spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  setSystemTime();
  cluster.restoreEnv();
  resetOpenShiftSessions();
  resetAccessReviewDecisions();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function payload(role: "admin" | "user"): UserPayload {
  return { role, username: "dev-a", idpSubject: UID, idpIssuer: cluster.issuerOrigin, sessionHandle: H };
}

/** A sign-in as the callback leaves it: the record under H, and a cookie of `role` minted at `mintedAt`. */
async function signedIn(role: "admin" | "user", mintedAt = T - 60_000): Promise<void> {
  storeOpenShiftSession(H, {
    token: ACCESS_TOKEN,
    uid: UID,
    name: "dev-a",
    issuer: cluster.issuerOrigin,
    expiresAtMs: T + 3_600_000,
  });
  setSystemTime(new Date(mintedAt));
  jar["auth-token"] = { value: await signJWT(payload(role)) };
  setSystemTime(new Date(T));
}

const names = (op: string) => writes.filter((write) => write.op === op).map((write) => write.name);
const markerSets = () => writes.filter((write) => write.op === "set" && write.name === "access-review-retry");

describe("an admin session in openshift mode", () => {
  test("keeps admin while its own review allows, from the cache within its lifetime, touching no cookie", async () => {
    cluster.grants = [UPDATE_STUDIO];
    await signedIn("admin");
    expect(await getSession()).toMatchObject({ role: "admin", username: "dev-a" });
    expect(await getSession()).toMatchObject({ role: "admin" });
    expect(cluster.selfReviews()).toHaveLength(1);
    expect(cluster.selfReviews()[0].headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(writes).toEqual([]);
  });

  test("runs as user once the right is gone, within the cache lifetime, and keeps its session and cookie", async () => {
    cluster.grants = [UPDATE_STUDIO];
    await signedIn("admin");
    expect(await getSession()).toMatchObject({ role: "admin" });
    cluster.grants = [];
    setSystemTime(new Date(T + 15_000));
    expect(await getSession()).toMatchObject({ role: "user", username: "dev-a", sessionHandle: H });
    expect(writes).toEqual([]);
  });

  test("runs as user when the review fails, and keeps its session", async () => {
    cluster.script(SELF_REVIEW_PATH, { status: 500, body: "{}" });
    await signedIn("admin");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await getSession()).toMatchObject({ role: "user" });
      expect(writes).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("clears a marker an earlier miss left once the role is known", async () => {
    cluster.grants = [UPDATE_STUDIO];
    await signedIn("admin");
    jar["access-review-retry"] = { value: String(T_SECONDS - 600) };
    expect(await getSession()).toMatchObject({ role: "admin" });
    expect(writes).toEqual([{ op: "delete", name: "access-review-retry" }]);
  });

  test("whose token the API refuses reads as signed out, clears its cookie and arms the marker", async () => {
    delete cluster.tokens[ACCESS_TOKEN];
    await signedIn("admin");
    expect(await getSession()).toBeNull();
    expect(names("delete")).toEqual(["auth-token"]);
    expect(markerSets()).toEqual([{ op: "set", name: "access-review-retry", value: String(T_SECONDS) }]);
    expect(
      openShiftBearerToken({ sessionHandle: H, uid: UID, name: "dev-a", issuer: cluster.issuerOrigin }),
    ).toBeNull();
  });

  test("a session minted after the marker that meets expired trips loop, and the response carries no marker delete", async () => {
    delete cluster.tokens[ACCESS_TOKEN];
    // The marker an earlier miss armed, then a new sign-in after it whose token the API refuses again.
    jar["access-review-retry"] = { value: String(T_SECONDS - 30) };
    await signedIn("admin", T - 10_000);
    expect(await getSession()).toBeNull();
    expect(markerSets()).toEqual([{ op: "set", name: "access-review-retry", value: "loop" }]);
    expect(names("delete")).toEqual(["auth-token"]);
    expect(info.mock.calls.some((call) => (call[1] as { loop?: boolean } | undefined)?.loop === true)).toBe(true);
  });

  test("a live record whose token the API answers 401 signs the session out on the next request and serves no cached admin", async () => {
    cluster.grants = [UPDATE_STUDIO];
    await signedIn("admin");
    expect(await getSession()).toMatchObject({ role: "admin" });
    // The API server already refuses the token while Studio's record is live and the admin answer is cached.
    delete cluster.tokens[ACCESS_TOKEN];
    const orders = {
      id: "seed:k8s-cnpg-orders",
      seedId: "k8s-cnpg-orders",
      name: "team-a/orders (CloudNativePG)",
      type: "postgres" as const,
      host: "orders-rw.team-a.svc.cluster.local.",
      port: 5432,
      managed: true,
      roles: [],
      createdAt: new Date(0),
      kubernetesSecret: { namespace: "team-a", name: "orders-app" },
    };
    expect(await connectionsUnderAccessReview(payload("admin"), [orders])).toEqual([]);
    expect(await getSession()).toBeNull();
    expect(names("delete")).toEqual(["auth-token"]);
    expect(cluster.selfReviews()).toHaveLength(2);
  });
});

describe("a user session in openshift mode", () => {
  test("sends no request and stays a user, whatever the review would answer", async () => {
    cluster.grants = [UPDATE_STUDIO];
    await signedIn("user");
    expect(await getSession()).toMatchObject({ role: "user" });
    expect(cluster.requests).toEqual([]);
    expect(writes).toEqual([]);
  });
});

/**
 * The gate never throws (src/lib/kubernetes-access/gate.ts): an exception while deciding a row denies that row and is
 * logged by the error's name only, never its message, which may quote a value. A throw would turn an existing id's
 * miss into a 500 beside an unknown id's 404.
 *
 * In its own file because `mock.module` is process-wide: the token record reader throws here, in every case.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ManagedConnection } from "@/lib/seed/types";

class RecordReaderFault extends Error {
  constructor() {
    super("record reader failed for sha256~not-a-real-token-a in team-a/orders-app");
    this.name = "RecordReaderFault";
  }
}

/** What the record reader throws; a case may swap it. */
let thrown: unknown = new RecordReaderFault();

mock.module("@/lib/openshift-auth/token-store", () => ({
  openShiftSessionKey: () => ({ sessionHandle: "handle-h", uid: "uid-a", name: "dev-a", issuer: "https://issuer" }),
  openShiftBearerToken: () => {
    throw thrown;
  },
  endOpenShiftSession: () => false,
}));

const { connectionsUnderAccessReview, connectionUnderAccessReview, reviewedSessionRole } = await import(
  "@/lib/kubernetes-access/gate"
);
const { logger } = await import("@/lib/logger");

const ORDERS: ManagedConnection = {
  id: "seed:k8s-cnpg-orders",
  seedId: "k8s-cnpg-orders",
  name: "team-a/orders (CloudNativePG)",
  type: "postgres",
  host: "orders-rw.team-a.svc.cluster.local.",
  port: 5432,
  managed: true,
  roles: [],
  createdAt: new Date(0),
  kubernetesSecret: { namespace: "team-a", name: "orders-app" },
};
const SESSION = {
  role: "user",
  username: "dev-a",
  idpSubject: "uid-a",
  idpIssuer: "https://issuer",
  sessionHandle: "h",
};

let savedMode: string | undefined;

beforeEach(() => {
  savedMode = process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
});

afterEach(() => {
  if (savedMode === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  else process.env.NEXT_PUBLIC_AUTH_PROVIDER = savedMode;
});

test("a throwing record reader denies the row, never throws, and logs the error's name without its message", async () => {
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    expect(await connectionsUnderAccessReview(SESSION, [ORDERS])).toEqual([]);
    expect(await connectionUnderAccessReview(SESSION, ORDERS)).toBeNull();
    expect(error.mock.calls).toEqual([
      [
        "Kubernetes access review: a review could not be decided, so it is denied",
        undefined,
        { route: "kubernetes-access", kind: "RecordReaderFault" },
      ],
      [
        "Kubernetes access review: a review could not be decided, so it is denied",
        undefined,
        { route: "kubernetes-access", kind: "RecordReaderFault" },
      ],
    ]);
    const logged = JSON.stringify(error.mock.calls);
    for (const secret of ["sha256~", "orders-app", "record reader failed"]) expect(logged).not.toContain(secret);
  } finally {
    error.mockRestore();
  }
});

test("a thrown value that is not an Error is logged by its type", async () => {
  thrown = "not an error object";
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    expect(await connectionUnderAccessReview(SESSION, ORDERS)).toBeNull();
    expect(error.mock.calls[0][2]).toEqual({ route: "kubernetes-access", kind: "string" });
  } finally {
    error.mockRestore();
    thrown = new RecordReaderFault();
  }
});

test("the admin check of a request turns an exception into user, logged by the error's name", async () => {
  const error = spyOn(logger, "error").mockImplementation(() => {});
  try {
    expect(await reviewedSessionRole({ ...SESSION, role: "admin" })).toBe("user");
    expect(error.mock.calls).toEqual([
      [
        "Kubernetes access review: a review could not be decided, so it is denied",
        undefined,
        { route: "kubernetes-access", kind: "RecordReaderFault" },
      ],
    ]);
  } finally {
    error.mockRestore();
  }
});

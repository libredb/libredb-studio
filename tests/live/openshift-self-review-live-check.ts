/**
 * Opt-in live check of the openshift self review against a real OpenShift cluster (docs/SEED_CONNECTIONS.md, "On
 * OpenShift (openshift sign-in)").
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/helpers/openshift-auth/fake-cluster.ts answers self reviews
 * from grants a test wrote. Only an OpenShift API server shows that a token with the scope Studio asks for, `user:info
 * user:check-access`, may create a SelfSubjectAccessReview whose answer is the user's own RBAC, through a RoleBinding
 * to the user and to a group alike; that a token with `user:info` only is refused with 403 and one with an extra scope
 * is denied; that a deleted token is refused with 401; that the answer echoes the asked attributes the way the client
 * checks; and that the ServiceAccount backend sees `config.openshift.io/v1` and refuses.
 *
 * With the kubeconfig of a cluster admin in LIBREDB_LIVE_KUBECONFIG, and the users' OpenShift tokens in files named by
 * LIBREDB_LIVE_OPENSHIFT_TOKEN_FILES, the script creates a throwaway namespace with a Secret, a Role that may get it
 * bound to the user `dev-a` and to a new group holding `dev-b`, a Role that may update the Deployment and the
 * LibreDBStudio resource `live-studio` bound to `dev-a`, and a ServiceAccount. It takes the API URL and CA from the
 * kubeconfig, so the self reviews run through Studio's own openShiftApiCall exactly as in the pod, and prints one line
 * per case, `ok   <case>` or `FAIL <case>` with the reason, never a token or a token object's name. It exits non-zero
 * when any case failed and deletes everything it created either way.
 *
 *   LIBREDB_LIVE_KUBECONFIG=<cluster admin kubeconfig> \
 *   LIBREDB_LIVE_OPENSHIFT_TOKEN_FILES="dev-a=<file>,dev-b=<file>,dev-a-info=<file>,dev-a-extra=<file>" \
 *   bun tests/live/openshift-self-review-live-check.ts
 *
 * The tokens: `dev-a` and `dev-b` with the scope `user:info user:check-access`, `dev-a-info` with `user:info` only, and
 * `dev-a-extra` with `user:info user:check-access user:list-scoped-projects`. The last case deletes the
 * `useroauthaccesstoken` object of the `dev-a-extra` token, so that token is spent afterwards.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * Point it at a lab: it creates and deletes a namespace and a group named libredb-os2-live-<random>.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetAccessReviewDecisions } from "../../src/lib/kubernetes-access/decisions";
import { selfReviewSignInRole } from "../../src/lib/kubernetes-access/gate";
import { clusterPlatform, resetPlatformCheck } from "../../src/lib/kubernetes-access/platform-check";
import {
  requestAccessReview,
  type ResourceAttributes,
  type ReviewOutcome,
} from "../../src/lib/kubernetes-access/review";
import { openShiftApiCall } from "../../src/lib/openshift-auth/http";

const kubeconfig = process.env.LIBREDB_LIVE_KUBECONFIG;
const tokenFiles = process.env.LIBREDB_LIVE_OPENSHIFT_TOKEN_FILES;
if (!kubeconfig || !tokenFiles) {
  console.error("Set LIBREDB_LIVE_KUBECONFIG and LIBREDB_LIVE_OPENSHIFT_TOKEN_FILES (see the header of this script).");
  process.exit(2);
}

const NAME = `libredb-os2-live-${randomBytes(4).toString("hex")}`;
const NAMESPACE = NAME;
const GROUP = NAME;
const SECRET = "live-db";
const dir = mkdtempSync(path.join(tmpdir(), "libredb-os2-live-"));
const CA_FILE = path.join(dir, "ca.crt");

/** The tokens by name, read from their files; a value is never printed. */
const TOKENS: Readonly<Record<string, string>> = Object.fromEntries(
  tokenFiles
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, file] = item.split("=");
      return [name, readFileSync(file, "utf8").trim()];
    }),
);

function token(name: string): string {
  const value = TOKENS[name];
  if (!value) throw new Error(`LIBREDB_LIVE_OPENSHIFT_TOKEN_FILES names no ${name} token`);
  return value;
}

/** Runs `oc` with the admin kubeconfig. Its error names the command, so no argument here ever carries a secret. */
function oc(args: readonly string[], input?: string): string {
  return execFileSync("oc", ["--kubeconfig", kubeconfig as string, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

const FIXTURE = `
apiVersion: v1
kind: Namespace
metadata:
  name: ${NAMESPACE}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SECRET}
  namespace: ${NAMESPACE}
type: Opaque
stringData:
  password: not-a-real-secret
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: get-live-db
  namespace: ${NAMESPACE}
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["${SECRET}"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: get-live-db
  namespace: ${NAMESPACE}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: get-live-db }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: User, name: dev-a }
  - { apiGroup: rbac.authorization.k8s.io, kind: Group, name: ${GROUP} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: update-studio
  namespace: ${NAMESPACE}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["live-studio"]
    verbs: ["update"]
  - apiGroups: ["studio.libredb.org"]
    resources: ["libredbstudios"]
    resourceNames: ["live-studio"]
    verbs: ["update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: update-studio
  namespace: ${NAMESPACE}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: update-studio }
subjects:
  - { apiGroup: rbac.authorization.k8s.io, kind: User, name: dev-a }
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: live-reviewer
  namespace: ${NAMESPACE}
`;

const GET_SECRET: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: NAMESPACE,
  name: SECRET,
};

const self = (name: string) => ({ sessionHandle: `live-${name}`, uid: `live-uid-${name}`, token: token(name) });

function expectOutcome(outcome: ReviewOutcome, expected: ReviewOutcome): void {
  if (JSON.stringify(outcome) !== JSON.stringify(expected)) {
    throw new Error(`answered ${JSON.stringify(outcome)}, expected ${JSON.stringify(expected)}`);
  }
}

function expectEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

/** Asks until the review answers `expected`, as an RBAC change reaches the authorizer within seconds. */
async function eventually(ask: () => Promise<ReviewOutcome>, expected: ReviewOutcome, seconds = 15): Promise<void> {
  let last: ReviewOutcome = { kind: "denied" };
  for (let tries = 0; tries < seconds; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one try a second until the cluster answers as expected.
    last = await ask();
    if (JSON.stringify(last) === JSON.stringify(expected)) return;
    // oxlint-disable-next-line no-await-in-loop -- one try a second until the cluster answers as expected.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  expectOutcome(last, expected);
}

/** The role sign-in gives `name`'s token with the admin target in `variable`, the other one unset. */
async function signInRole(name: string, variable: "DEPLOYMENT" | "LIBREDBSTUDIO"): Promise<string | null> {
  delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT;
  delete process.env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO;
  process.env[`KUBERNETES_ACCESS_REVIEW_ADMIN_${variable}`] = `${NAMESPACE}/live-studio`;
  return selfReviewSignInRole(token(name));
}

interface LiveCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

const CASES: LiveCase[] = [
  {
    name: "dev-a may get the Secret with its own token, through a RoleBinding to the user",
    run: async () => expectOutcome(await requestAccessReview(self("dev-a"), GET_SECRET), { kind: "allowed" }),
  },
  {
    name: "dev-a may not get another Secret of the namespace",
    run: async () =>
      expectOutcome(await requestAccessReview(self("dev-a"), { ...GET_SECRET, name: "other-db" }), { kind: "denied" }),
  },
  {
    name: "dev-b may get the Secret through the group, and may not once it left the group",
    run: async () => {
      await eventually(() => requestAccessReview(self("dev-b"), GET_SECRET), { kind: "allowed" });
      oc(["adm", "groups", "remove-users", GROUP, "dev-b"]);
      await eventually(() => requestAccessReview(self("dev-b"), GET_SECRET), { kind: "denied" });
    },
  },
  {
    name: "admin from update on the Deployment and on the LibreDBStudio resource: dev-a is admin, dev-b a user",
    run: async () => {
      expectEqual(await signInRole("dev-a", "DEPLOYMENT"), "admin");
      expectEqual(await signInRole("dev-b", "DEPLOYMENT"), "user");
      expectEqual(await signInRole("dev-a", "LIBREDBSTUDIO"), "admin");
      expectEqual(await signInRole("dev-b", "LIBREDBSTUDIO"), "user");
    },
  },
  {
    name: "a token with user:info only may not create the review: forbidden",
    run: async () =>
      expectOutcome(await requestAccessReview(self("dev-a-info"), GET_SECRET), { kind: "failed", reason: "forbidden" }),
  },
  {
    name: "a token with an extra scope is denied what dev-a may do",
    run: async () => expectOutcome(await requestAccessReview(self("dev-a-extra"), GET_SECRET), { kind: "denied" }),
  },
  {
    name: "the answer echoes spec.resourceAttributes, leaving the empty group out",
    run: async () => {
      const { verb, group, resource, namespace, name } = GET_SECRET;
      const result = await openShiftApiCall({
        method: "POST",
        path: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        bearer: token("dev-a"),
        json: {
          apiVersion: "authorization.k8s.io/v1",
          kind: "SelfSubjectAccessReview",
          spec: { resourceAttributes: { verb, group, resource, namespace, name } },
        },
        maxBytes: 65536,
      });
      if (result.kind !== "answer") throw new Error(`the review failed: ${result.reason}`);
      const echoed = (JSON.parse(result.body) as { spec?: { resourceAttributes?: Record<string, unknown> } }).spec
        ?.resourceAttributes;
      // Compared field by field: the API server writes its own key order.
      expectEqual(Object.entries(echoed ?? {}).sort(), Object.entries({ namespace, verb, resource, name }).sort());
    },
  },
  {
    name: "the ServiceAccount review's platform check answers openshift-cluster, and its reviews refuse with platform",
    run: async () => {
      resetPlatformCheck();
      const serviceAccountToken = oc(["create", "token", "live-reviewer", "-n", NAMESPACE, "--duration=10m"]).trim();
      const server = new URL(process.env.OPENSHIFT_API_URL as string);
      expectEqual(await clusterPlatform(server, serviceAccountToken, readFileSync(CA_FILE, "utf8")), "openshift-cluster");
      // The ServiceAccount review itself, configured as OIDC mode configures it, refuses before it sends a review.
      const tokenFile = path.join(dir, "service-account-token");
      writeFileSync(tokenFile, serviceAccountToken);
      process.env.KUBERNETES_ACCESS_REVIEW_API_URL = server.href;
      process.env.KUBERNETES_ACCESS_REVIEW_TOKEN_PATH = tokenFile;
      process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = CA_FILE;
      try {
        expectOutcome(await requestAccessReview({ user: "dev-a", groups: [] }, GET_SECRET), {
          kind: "failed",
          reason: "platform",
        });
      } finally {
        delete process.env.KUBERNETES_ACCESS_REVIEW_API_URL;
        delete process.env.KUBERNETES_ACCESS_REVIEW_TOKEN_PATH;
        delete process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH;
      }
    },
  },
  {
    name: "a token whose useroauthaccesstoken object was deleted is expired (spends the dev-a-extra token)",
    run: async () => {
      const value = token("dev-a-extra");
      const object = `sha256~${createHash("sha256")
        .update(value.replace(/^sha256~/, ""))
        .digest("base64url")}`;
      try {
        oc(["delete", "useroauthaccesstoken", object]);
      } catch {
        // The command line names the object, a sha256~ value, so its error is never printed.
        throw new Error("oc delete useroauthaccesstoken failed");
      }
      await eventually(() => requestAccessReview(self("dev-a-extra"), GET_SECRET), { kind: "expired" });
    },
  },
];

/** The cluster's CA from the kubeconfig, as PEM. */
function kubeconfigCa(): string {
  const data = oc([
    "config",
    "view",
    "--raw",
    "--minify",
    "-o",
    "jsonpath={.clusters[0].cluster.certificate-authority-data}",
  ]);
  const pem = Buffer.from(data, "base64").toString("utf8");
  if (!pem.includes("-----BEGIN CERTIFICATE-----"))
    throw new Error("the kubeconfig carries no certificate-authority-data");
  return pem;
}

async function main(): Promise<void> {
  let failed = 0;
  try {
    oc(["apply", "-f", "-"], FIXTURE);
    oc(["adm", "groups", "new", GROUP, "dev-b"]);
    writeFileSync(CA_FILE, kubeconfigCa());
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "openshift";
    process.env.OPENSHIFT_API_URL = oc([
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ]).trim();
    process.env.OPENSHIFT_API_CA_FILE = CA_FILE;
    process.env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS = "0";
    delete process.env.KUBERNETES_ACCESS_REVIEW_SIGN_IN;
    resetAccessReviewDecisions();
    for (const liveCase of CASES) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the cases change the cluster in turn, so they run in turn.
        await liveCase.run();
        console.log(`ok   ${liveCase.name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${liveCase.name}: ${(error as Error).message}`);
      }
    }
  } finally {
    for (const args of [
      ["delete", "namespace", NAMESPACE, "--wait=false", "--ignore-not-found"],
      ["delete", "group", GROUP, "--ignore-not-found"],
    ]) {
      try {
        oc(args);
      } catch (error) {
        failed += 1;
        console.error(`FAIL cleanup ${args.join(" ")}: ${(error as Error).message}`);
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
  if (failed > 0) process.exitCode = 1;
}

await main();

/**
 * Opt-in live check of the Kubernetes access review against a real cluster (docs/SEED_CONNECTIONS.md, "Kubernetes
 * access review").
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. tests/helpers/kubernetes-access/fake-api.ts answers reviews from a
 * list of grants the test wrote. Only a kube-apiserver shows that the review Studio sends is one it accepts from a
 * ServiceAccount that may only create SubjectAccessReviews, that its RBAC answers a Role bound to a user and one bound
 * to a group the way the gate expects, that a token is read again per review, and that the cluster's CA, a wrong CA,
 * an empty CA and a ServiceAccount without the right all end as the client says they do.
 *
 * With the kubeconfig in LIBREDB_LIVE_KUBECONFIG, which must be allowed to create namespaces and cluster-scoped RBAC,
 * the script creates a throwaway namespace with a Secret, a Role that may get it bound to the user `live-user-a` and
 * to the group `live-group-b`, a Role that may update the Deployment `live-studio` bound to `live-admin`, and two
 * ServiceAccounts, one bound to a ClusterRole that may only create SubjectAccessReviews and one bound to nothing. It
 * mints a short-lived token for each with the TokenRequest API, takes the API URL and CA from the kubeconfig, and runs
 * Studio's own review client, decision cache, groups store and gate against them. It prints one line per case,
 * `ok   <case>` or `FAIL <case>` with the reason, exits non-zero when any case failed, and deletes everything it created
 * either way.
 *
 * On a Rancher downstream cluster it can also replay what Rancher decides for real users, a Project Member allowed and
 * a Read Only member denied a Secret and a user without a role in the cluster refused at sign-in, with the identities
 * passed in, never written here:
 *   LIBREDB_LIVE_SIGN_IN_ROLES="<user id>=admin|user|refused,..."  the role each Rancher user id signs in with, under
 *     the default sign-in review and KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT, which the caller sets
 *   LIBREDB_LIVE_SECRET_DECISIONS="<user id>@<namespace>/<secret>=allowed|denied,..."  get on a Secret, no groups
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_KUBECONFIG=/path/to/kubeconfig bun tests/live/kubernetes-access-review-live-check.ts
 *
 * Point it at a DISPOSABLE cluster or a lab: it creates and deletes a namespace named libredb-ar-live-<random> and
 * the ClusterRole and ClusterRoleBinding of the same name.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTlsFixtures } from "../helpers/tls-fixtures";
import { resetAccessReviewDecisions } from "../../src/lib/kubernetes-access/decisions";
import { accessReviewSignInRole, connectionsUnderAccessReview } from "../../src/lib/kubernetes-access/gate";
import { recordGroups, resetGroupRecords } from "../../src/lib/kubernetes-access/groups";
import {
  requestAccessReview,
  type ResourceAttributes,
  type ReviewOutcome,
} from "../../src/lib/kubernetes-access/review";
import { KUBERNETES_REVIEWED_ROLE } from "../../src/lib/seed/roles";
import type { ManagedConnection } from "../../src/lib/seed/types";

const kubeconfig = process.env.LIBREDB_LIVE_KUBECONFIG;
if (!kubeconfig) {
  console.error("Set LIBREDB_LIVE_KUBECONFIG to the kubeconfig of a disposable cluster.");
  process.exit(2);
}

const NAME = `libredb-ar-live-${randomBytes(4).toString("hex")}`;
const NAMESPACE = NAME;
const SECRET = "live-db-app";
const ISSUER = "https://live.example.invalid/oidc";
const dir = mkdtempSync(path.join(tmpdir(), "libredb-ar-live-"));
const TOKEN_FILE = path.join(dir, "token");
const CA_FILE = path.join(dir, "ca.crt");

function kubectl(args: readonly string[], input?: string): string {
  return execFileSync("kubectl", ["--kubeconfig", kubeconfig as string, ...args], {
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
  password: not-a-real-password
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: live-get-secret
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
  name: live-user-a
  namespace: ${NAMESPACE}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: live-get-secret }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: live-user-a }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: live-group-b
  namespace: ${NAMESPACE}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: live-get-secret }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: Group, name: live-group-b }]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: live-update-studio
  namespace: ${NAMESPACE}
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["live-studio"]
    verbs: ["update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: live-admin
  namespace: ${NAMESPACE}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: live-update-studio }
subjects: [{ apiGroup: rbac.authorization.k8s.io, kind: User, name: live-admin }]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: live-reviewer
  namespace: ${NAMESPACE}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: live-nobody
  namespace: ${NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${NAME}
rules:
  - apiGroups: ["authorization.k8s.io"]
    resources: ["subjectaccessreviews"]
    verbs: ["create"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${NAME}
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: ${NAME} }
subjects: [{ kind: ServiceAccount, name: live-reviewer, namespace: ${NAMESPACE} }]
`;

const GET_SECRET: ResourceAttributes = {
  verb: "get",
  group: "",
  resource: "secrets",
  namespace: NAMESPACE,
  name: SECRET,
};
const UPDATE_STUDIO: ResourceAttributes = {
  verb: "update",
  group: "apps",
  resource: "deployments",
  namespace: NAMESPACE,
  name: "live-studio",
};

/** A short-lived token for a ServiceAccount of the throwaway namespace, from the TokenRequest API. */
const tokenFor = (serviceAccount: string): string =>
  kubectl(["create", "token", serviceAccount, "-n", NAMESPACE, "--duration=10m"]).trim();

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

/** Pairs of `key=value` from a comma-separated variable. */
const pairs = (raw: string | undefined): [string, string][] =>
  (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => item.split("=") as [string, string]);

const reviewerToken = { value: "" };

interface LiveCase {
  readonly name: string;
  /** Resolves "skipped" when the case has nothing to check on this cluster. */
  readonly run: () => Promise<void | "skipped">;
}

const CASES: LiveCase[] = [
  {
    name: "a user a Role binds by name may get the Secret",
    run: async () =>
      expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), { kind: "allowed" }),
  },
  {
    name: "a user no binding names may not",
    run: async () =>
      expectOutcome(await requestAccessReview({ user: "live-user-c", groups: [] }, GET_SECRET), { kind: "denied" }),
  },
  {
    name: "a user in a group a Role binds may get it, a user in another group may not",
    run: async () => {
      expectOutcome(await requestAccessReview({ user: "live-user-c", groups: ["live-group-b"] }, GET_SECRET), {
        kind: "allowed",
      });
      expectOutcome(await requestAccessReview({ user: "live-user-c", groups: ["live-group-z"] }, GET_SECRET), {
        kind: "denied",
      });
    },
  },
  {
    name: "another Secret of the same namespace is denied to the bound user",
    run: async () =>
      expectOutcome(
        await requestAccessReview({ user: "live-user-a", groups: [] }, { ...GET_SECRET, name: "other-app" }),
        {
          kind: "denied",
        },
      ),
  },
  {
    name: "update on the Studio Deployment is allowed to the admin binding only",
    run: async () => {
      expectOutcome(await requestAccessReview({ user: "live-admin", groups: [] }, UPDATE_STUDIO), { kind: "allowed" });
      expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, UPDATE_STUDIO), { kind: "denied" });
    },
  },
  {
    name: "the token file is read again for every review",
    run: async () => {
      writeFileSync(TOKEN_FILE, "not-a-real-token");
      expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), {
        kind: "failed",
        reason: "status",
        status: 401,
      });
      writeFileSync(TOKEN_FILE, tokenFor("live-reviewer"));
      expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), { kind: "allowed" });
    },
  },
  {
    name: "a ServiceAccount without create on subjectaccessreviews fails with 403",
    run: async () => {
      writeFileSync(TOKEN_FILE, tokenFor("live-nobody"));
      try {
        expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), {
          kind: "failed",
          reason: "status",
          status: 403,
        });
      } finally {
        writeFileSync(TOKEN_FILE, reviewerToken.value);
      }
    },
  },
  {
    name: "a CA that did not sign the API server's certificate fails as TLS, an empty one as a CA problem",
    run: async () => {
      const ca = kubeconfigCa();
      try {
        writeFileSync(CA_FILE, loadTlsFixtures().otherCa);
        expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), {
          kind: "failed",
          reason: "tls",
        });
        writeFileSync(CA_FILE, "");
        expectOutcome(await requestAccessReview({ user: "live-user-a", groups: [] }, GET_SECRET), {
          kind: "failed",
          reason: "ca",
        });
      } finally {
        writeFileSync(CA_FILE, ca);
      }
    },
  },
  {
    name: "the gate keeps a reviewed connection only for a subject whose recorded groups the cluster allows",
    run: async () => {
      resetAccessReviewDecisions();
      resetGroupRecords();
      recordGroups(ISSUER, "live-user-c", ["live-group-b"]);
      recordGroups(ISSUER, "live-user-d", []);
      const reviewed: ManagedConnection = {
        id: "seed:live-db",
        seedId: "live-db",
        name: "live",
        type: "postgres",
        managed: true,
        roles: [KUBERNETES_REVIEWED_ROLE],
        createdAt: new Date(),
        kubernetesSecret: { namespace: NAMESPACE, name: SECRET },
      };
      const listedFor = async (subject: string) =>
        (await connectionsUnderAccessReview({ role: "user", idpSubject: subject, idpIssuer: ISSUER }, [reviewed])).map(
          (connection) => connection.id,
        );
      expectEqual(await listedFor("live-user-c"), ["seed:live-db"]);
      expectEqual(await listedFor("live-user-d"), []);
    },
  },
  {
    name: "the sign-in role of each Rancher user id in LIBREDB_LIVE_SIGN_IN_ROLES (a user without a role in the cluster is refused)",
    run: async () => {
      if (!process.env.LIBREDB_LIVE_SIGN_IN_ROLES) return "skipped";
      for (const [user, expected] of pairs(process.env.LIBREDB_LIVE_SIGN_IN_ROLES)) {
        const role = await accessReviewSignInRole(user, []);
        if ((role ?? "refused") !== expected)
          throw new Error(`${user} signed in as ${role ?? "refused"}, expected ${expected}`);
      }
    },
  },
  {
    name: "the Secret decision of each case in LIBREDB_LIVE_SECRET_DECISIONS (a Project Member allowed, Read Only denied)",
    run: async () => {
      if (!process.env.LIBREDB_LIVE_SECRET_DECISIONS) return "skipped";
      for (const [target, expected] of pairs(process.env.LIBREDB_LIVE_SECRET_DECISIONS)) {
        const [user, object] = target.split("@");
        const [namespace, name] = object.split("/");
        const outcome = await requestAccessReview(
          { user, groups: [] },
          { verb: "get", group: "", resource: "secrets", namespace, name },
        );
        if (outcome.kind !== expected)
          throw new Error(`${target} was ${JSON.stringify(outcome)}, expected ${expected}`);
      }
    },
  },
];

/** The cluster's CA from the kubeconfig, as PEM. */
function kubeconfigCa(): string {
  const data = kubectl([
    "config",
    "view",
    "--raw",
    "--minify",
    "-o",
    "jsonpath={.clusters[0].cluster.certificate-authority-data}",
  ]);
  return Buffer.from(data, "base64").toString("utf8");
}

async function main(): Promise<void> {
  let failed = 0;
  try {
    kubectl(["apply", "-f", "-"], FIXTURE);
    reviewerToken.value = tokenFor("live-reviewer");
    writeFileSync(TOKEN_FILE, reviewerToken.value);
    writeFileSync(CA_FILE, kubeconfigCa());
    process.env.KUBERNETES_ACCESS_REVIEW = "on";
    process.env.KUBERNETES_ACCESS_REVIEW_API_URL = kubectl([
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ]).trim();
    process.env.KUBERNETES_ACCESS_REVIEW_TOKEN_PATH = TOKEN_FILE;
    process.env.KUBERNETES_ACCESS_REVIEW_CA_PATH = CA_FILE;
    process.env.AUTH_SESSION_TTL_SECONDS ??= "900";
    for (const liveCase of CASES) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- the cases share the token and CA files, so they run in turn.
        const result = await liveCase.run();
        console.log(`${result === "skipped" ? "skip" : "ok  "} ${liveCase.name}`);
      } catch (error) {
        failed += 1;
        console.error(`FAIL ${liveCase.name}: ${(error as Error).message}`);
      }
    }
  } finally {
    for (const args of [
      ["delete", "namespace", NAMESPACE, "--wait=false", "--ignore-not-found"],
      ["delete", "clusterrolebinding", NAME, "--ignore-not-found"],
      ["delete", "clusterrole", NAME, "--ignore-not-found"],
    ]) {
      try {
        kubectl(args);
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

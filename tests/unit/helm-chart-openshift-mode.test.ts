// @requires helm
/**
 * The chart's openshift sign-in mode (authProvider: openshift) and the Tier 0 ConsoleLink.
 *
 * openshift mode renders what the first verify window wired by hand through extraEnv, extraVolumes and
 * serviceAccount.annotations: the ServiceAccount as the OAuth client (two redirect annotations naming the Route),
 * a projected token with its own audience as the client secret, the cluster's CA from kube-root-ca.crt, the four
 * OPENSHIFT_* variables Studio's openshift sign-in reads (src/lib/openshift-auth/config.ts), and the admin target of
 * the self review (src/lib/kubernetes-access/config.ts). It refuses, naming the value, every values set Studio's
 * openshift preflight would refuse, and the operator-managed guard (operator.managed and
 * operator.clusterStudioNamespace) keeps every cross-namespace or cluster-scoped object to the one Studio the
 * cluster admin named.
 *
 * Every case runs the real `helm template` against the chart, never a reimplementation of the templating.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import { howItFailed } from "../helpers/spawn-outcome";

const CHART_DIR = join(import.meta.dir, "../../charts/libredb-studio");
const RELEASE = "v1os";
const NAMESPACE = "os-lab-v1";
const HOST = "v1os-os-lab-v1.apps-crc.testing";
const SIGN_IN_DIR = "/var/run/secrets/libredb/openshift";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: unknown;
}

interface Volume {
  name: string;
  projected?: { sources: Array<Record<string, unknown>> };
  [key: string]: unknown;
}

interface PodSpec {
  serviceAccountName?: string;
  automountServiceAccountToken?: boolean;
  securityContext?: Record<string, unknown>;
  containers: Array<{
    name: string;
    env?: EnvVar[];
    volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
  }>;
  volumes?: Volume[];
}

interface EgressRule {
  ports?: Array<{ port: number; protocol: string }>;
  to?: Array<Record<string, unknown>>;
}

interface Manifest {
  apiVersion: string;
  kind: string;
  automountServiceAccountToken?: boolean;
  data?: Record<string, string>;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  rules?: Array<{ apiGroups: string[]; resources: string[]; verbs: string[] }>;
  subjects?: Array<{ kind: string; name: string; namespace?: string }>;
  roleRef?: { kind: string; name: string };
  spec?: {
    template?: { spec: PodSpec };
    egress?: EgressRule[];
    location?: string;
    href?: string;
    text?: string;
    applicationMenu?: { section?: string; imageURL?: string };
    namespaceDashboard?: { namespaces?: string[]; namespaceSelector?: Record<string, unknown> };
  };
}

function template(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync(["helm", "template", RELEASE, CHART_DIR, "--namespace", NAMESPACE, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function render(args: string[]): Manifest[] {
  const run = template(args);
  if (run.exitCode !== 0) throw new Error(`helm template ${howItFailed(run)}: ${run.stderr}`);
  return parseAllDocuments(run.stdout)
    .map((doc) => doc.toJSON() as Manifest)
    .filter(Boolean);
}

function refused(args: string[], ...needles: string[]): void {
  const run = template(args);
  expect(run.exitCode).not.toBe(0);
  for (const needle of needles) expect(run.stderr).toContain(needle);
}

function all(docs: Manifest[], kind: string): Manifest[] {
  return docs.filter((doc) => doc.kind === kind);
}

function one(docs: Manifest[], kind: string, name: string): Manifest {
  const found = docs.filter((doc) => doc.kind === kind && doc.metadata.name === name);
  expect(found).toHaveLength(1);
  return found[0];
}

function studioPod(docs: Manifest[], name = RELEASE): PodSpec {
  const spec = one(docs, "Deployment", name).spec?.template?.spec;
  if (!spec) throw new Error(`no pod spec in Deployment ${name}`);
  return spec;
}

function envList(docs: Manifest[], name = RELEASE): EnvVar[] {
  return studioPod(docs, name).containers[0].env ?? [];
}

function envOf(docs: Manifest[], name = RELEASE): Record<string, string | undefined> {
  return Object.fromEntries(envList(docs, name).map((entry) => [entry.name, entry.value]));
}

function configData(docs: Manifest[], name = `${RELEASE}-config`): Record<string, string> {
  return one(docs, "ConfigMap", name).data ?? {};
}

function set(...pairs: string[]): string[] {
  return pairs.flatMap((pair) => ["--set", pair]);
}

/**
 * A workable openshift-mode values set, the V1 hand wiring's: the Route with its host fixed at install time, the
 * OpenShift APIs forced (an offline render has no cluster to ask), and an image past 1.1.0, the last release with no
 * openshift sign-in.
 */
const OPENSHIFT_PAIRS = [
  "authProvider=openshift",
  "openshiftRoute.enabled=true",
  `openshiftRoute.host=${HOST}`,
  "global.compatibility.openshift.apis=force",
  "image.tag=1.2.0",
];

/** The same with fullnameOverride=v1os, as the V1 hand wiring set it, so every object is named v1os. */
const OPENSHIFT = set(...OPENSHIFT_PAIRS, `fullnameOverride=${RELEASE}`);

const DISCOVERY = set("discovery.kubernetes.enabled=true", "discovery.kubernetes.namespaces={team-a,team-b}");

const values = parse(readFileSync(join(CHART_DIR, "values.yaml"), "utf8"));

describe("authProvider openshift and the openshift sign-in values", () => {
  test("authProvider openshift passes the schema and reaches NEXT_PUBLIC_AUTH_PROVIDER", () => {
    expect(configData(render(OPENSHIFT)).NEXT_PUBLIC_AUTH_PROVIDER).toBe("openshift");
  });

  test("an unknown authProvider is still refused by the schema", () => {
    refused(set("authProvider=openshift4"), "authProvider");
  });

  test("operator.managed and operator.clusterStudioNamespace default off and empty", () => {
    expect(values.operator).toEqual({ managed: false, clusterStudioNamespace: "" });
  });

  test("openshift.signIn defaults: a 600-second client token, no review cache override, no sign-in review", () => {
    expect(values.openshift.signIn).toEqual({ tokenExpirationSeconds: 600, reviewCacheSeconds: null, review: "" });
  });

  test("openshift.consoleLink defaults off, in the application menu", () => {
    expect(values.openshift.consoleLink).toEqual({
      enabled: false,
      location: "ApplicationMenu",
      section: "LibreDB",
      text: "LibreDB Studio",
      imageUrl: "",
      namespaces: [],
      namespaceSelector: {},
    });
  });

  test("discovery.kubernetes.clusterDomain defaults unset", () => {
    expect(values.discovery.kubernetes.clusterDomain).toBeNull();
  });

  test("networkPolicy.enabled defaults unset, so only openshift discovery mode renders the policy unasked", () => {
    expect(values.networkPolicy.enabled).toBeNull();
  });

  test.each([
    ["openshift.signIn.tokenExpirationSeconds=599", "tokenExpirationSeconds"],
    ["openshift.signIn.tokenExpirationSeconds=86401", "tokenExpirationSeconds"],
    ["openshift.signIn.reviewCacheSeconds=61", "reviewCacheSeconds"],
    ["openshift.signIn.reviewCacheSeconds=-1", "reviewCacheSeconds"],
    ["openshift.signIn.review=not a review", "review"],
    ["openshift.consoleLink.location=Everywhere", "location"],
    ["openshift.consoleLink.imageUrl=http://example.com/icon.png", "imageUrl"],
    ["openshift.consoleLink.namespaces={Team_A}", "namespaces"],
    ["operator.clusterStudioNamespace=Not_A_Namespace", "clusterStudioNamespace"],
    ["discovery.kubernetes.clusterDomain=Cluster.Local", "clusterDomain"],
    ["discovery.kubernetes.clusterDomain=svc.cluster.local", "clusterDomain"],
    ["discovery.kubernetes.clusterDomain=.cluster.local", "clusterDomain"],
  ])("the schema refuses %s", (pair, key) => {
    refused(set(pair), key);
  });

  test.each([
    ["operator.unknown=true", "operator"],
    ["openshift.signIn.unknown=true", "signIn"],
    ["openshift.consoleLink.unknown=true", "consoleLink"],
  ])("the schema refuses an unknown key: %s", (pair, key) => {
    refused(set(pair), key);
  });

  test("the schema accepts the boundary values", () => {
    render([
      ...OPENSHIFT,
      ...set(
        "openshift.signIn.tokenExpirationSeconds=86400",
        "openshift.signIn.reviewCacheSeconds=0",
        "discovery.kubernetes.clusterDomain=corp.example",
      ),
    ]);
  });
});

describe("the ServiceAccount the OAuth client id names", () => {
  test("serviceAccount.create=false fails naming serviceAccount.create", () => {
    refused([...OPENSHIFT, ...set("serviceAccount.create=false", "serviceAccount.name=studio")], "serviceAccount.create");
  });

  test("serviceAccount.name=default fails naming serviceAccount.name", () => {
    refused([...OPENSHIFT, ...set("serviceAccount.name=default")], "serviceAccount.name");
  });

  test("the same values outside openshift mode still render", () => {
    render(set("serviceAccount.create=false"));
    render(set("serviceAccount.name=default"));
  });
});

/**
 * O14: a LibreDBStudio any namespace editor may create is reconciled by the cluster-wide operator, so under
 * operator.managed a cross-namespace object renders only for the release in operator.clusterStudioNamespace. The
 * discovery render is gated in every sign-in mode, not only openshift mode.
 */
describe("the operator namespace guard on discovery (O14)", () => {
  const MODES: Array<[string, string[]]> = [
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
    ["openshift", OPENSHIFT],
  ];

  test.each(MODES)("%s: operator-managed discovery of another namespace with no cluster Studio namespace fails", (_, mode) => {
    refused([...mode, ...DISCOVERY, ...set("operator.managed=true")], "operator.clusterStudioNamespace");
  });

  test.each(MODES)("%s: operator-managed discovery from a namespace other than the cluster Studio's fails", (_, mode) => {
    refused(
      [...mode, ...DISCOVERY, ...set("operator.managed=true", "operator.clusterStudioNamespace=studio")],
      "operator.clusterStudioNamespace",
    );
  });

  test.each(MODES)("%s: the cluster Studio's namespace discovers other namespaces", (_, mode) => {
    const docs = render([
      ...mode,
      ...DISCOVERY,
      ...set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`),
    ]);
    expect(
      all(docs, "Role")
        .map((role) => role.metadata.namespace)
        .filter(Boolean),
    ).toEqual(["team-a", "team-b"]);
  });

  test.each(MODES)("%s: an operator-managed release may discover its own namespace", (_, mode) => {
    render([
      ...mode,
      ...set("discovery.kubernetes.enabled=true", `discovery.kubernetes.namespaces={${NAMESPACE}}`, "operator.managed=true"),
    ]);
  });

  test.each(MODES)("%s: a Helm install (operator.managed unset) discovers any namespace", (_, mode) => {
    render([...mode, ...DISCOVERY]);
  });
});

describe("the ServiceAccount as the OAuth client", () => {
  const REFERENCE = "serviceaccounts.openshift.io/oauth-redirectreference.first";
  const REDIRECT = "serviceaccounts.openshift.io/oauth-redirecturi.first";

  test("names the Route in the redirect reference and the callback path, as the V1 hand wiring did", () => {
    const account = one(render(OPENSHIFT), "ServiceAccount", RELEASE);
    expect(account.metadata.annotations).toEqual({
      [REFERENCE]: '{"kind":"OAuthRedirectReference","apiVersion":"v1","reference":{"kind":"Route","name":"v1os"}}',
      [REDIRECT]: "api/auth/openshift/callback",
    });
    expect(account.automountServiceAccountToken).toBe(false);
  });

  test("the callback path carries config.basePath without its leading slash", () => {
    const account = one(render([...OPENSHIFT, ...set("config.basePath=/studio")]), "ServiceAccount", RELEASE);
    expect(account.metadata.annotations?.[REDIRECT]).toBe("studio/api/auth/openshift/callback");
  });

  test("the reference names the Route by the fullname without a fullnameOverride", () => {
    const docs = render(set(...OPENSHIFT_PAIRS, "nameOverride=studio"));
    const account = one(docs, "ServiceAccount", "v1os-studio");
    const reference = JSON.parse(account.metadata.annotations?.[REFERENCE] ?? "{}");
    expect(reference.reference).toEqual({ kind: "Route", name: "v1os-studio" });
    one(docs, "Route", "v1os-studio");
  });

  test("a user annotation merges beside them, and the chart's wins on a collision", () => {
    const account = one(
      render([
        ...OPENSHIFT,
        "--set-string",
        "serviceAccount.annotations.example\\.com/team=data",
        "--set-string",
        `serviceAccount.annotations.${REDIRECT.replaceAll(".", "\\.")}=elsewhere`,
      ]),
      "ServiceAccount",
      RELEASE,
    );
    expect(account.metadata.annotations?.["example.com/team"]).toBe("data");
    expect(account.metadata.annotations?.[REDIRECT]).toBe("api/auth/openshift/callback");
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode renders neither annotation", (_, mode) => {
    const account = one(render([...mode, ...set(`fullnameOverride=${RELEASE}`)]), "ServiceAccount", RELEASE);
    expect(account.metadata.annotations).toBeUndefined();
  });
});

describe("the OAuth client token and the cluster CA", () => {
  const PROJECTED = {
    name: "openshift-oauth",
    projected: {
      sources: [
        {
          serviceAccountToken: {
            audience: "libredb-studio-oauth-client",
            expirationSeconds: 600,
            path: "oauth-client-token",
          },
        },
        { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
      ],
    },
  };

  test("one projected volume holds the client token with its own audience and the kube-root-ca.crt CA", () => {
    const pod = studioPod(render(OPENSHIFT));
    expect(pod.volumes?.find((volume) => volume.name === "openshift-oauth")).toEqual(PROJECTED);
    expect(pod.containers[0].volumeMounts).toContainEqual({ name: "openshift-oauth", mountPath: SIGN_IN_DIR, readOnly: true });
  });

  test("the token lifetime comes from openshift.signIn.tokenExpirationSeconds", () => {
    const pod = studioPod(render([...OPENSHIFT, ...set("openshift.signIn.tokenExpirationSeconds=3600")]));
    const volume = pod.volumes?.find((entry) => entry.name === "openshift-oauth");
    expect(volume?.projected?.sources[0]).toEqual({
      serviceAccountToken: { audience: "libredb-studio-oauth-client", expirationSeconds: 3600, path: "oauth-client-token" },
    });
  });

  test("the pod still mounts no API token of its own", () => {
    expect(studioPod(render(OPENSHIFT)).automountServiceAccountToken).toBe(false);
  });

  test("every volume name is distinct, with the trusted CA bundle on beside it", () => {
    const pod = studioPod(render([...OPENSHIFT, ...set("openshift.trustedCABundle.enabled=true")]));
    const names = (pod.volumes ?? []).map((volume) => volume.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("trusted-ca");
    expect(names).not.toContain("access-review");
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode mounts no openshift volume", (_, mode) => {
    const pod = studioPod(render([...mode, ...set(`fullnameOverride=${RELEASE}`)]));
    expect((pod.volumes ?? []).map((volume) => volume.name)).not.toContain("openshift-oauth");
    expect((pod.containers[0].volumeMounts ?? []).map((mount) => mount.mountPath)).not.toContain(SIGN_IN_DIR);
  });
});

describe("the openshift sign-in environment", () => {
  test("writes the four OPENSHIFT_* variables the V1 hand wiring set, and the Helm admin target", () => {
    const env = envOf(render(OPENSHIFT));
    expect(env.OPENSHIFT_OAUTH_CLIENT_ID).toBe(`system:serviceaccount:${NAMESPACE}:${RELEASE}`);
    expect(env.OPENSHIFT_PUBLIC_URL).toBe(`https://${HOST}`);
    expect(env.OPENSHIFT_OAUTH_TOKEN_FILE).toBe(`${SIGN_IN_DIR}/oauth-client-token`);
    expect(env.OPENSHIFT_API_CA_FILE).toBe(`${SIGN_IN_DIR}/ca.crt`);
    expect(env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT).toBe(`${NAMESPACE}/${RELEASE}`);
    expect(env).not.toHaveProperty("KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO");
    expect(env).not.toHaveProperty("OPENSHIFT_API_URL");
  });

  test("the client id and the admin target follow the fullname and a named ServiceAccount", () => {
    const docs = render(set(...OPENSHIFT_PAIRS, "nameOverride=studio", "serviceAccount.name=studio-oauth"));
    const env = envOf(docs, "v1os-studio");
    expect(env.OPENSHIFT_OAUTH_CLIENT_ID).toBe(`system:serviceaccount:${NAMESPACE}:studio-oauth`);
    expect(env.KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT).toBe(`${NAMESPACE}/v1os-studio`);
    one(docs, "ServiceAccount", "studio-oauth");
  });

  test("the public URL carries config.basePath", () => {
    expect(envOf(render([...OPENSHIFT, ...set("config.basePath=/studio")])).OPENSHIFT_PUBLIC_URL).toBe(
      `https://${HOST}/studio`,
    );
  });

  test("operator-managed, the admin target is the LibreDBStudio resource, named by the release", () => {
    const docs = render(
      set(...OPENSHIFT_PAIRS, "nameOverride=studio", "operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`),
    );
    const env = envOf(docs, "v1os-studio");
    expect(env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO).toBe(`${NAMESPACE}/${RELEASE}`);
    expect(env).not.toHaveProperty("KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT");
  });

  test("operator-managed in a namespace other than the cluster Studio's, the admin target is still its own resource", () => {
    const env = envOf(render([...OPENSHIFT, ...set("operator.managed=true")]));
    expect(env.KUBERNETES_ACCESS_REVIEW_ADMIN_LIBREDBSTUDIO).toBe(`${NAMESPACE}/${RELEASE}`);
  });

  test("no password, user account or ServiceAccount review variable, even with secrets.existingSecret", () => {
    const names = envList(render([...OPENSHIFT, ...set("secrets.existingSecret=studio-secrets")])).map((e) => e.name);
    for (const name of [
      "ADMIN_PASSWORD",
      "USER_PASSWORD",
      "USER_EMAIL",
      "KUBERNETES_ACCESS_REVIEW",
      "KUBERNETES_ACCESS_REVIEW_API_URL",
      "KUBERNETES_ACCESS_REVIEW_TOKEN_PATH",
      "KUBERNETES_ACCESS_REVIEW_CA_PATH",
      "KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS",
      "KUBERNETES_ACCESS_REVIEW_SIGN_IN",
      "AUTH_SESSION_TTL_SECONDS",
    ]) {
      expect(names).not.toContain(name);
    }
    expect(configData(render(OPENSHIFT))).not.toHaveProperty("AUTH_SESSION_TTL_SECONDS");
  });

  test("openshift.signIn.reviewCacheSeconds and review write their variables when set", () => {
    const env = envOf(
      render([
        ...OPENSHIFT,
        ...set("openshift.signIn.reviewCacheSeconds=0"),
        "--set-string",
        "openshift.signIn.review=get projects.project.openshift.io",
      ]),
    );
    expect(env.KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS).toBe("0");
    expect(env.KUBERNETES_ACCESS_REVIEW_SIGN_IN).toBe("get projects.project.openshift.io");
  });

  test("config.sessionTtlSeconds still writes AUTH_SESSION_TTL_SECONDS", () => {
    expect(configData(render([...OPENSHIFT, ...set("config.sessionTtlSeconds=3600")])).AUTH_SESSION_TTL_SECONDS).toBe(
      "3600",
    );
  });

  test("every chart variable comes before extraEnv, so an extraEnv entry of the same name wins", () => {
    const list = envList(
      render([
        ...OPENSHIFT,
        ...set("extraEnv[0].name=OPENSHIFT_PUBLIC_URL", "extraEnv[0].value=https://studio.example.com"),
      ]),
    );
    const at = list.map((entry, index) => [entry.name, index] as const).filter(([name]) => name === "OPENSHIFT_PUBLIC_URL");
    expect(at).toHaveLength(2);
    expect(list[at[1][1]].value).toBe("https://studio.example.com");
    expect(at[1][1]).toBe(list.length - 1);
    for (const name of [
      "OPENSHIFT_OAUTH_CLIENT_ID",
      "OPENSHIFT_OAUTH_TOKEN_FILE",
      "OPENSHIFT_API_CA_FILE",
      "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT",
    ]) {
      expect(list.findIndex((entry) => entry.name === name)).toBeLessThan(at[1][1]);
    }
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode writes no OPENSHIFT_* variable and no admin target", (_, mode) => {
    const names = envList(render([...mode, ...set(`fullnameOverride=${RELEASE}`)])).map((entry) => entry.name);
    expect(names.filter((name) => name.startsWith("OPENSHIFT_") || name.startsWith("KUBERNETES_ACCESS_REVIEW"))).toEqual(
      [],
    );
  });
});

describe("discovery in openshift mode: the list refresh and custom connections", () => {
  test("no SEED_CACHE_TTL_MS, so the app's 10-second list refresh applies, and custom connections default off", () => {
    const docs = render([...OPENSHIFT, ...DISCOVERY]);
    expect(envOf(docs)).not.toHaveProperty("SEED_CACHE_TTL_MS");
    expect(envOf(docs).SEED_KUBERNETES_DISCOVERY_PATH).toBe("/var/run/libredb/kubernetes-discovery/export.json");
    expect(configData(docs).ALLOW_CUSTOM_CONNECTIONS).toBe("false");
  });

  test("seedConnections.cacheTTL is ignored in this mode, with a seed file too", () => {
    const docs = render([
      ...OPENSHIFT,
      ...set("seedConnections.enabled=true", "seedConnections.existingConfigMap=seeds", "seedConnections.cacheTTL=5000"),
    ]);
    expect(envOf(docs)).not.toHaveProperty("SEED_CACHE_TTL_MS");
    expect(envOf(docs).SEED_CONFIG_PATH).toBe("/app/config/seed-connections.yaml");
  });

  test("an explicit config.allowCustomConnections is honoured, true included", () => {
    expect(configData(render([...OPENSHIFT, ...DISCOVERY, ...set("config.allowCustomConnections=true")])).ALLOW_CUSTOM_CONNECTIONS).toBe(
      "true",
    );
    expect(configData(render([...OPENSHIFT, ...DISCOVERY, ...set("config.allowCustomConnections=false")])).ALLOW_CUSTOM_CONNECTIONS).toBe(
      "false",
    );
  });

  test("openshift mode without discovery leaves custom connections to the app", () => {
    expect(configData(render(OPENSHIFT))).not.toHaveProperty("ALLOW_CUSTOM_CONNECTIONS");
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode with discovery still writes SEED_CACHE_TTL_MS and leaves custom connections alone", (_, mode) => {
    const docs = render([...mode, ...DISCOVERY, ...set(`fullnameOverride=${RELEASE}`, "seedConnections.cacheTTL=10000")]);
    expect(envOf(docs).SEED_CACHE_TTL_MS).toBe("10000");
    expect(configData(docs)).not.toHaveProperty("ALLOW_CUSTOM_CONNECTIONS");
  });
});

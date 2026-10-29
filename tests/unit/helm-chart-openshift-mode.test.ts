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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    refused(
      [...OPENSHIFT, ...set("serviceAccount.create=false", "serviceAccount.name=studio")],
      "serviceAccount.create",
    );
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

  test.each(MODES)(
    "%s: operator-managed discovery of another namespace with no cluster Studio namespace fails",
    (_, mode) => {
      refused([...mode, ...DISCOVERY, ...set("operator.managed=true")], "operator.clusterStudioNamespace");
    },
  );

  test.each(MODES)(
    "%s: operator-managed discovery from a namespace other than the cluster Studio's fails",
    (_, mode) => {
      refused(
        [...mode, ...DISCOVERY, ...set("operator.managed=true", "operator.clusterStudioNamespace=studio")],
        "operator.clusterStudioNamespace",
      );
    },
  );

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
      ...set(
        "discovery.kubernetes.enabled=true",
        `discovery.kubernetes.namespaces={${NAMESPACE}}`,
        "operator.managed=true",
      ),
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
    [
      "serviceaccounts.openshift.io/oauth-redirectreference.studio",
      '{"kind":"OAuthRedirectReference","apiVersion":"v1","reference":{"kind":"Route","name":"v1os"}}',
    ],
    ["serviceaccounts.openshift.io/oauth-redirecturi.other", "https://elsewhere.example.com/cb"],
  ])(
    "a user redirect annotation %s fails naming it, so the OAuth server accepts the one callback only",
    (key, value) => {
      refused(
        [...OPENSHIFT, "--set-json", `serviceAccount.annotations=${JSON.stringify({ [key]: value })}`],
        "serviceAccount.annotations",
        key,
      );
    },
  );

  test("outside openshift mode a user redirect annotation is the user's own", () => {
    const key = "serviceaccounts.openshift.io/oauth-redirecturi.other";
    const account = one(
      render([
        ...set(`fullnameOverride=${RELEASE}`),
        "--set-json",
        `serviceAccount.annotations=${JSON.stringify({ [key]: "https://elsewhere.example.com/cb" })}`,
      ]),
      "ServiceAccount",
      RELEASE,
    );
    expect(account.metadata.annotations?.[key]).toBe("https://elsewhere.example.com/cb");
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
    expect(pod.containers[0].volumeMounts).toContainEqual({
      name: "openshift-oauth",
      mountPath: SIGN_IN_DIR,
      readOnly: true,
    });
  });

  test("the token lifetime comes from openshift.signIn.tokenExpirationSeconds", () => {
    const pod = studioPod(render([...OPENSHIFT, ...set("openshift.signIn.tokenExpirationSeconds=3600")]));
    const volume = pod.volumes?.find((entry) => entry.name === "openshift-oauth");
    expect(volume?.projected?.sources[0]).toEqual({
      serviceAccountToken: {
        audience: "libredb-studio-oauth-client",
        expirationSeconds: 3600,
        path: "oauth-client-token",
      },
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
      set(
        ...OPENSHIFT_PAIRS,
        "nameOverride=studio",
        "operator.managed=true",
        `operator.clusterStudioNamespace=${NAMESPACE}`,
      ),
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
    const at = list
      .map((entry, index) => [entry.name, index] as const)
      .filter(([name]) => name === "OPENSHIFT_PUBLIC_URL");
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
    expect(
      names.filter((name) => name.startsWith("OPENSHIFT_") || name.startsWith("KUBERNETES_ACCESS_REVIEW")),
    ).toEqual([]);
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
      ...set(
        "seedConnections.enabled=true",
        "seedConnections.existingConfigMap=seeds",
        "seedConnections.cacheTTL=5000",
      ),
    ]);
    expect(envOf(docs)).not.toHaveProperty("SEED_CACHE_TTL_MS");
    expect(envOf(docs).SEED_CONFIG_PATH).toBe("/app/config/seed-connections.yaml");
  });

  test("an explicit config.allowCustomConnections is honoured, true included", () => {
    expect(
      configData(render([...OPENSHIFT, ...DISCOVERY, ...set("config.allowCustomConnections=true")]))
        .ALLOW_CUSTOM_CONNECTIONS,
    ).toBe("true");
    expect(
      configData(render([...OPENSHIFT, ...DISCOVERY, ...set("config.allowCustomConnections=false")]))
        .ALLOW_CUSTOM_CONNECTIONS,
    ).toBe("false");
  });

  test("openshift mode without discovery leaves custom connections to the app", () => {
    expect(configData(render(OPENSHIFT))).not.toHaveProperty("ALLOW_CUSTOM_CONNECTIONS");
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode with discovery still writes SEED_CACHE_TTL_MS and leaves custom connections alone", (_, mode) => {
    const docs = render([
      ...mode,
      ...DISCOVERY,
      ...set(`fullnameOverride=${RELEASE}`, "seedConnections.cacheTTL=10000"),
    ]);
    expect(envOf(docs).SEED_CACHE_TTL_MS).toBe("10000");
    expect(configData(docs)).not.toHaveProperty("ALLOW_CUSTOM_CONNECTIONS");
  });
});

describe("the cluster domain of discovered hosts", () => {
  test("discovery.kubernetes.clusterDomain writes SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN on Studio, which maps the rows", () => {
    const docs = render([...OPENSHIFT, ...DISCOVERY, ...set("discovery.kubernetes.clusterDomain=corp.example")]);
    expect(envOf(docs).SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN).toBe("corp.example");
    expect(envOf(render([...OPENSHIFT, ...DISCOVERY]))).not.toHaveProperty("SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN");
    const local = render([
      ...DISCOVERY,
      ...set(`fullnameOverride=${RELEASE}`, "discovery.kubernetes.clusterDomain=corp.example"),
    ]);
    expect(envOf(local).SEED_KUBERNETES_DISCOVERY_CLUSTER_DOMAIN).toBe("corp.example");
  });
});

/**
 * L35: in openshift mode with discovery on, the egress-confining NetworkPolicy renders unless networkPolicy.enabled
 * is false, because it is the network control that holds even against a forged Service in a discovered namespace.
 */
describe("database egress confined to the discovered namespaces", () => {
  const DATABASE_PORTS = [5432, 3306, 1521, 1433, 27017, 6379].map((port) => ({ port, protocol: "TCP" }));
  const namespaceTo = (name: string) => ({
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } },
  });

  function policies(args: string[]): Manifest[] {
    // The bundled PostgreSQL subchart renders a NetworkPolicy of its own, named after it.
    return all(render(args), "NetworkPolicy").filter((policy) => policy.metadata.name === RELEASE);
  }

  function egress(args: string[]): EgressRule[] {
    const [policy] = policies(args);
    if (!policy?.spec?.egress) throw new Error("no NetworkPolicy egress in render output");
    return policy.spec.egress;
  }

  function databaseRule(rules: EgressRule[]): EgressRule {
    const found = rules.filter((rule) => (rule.ports ?? []).some((entry) => entry.port === 5432));
    expect(found).toHaveLength(1);
    return found[0];
  }

  test("renders by default in openshift discovery mode, the database rule naming each discovered namespace", () => {
    const rules = egress([...OPENSHIFT, ...DISCOVERY]);
    expect(databaseRule(rules)).toEqual({ ports: DATABASE_PORTS, to: [namespaceTo("team-a"), namespaceTo("team-b")] });
  });

  test("DNS, the API server and 443 stay open to every destination", () => {
    const rules = egress([...OPENSHIFT, ...DISCOVERY]);
    for (const port of [53, 5353, 443, 6443]) {
      const rule = rules.find((entry) => (entry.ports ?? []).some((item) => item.port === port));
      expect(rule).toBeDefined();
      expect(rule?.to).toBeUndefined();
    }
  });

  test("5353 and 6443 render in openshift mode without security.openshift.io detection", () => {
    const pairs = OPENSHIFT_PAIRS.filter((pair) => !pair.startsWith("global.compatibility"));
    const ports = egress([
      ...set(...pairs, `fullnameOverride=${RELEASE}`),
      ...DISCOVERY,
      "--api-versions",
      "route.openshift.io/v1",
    ]).flatMap((rule) => rule.ports ?? []);
    expect(ports).toContainEqual({ port: 5353, protocol: "UDP" });
    expect(ports).toContainEqual({ port: 5353, protocol: "TCP" });
    expect(ports).toContainEqual({ port: 6443, protocol: "TCP" });
  });

  test("the release namespace joins the list while the bundled PostgreSQL holds Studio's storage", () => {
    const rule = databaseRule(egress([...OPENSHIFT, ...DISCOVERY, ...set("postgresql.enabled=true")]));
    expect(rule.to).toEqual([namespaceTo("team-a"), namespaceTo("team-b"), namespaceTo(NAMESPACE)]);
  });

  test("a discovered release namespace is named once", () => {
    const rule = databaseRule(
      egress([
        ...OPENSHIFT,
        ...set("discovery.kubernetes.enabled=true", `discovery.kubernetes.namespaces={${NAMESPACE},team-a}`),
        ...set("postgresql.enabled=true"),
      ]),
    );
    expect(rule.to).toEqual([namespaceTo(NAMESPACE), namespaceTo("team-a")]);
  });

  test("networkPolicy.additionalEgress is kept for an external storage database", () => {
    const rules = egress([
      ...OPENSHIFT,
      ...DISCOVERY,
      "--set-json",
      'networkPolicy.additionalEgress=[{"to":[{"ipBlock":{"cidr":"10.0.0.5/32"}}],"ports":[{"port":5432,"protocol":"TCP"}]}]',
    ]);
    expect(rules.at(-1)).toEqual({
      to: [{ ipBlock: { cidr: "10.0.0.5/32" } }],
      ports: [{ port: 5432, protocol: "TCP" }],
    });
  });

  test("networkPolicy.enabled=true confines it the same way", () => {
    const rule = databaseRule(egress([...OPENSHIFT, ...DISCOVERY, ...set("networkPolicy.enabled=true")]));
    expect(rule.to).toEqual([namespaceTo("team-a"), namespaceTo("team-b")]);
  });

  test("networkPolicy.enabled=false is the opt-out", () => {
    expect(policies([...OPENSHIFT, ...DISCOVERY, ...set("networkPolicy.enabled=false")])).toEqual([]);
  });

  test("unset renders nothing in openshift mode without discovery", () => {
    expect(policies(OPENSHIFT)).toEqual([]);
  });

  test.each([
    ["local", set("authProvider=local")],
    ["oidc", set("authProvider=oidc")],
  ])("%s mode: unset renders nothing, and enabled keeps the database rule unconfined", (_, mode) => {
    const named = [...mode, ...DISCOVERY, ...set(`fullnameOverride=${RELEASE}`)];
    expect(policies(named)).toEqual([]);
    const rule = databaseRule(egress([...named, ...set("networkPolicy.enabled=true")]));
    expect(rule).toEqual({ ports: DATABASE_PORTS });
  });

  test("a default install renders no NetworkPolicy, on OpenShift too", () => {
    expect(policies([])).toEqual([]);
    expect(policies(set("global.compatibility.openshift.apis=force"))).toEqual([]);
  });
});

describe("the openshift-mode guards", () => {
  test.each([
    ["openshiftRoute.enabled=false", "openshiftRoute.enabled"],
    ["openshiftRoute.host=", "openshiftRoute.host"],
    ["replicaCount=2", "replicaCount"],
    ["autoscaling.enabled=true", "autoscaling.enabled"],
    ["config.oidcRoleClaim=groups", "config.oidcRoleClaim"],
    ["agent.enabled=true", "agent.enabled"],
    ["accessReview.enabled=true", "accessReview.enabled"],
    ["accessReview.cacheSeconds=10", "accessReview.cacheSeconds"],
    ["secrets.adminPassword=not-a-real-password", "secrets.adminPassword"],
    ["secrets.userPassword=not-a-real-password", "secrets.userPassword"],
    ["governance.enabled=true", "governance.enabled"],
    ["serviceAccount.automountServiceAccountToken=true", "serviceAccount.automountServiceAccountToken"],
  ])("%s fails naming %s", (pair, value) => {
    refused([...OPENSHIFT, ...set(pair)], value, "authProvider=openshift");
  });

  test("with discovery, the exporter's ServiceAccount as Studio's fails naming serviceAccount.name", () => {
    refused(
      [...OPENSHIFT, ...DISCOVERY, ...set(`serviceAccount.name=${RELEASE}-discovery`)],
      "serviceAccount.name",
      `${RELEASE}-discovery`,
      "authProvider=openshift",
    );
    render([...OPENSHIFT, ...DISCOVERY, ...set("serviceAccount.name=studio")]);
  });

  test("mcp.enabled fails naming mcp.enabled", () => {
    refused(
      [...OPENSHIFT, ...set("mcp.enabled=true", "mcp.url=https://studio.example.com/api/mcp", "mcp.tokenLabel=one")],
      "mcp.enabled",
    );
  });

  test("a non-empty accessReview.signIn fails naming it", () => {
    refused([...OPENSHIFT, "--set-string", "accessReview.signIn=list pods"], "accessReview.signIn");
  });

  test("the default accessReview.tokenExpirationSeconds does not fail, and nothing grants a review", () => {
    expect(values.accessReview.tokenExpirationSeconds).toBe(3600);
    const docs = render([...OPENSHIFT, ...DISCOVERY]);
    expect(all(docs, "ClusterRole")).toEqual([]);
    expect(all(docs, "ClusterRoleBinding")).toEqual([]);
    for (const doc of docs) {
      for (const rule of doc.rules ?? []) expect(rule.resources).not.toContain("subjectaccessreviews");
      for (const subject of doc.subjects ?? []) expect(subject.name).not.toBe("system:auth-delegator");
      expect(doc.roleRef?.name).not.toBe("system:auth-delegator");
    }
  });

  describe("the image floor: release 1.1.0 and earlier have no openshift sign-in", () => {
    const withoutTag = set(
      ...OPENSHIFT_PAIRS.filter((pair) => !pair.startsWith("image.tag")),
      `fullnameOverride=${RELEASE}`,
    );

    test("the default image, appVersion 1.1.0, fails naming image.tag", () => {
      refused(withoutTag, "image.tag", "1.1.0");
    });

    test.each(["1.1.0", "v1.1.0", "1.0.0", "0.18.3", "1.1.0-rc.1", "1.1.0+build.7"])("image.tag=%s fails", (tag) => {
      refused([...withoutTag, "--set-string", `image.tag=${tag}`], "image.tag");
    });

    test.each(["1.1.1", "1.2.0", "v2.0.0", "1.2.0-rc.1", "latest", "v1-83fd4765c", "main", "sha-5b9f5a051"])(
      "image.tag=%s renders",
      (tag) => {
        render([...withoutTag, "--set-string", `image.tag=${tag}`]);
      },
    );
  });

  describe("a hand-wired install moved to openshift mode", () => {
    const HAND_WIRED_VOLUME =
      'extraVolumes=[{"name":"openshift-oauth","projected":{"sources":[{"serviceAccountToken":{"audience":"libredb-studio-oauth-client","expirationSeconds":600,"path":"oauth-client-token"}}]}}]';
    const HAND_WIRED_MOUNT = `extraVolumeMounts=[{"name":"openshift-oauth","mountPath":"${SIGN_IN_DIR}","readOnly":true}]`;

    test("an extraVolumes entry named openshift-oauth fails naming extraVolumes", () => {
      refused([...OPENSHIFT, "--set-json", HAND_WIRED_VOLUME], "extraVolumes", "openshift-oauth");
    });

    test("an extraVolumeMounts entry at the sign-in directory fails naming extraVolumeMounts", () => {
      refused(
        [...OPENSHIFT, "--set-json", `extraVolumeMounts=[{"name":"own","mountPath":"${SIGN_IN_DIR}/"}]`],
        "extraVolumeMounts",
        SIGN_IN_DIR,
      );
    });

    test("the V2 hand wiring's volume, mount and variable fail instead of rendering a duplicate volume", () => {
      refused(
        [
          ...OPENSHIFT,
          "--set-json",
          HAND_WIRED_VOLUME,
          "--set-json",
          HAND_WIRED_MOUNT,
          "--set-json",
          `extraEnv=[{"name":"OPENSHIFT_OAUTH_CLIENT_ID","value":"system:serviceaccount:${NAMESPACE}:${RELEASE}"}]`,
        ],
        "openshift-oauth",
      );
    });

    test("other extra volumes still render", () => {
      render([
        ...OPENSHIFT,
        "--set-json",
        'extraVolumes=[{"name":"internal-ca","configMap":{"name":"internal-ca"}}]',
        "--set-json",
        'extraVolumeMounts=[{"name":"internal-ca","mountPath":"/etc/ssl/internal"}]',
      ]);
    });
  });
});

/**
 * Every openshift-mode control keys on authProvider, but the app reads its mode from NEXT_PUBLIC_AUTH_PROVIDER, and an
 * extraEnv entry wins over the ConfigMap. The V1 and V2 hand wiring is exactly that: authProvider local and an extraEnv
 * NEXT_PUBLIC_AUTH_PROVIDER=openshift, which would run openshift sign-in with none of the mode's guards, no egress
 * policy and custom connections on.
 */
describe("extraEnv cannot move the sign-in mode away from authProvider", () => {
  let handWired: string;

  beforeAll(() => {
    handWired = mkdtempSync(join(tmpdir(), "libredb-openshift-mode-hand-wired-"));
    // The V2 lab's values-openshift-mode.yaml, unchanged but for the image, which an offline render cannot pull.
    writeFileSync(
      join(handWired, "values.yaml"),
      JSON.stringify({
        fullnameOverride: RELEASE,
        image: { tag: "1.1.0" },
        authProvider: "local",
        secrets: { adminPassword: "", userPassword: "" },
        serviceAccount: {
          annotations: {
            "serviceaccounts.openshift.io/oauth-redirectreference.first": `{"kind":"OAuthRedirectReference","apiVersion":"v1","reference":{"kind":"Route","name":"${RELEASE}"}}`,
            "serviceaccounts.openshift.io/oauth-redirecturi.first": "api/auth/openshift/callback",
          },
        },
        openshiftRoute: { enabled: true, host: HOST },
        extraEnv: [
          { name: "NEXT_PUBLIC_AUTH_PROVIDER", value: "openshift" },
          { name: "OPENSHIFT_OAUTH_CLIENT_ID", value: `system:serviceaccount:${NAMESPACE}:${RELEASE}` },
          { name: "OPENSHIFT_PUBLIC_URL", value: `https://${HOST}` },
          { name: "OPENSHIFT_OAUTH_TOKEN_FILE", value: `${SIGN_IN_DIR}/oauth-client-token` },
          { name: "OPENSHIFT_API_CA_FILE", value: `${SIGN_IN_DIR}/ca.crt` },
          { name: "KUBERNETES_ACCESS_REVIEW_ADMIN_DEPLOYMENT", value: `${NAMESPACE}/${RELEASE}` },
        ],
        extraVolumes: [
          {
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
          },
        ],
        extraVolumeMounts: [{ name: "openshift-oauth", mountPath: SIGN_IN_DIR, readOnly: true }],
        discovery: { kubernetes: { enabled: true, namespaces: ["team-a", "team-b", "team-m"], kinds: ["cnpg"] } },
      }),
    );
  });

  afterAll(() => rmSync(handWired, { recursive: true, force: true }));

  test("the V2 hand wiring fails naming authProvider and NEXT_PUBLIC_AUTH_PROVIDER", () => {
    refused(
      ["-f", join(handWired, "values.yaml"), ...set("global.compatibility.openshift.apis=force")],
      "authProvider",
      "NEXT_PUBLIC_AUTH_PROVIDER",
    );
  });

  test.each([
    [
      "local mode, openshift in extraEnv",
      set("extraEnv[0].name=NEXT_PUBLIC_AUTH_PROVIDER", "extraEnv[0].value=openshift"),
    ],
    [
      "openshift mode, local in extraEnv",
      [...OPENSHIFT, ...set("extraEnv[0].name=NEXT_PUBLIC_AUTH_PROVIDER", "extraEnv[0].value=local")],
    ],
    [
      "an extraEnv entry read from elsewhere",
      [
        ...OPENSHIFT,
        "--set-json",
        'extraEnv=[{"name":"NEXT_PUBLIC_AUTH_PROVIDER","valueFrom":{"configMapKeyRef":{"name":"mode","key":"provider"}}}]',
      ],
    ],
  ])("%s fails naming authProvider", (_, args) => {
    refused(args, "authProvider", "NEXT_PUBLIC_AUTH_PROVIDER");
  });

  test("an extraEnv entry naming the same mode renders, trimmed and lower-cased as the app reads it", () => {
    render([...OPENSHIFT, ...set("extraEnv[0].name=NEXT_PUBLIC_AUTH_PROVIDER", "extraEnv[0].value= OpenShift ")]);
    render(set("extraEnv[0].name=NEXT_PUBLIC_AUTH_PROVIDER", "extraEnv[0].value=local"));
  });

  test.each(["OPENSHIFT_OAUTH_CLIENT_ID", "OPENSHIFT_OAUTH_TOKEN_FILE"])(
    "outside openshift mode, an extraEnv %s fails naming authProvider",
    (name) => {
      for (const mode of [[], set("authProvider=oidc")]) {
        refused([...mode, ...set(`extraEnv[0].name=${name}`, "extraEnv[0].value=x")], "authProvider", name);
      }
    },
  );
});

/** OT22: on OpenShift, discovery with oidc sign-in would review the identity provider's subject, not the cluster's. */
describe("discovery on OpenShift needs openshift or local sign-in", () => {
  const OIDC = set("authProvider=oidc", "config.oidcIssuer=https://sso.example.com");

  test("oidc with discovery fails naming authProvider where config.openshift.io/v1 is served", () => {
    refused([...OIDC, ...DISCOVERY, "--api-versions", "config.openshift.io/v1"], "authProvider");
  });

  test("and with apis=force", () => {
    refused([...OIDC, ...DISCOVERY, ...set("global.compatibility.openshift.apis=force")], "authProvider");
  });

  test("oidc with discovery still renders on a cluster without the API, the Rancher path", () => {
    render([...OIDC, ...DISCOVERY]);
  });

  test("local with discovery renders on OpenShift", () => {
    render([...DISCOVERY, "--api-versions", "config.openshift.io/v1"]);
  });

  test("oidc without discovery renders on OpenShift", () => {
    render([...OIDC, "--api-versions", "config.openshift.io/v1"]);
  });
});

/** Design OS4: the exporter's pod drops the fixed IDs under the restricted-v2 SCC and keeps them elsewhere. */
describe("the discovery exporter under the OpenShift SCC", () => {
  function exporterContext(args: string[]): Record<string, unknown> {
    return studioPod(render([...args, ...DISCOVERY]), `${RELEASE}-discovery`).securityContext ?? {};
  }

  test("drops runAsUser, runAsGroup and fsGroup where security.openshift.io/v1 is served", () => {
    const context = exporterContext([...OPENSHIFT, "--api-versions", "security.openshift.io/v1"]);
    expect(context).not.toHaveProperty("runAsUser");
    expect(context).not.toHaveProperty("fsGroup");
    expect(context.runAsNonRoot).toBe(true);
  });

  test("keeps them on vanilla Kubernetes", () => {
    const context = exporterContext(set(`fullnameOverride=${RELEASE}`));
    expect(context.runAsUser).toBe(1001);
    expect(context.fsGroup).toBe(1001);
  });
});

describe("the Tier 0 ConsoleLink", () => {
  const LINK = set("openshift.consoleLink.enabled=true");
  const DASHBOARD = set("openshift.consoleLink.enabled=true", "openshift.consoleLink.location=NamespaceDashboard");
  const RELEASE_DERIVED = `${NAMESPACE}.${RELEASE}`;

  function consoleLinks(args: string[]): Manifest[] {
    return all(render(args), "ConsoleLink");
  }

  test("with discovery on, the ApplicationMenu link is the locator: fixed name and label, the Route's https URL", () => {
    const [link, ...rest] = consoleLinks([...OPENSHIFT, ...DISCOVERY, ...LINK]);
    expect(rest).toEqual([]);
    expect(link.apiVersion).toBe("console.openshift.io/v1");
    expect(link.metadata.name).toBe("libredb-studio");
    expect(link.metadata.namespace).toBeUndefined();
    expect(link.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
    expect(link.spec).toEqual({
      href: `https://${HOST}`,
      text: "LibreDB Studio",
      location: "ApplicationMenu",
      applicationMenu: { section: "LibreDB" },
    });
  });

  test("the locator keeps its name and label under a nameOverride", () => {
    const [link] = consoleLinks([...set(...OPENSHIFT_PAIRS, "nameOverride=studio"), ...DISCOVERY, ...LINK]);
    expect(link.metadata.name).toBe("libredb-studio");
    expect(link.metadata.labels?.["app.kubernetes.io/name"]).toBe("libredb-studio");
  });

  test("the href carries config.basePath, and the text, section and icon come from the values", () => {
    const [link] = consoleLinks([
      ...OPENSHIFT,
      ...LINK,
      ...set(
        "config.basePath=/studio",
        "openshift.consoleLink.text=Databases",
        "openshift.consoleLink.section=Data",
        "openshift.consoleLink.imageUrl=https://example.com/icon.png",
      ),
    ]);
    expect(link.spec?.href).toBe(`https://${HOST}/studio`);
    expect(link.spec?.text).toBe("Databases");
    expect(link.spec?.applicationMenu).toEqual({ section: "Data", imageURL: "https://example.com/icon.png" });
  });

  test("with discovery off, the ApplicationMenu link has a release-derived name and no locator label", () => {
    const [link] = consoleLinks([...OPENSHIFT, ...LINK]);
    expect(link.metadata.name).toBe(RELEASE_DERIVED);
    expect(link.metadata.labels).not.toHaveProperty(["app.kubernetes.io/name"]);
    expect(link.metadata.labels?.["app.kubernetes.io/instance"]).toBe(RELEASE);
    expect(link.spec?.location).toBe("ApplicationMenu");
  });

  test("a NamespaceDashboard link names its namespaces, with a release-derived name and no locator label", () => {
    const [link] = consoleLinks([
      ...OPENSHIFT,
      ...DASHBOARD,
      ...set("openshift.consoleLink.namespaces={team-a,team-b}"),
    ]);
    expect(link.metadata.name).toBe(RELEASE_DERIVED);
    expect(link.metadata.labels).not.toHaveProperty(["app.kubernetes.io/name"]);
    expect(link.spec).toEqual({
      href: `https://${HOST}`,
      text: "LibreDB Studio",
      location: "NamespaceDashboard",
      namespaceDashboard: { namespaces: ["team-a", "team-b"] },
    });
  });

  test("a NamespaceDashboard link takes a namespace selector", () => {
    const [link] = consoleLinks([
      ...OPENSHIFT,
      ...DASHBOARD,
      "--set-json",
      'openshift.consoleLink.namespaceSelector={"matchLabels":{"team":"data"}}',
    ]);
    expect(link.spec?.namespaceDashboard).toEqual({ namespaceSelector: { matchLabels: { team: "data" } } });
  });

  test("a NamespaceDashboard link with neither namespaces nor a selector fails", () => {
    refused(
      [...OPENSHIFT, ...DASHBOARD],
      "openshift.consoleLink.namespaces",
      "openshift.consoleLink.namespaceSelector",
    );
  });

  test("a NamespaceDashboard link with discovery on fails, so a team link never takes the locator's place", () => {
    refused(
      [...OPENSHIFT, ...DISCOVERY, ...DASHBOARD, ...set("openshift.consoleLink.namespaces={team-a}")],
      "openshift.consoleLink.location",
    );
  });

  test("the link without openshiftRoute.host fails naming it", () => {
    refused(
      [...LINK, ...set("global.compatibility.openshift.apis=force")],
      "openshift.consoleLink",
      "openshiftRoute.host",
    );
  });

  test("without console.openshift.io/v1 and without force it fails naming the force switch", () => {
    const pairs = OPENSHIFT_PAIRS.filter((pair) => !pair.startsWith("global.compatibility"));
    refused(
      [...set(...pairs, `fullnameOverride=${RELEASE}`), ...LINK, "--api-versions", "route.openshift.io/v1"],
      "console.openshift.io/v1",
      "global.compatibility.openshift.apis=force",
    );
  });

  test("a served console.openshift.io/v1 is detected", () => {
    const pairs = OPENSHIFT_PAIRS.filter((pair) => !pair.startsWith("global.compatibility"));
    const links = consoleLinks([
      ...set(...pairs, `fullnameOverride=${RELEASE}`),
      ...LINK,
      "--api-versions",
      "route.openshift.io/v1",
      "--api-versions",
      "console.openshift.io/v1",
    ]);
    expect(links).toHaveLength(1);
  });

  test("operator-managed, it renders only for the cluster Studio's namespace (O14)", () => {
    refused([...OPENSHIFT, ...LINK, ...set("operator.managed=true")], "operator.clusterStudioNamespace");
    refused(
      [...OPENSHIFT, ...LINK, ...set("operator.managed=true", "operator.clusterStudioNamespace=studio")],
      "operator.clusterStudioNamespace",
    );
    expect(
      consoleLinks([
        ...OPENSHIFT,
        ...LINK,
        ...set("operator.managed=true", `operator.clusterStudioNamespace=${NAMESPACE}`),
      ]),
    ).toHaveLength(1);
  });

  test("no ConsoleLink reader role or binding ships: every authenticated user may already read them", () => {
    const docs = render([...OPENSHIFT, ...DISCOVERY, ...LINK]);
    for (const kind of ["ClusterRole", "ClusterRoleBinding"]) expect(all(docs, kind)).toEqual([]);
    for (const role of all(docs, "Role")) {
      for (const rule of role.rules ?? []) expect(rule.resources).not.toContain("consolelinks");
    }
  });

  test("off by default: no ConsoleLink, on OpenShift too", () => {
    expect(consoleLinks(OPENSHIFT)).toEqual([]);
    expect(consoleLinks([...OPENSHIFT, ...DISCOVERY])).toEqual([]);
  });
});

/**
 * With every new value at its default, the render keeps the objects, variables and volumes it had before openshift
 * mode existed, on vanilla Kubernetes and on OpenShift. Compared in structure, not byte for byte: the chart version
 * is in every object's helm.sh/chart label.
 */
describe("the default render is unchanged", () => {
  const FULLNAME = `${RELEASE}-libredb-studio`;
  const OPENSHIFT_APIS = [
    "security.openshift.io/v1",
    "config.openshift.io/v1",
    "route.openshift.io/v1",
    "console.openshift.io/v1",
  ].flatMap((api) => ["--api-versions", api]);

  test.each([
    ["vanilla Kubernetes", []],
    ["OpenShift", OPENSHIFT_APIS],
    ["OpenShift with apis=force", set("global.compatibility.openshift.apis=force")],
  ])("on %s: the same objects, variables, ConfigMap keys and volumes", (_, args) => {
    const docs = render(args);
    expect(docs.map((doc) => `${doc.kind}/${doc.metadata.name}`)).toEqual([
      `ServiceAccount/${FULLNAME}`,
      `Secret/${FULLNAME}`,
      `ConfigMap/${FULLNAME}-config`,
      `Service/${FULLNAME}`,
      `Deployment/${FULLNAME}`,
      `Pod/${FULLNAME}-test-health`,
    ]);
    expect(envList(docs, FULLNAME).map((entry) => entry.name)).toEqual(["ADMIN_EMAIL", "WORKFLOW_LOCAL_DATA_DIR"]);
    expect(Object.keys(configData(docs, `${FULLNAME}-config`))).toEqual([
      "NODE_ENV",
      "PORT",
      "HOSTNAME",
      "NEXT_TELEMETRY_DISABLED",
      "NODE_OPTIONS",
      "NEXT_PUBLIC_AUTH_PROVIDER",
      "LOG_LEVEL",
      "STORAGE_PROVIDER",
    ]);
    expect((studioPod(docs, FULLNAME).volumes ?? []).map((volume) => volume.name)).toEqual([
      "next-cache",
      "tmp",
      "data",
    ]);
    expect(one(docs, "ServiceAccount", FULLNAME).metadata.annotations).toBeUndefined();
  });
});

describe("install notes in openshift mode", () => {
  // helm template never emits NOTES.txt, so the real file is wrapped in a named template inside a private copy of the
  // chart and rendered into a ConfigMap, as tests/unit/helm-chart-openshift-route.test.ts does.
  const PROBE_TEMPLATE = "templates/zz-notes-probe.yaml";
  let notesChart: string;

  beforeAll(() => {
    notesChart = mkdtempSync(join(tmpdir(), "libredb-openshift-mode-notes-probe-"));
    cpSync(CHART_DIR, notesChart, { recursive: true });
    writeFileSync(
      join(notesChart, PROBE_TEMPLATE),
      `{{- define "notesProbe" -}}\n${readFileSync(join(CHART_DIR, "templates/NOTES.txt"), "utf8")}\n{{- end -}}\n` +
        'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: notes-probe\ndata:\n  notes: {{ include "notesProbe" . | quote }}\n',
    );
  });

  afterAll(() => rmSync(notesChart, { recursive: true, force: true }));

  function notes(args: string[]): string {
    const run = Bun.spawnSync(
      ["helm", "template", RELEASE, notesChart, "--namespace", NAMESPACE, "--show-only", PROBE_TEMPLATE, ...args],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) throw new Error(`helm template of the notes probe ${howItFailed(run)}: ${run.stderr}`);
    const rendered = parseAllDocuments(run.stdout.toString())
      .map((doc) => doc.toJS() as { data?: { notes?: string } } | null)
      .find((doc) => doc?.data?.notes !== undefined);
    return rendered?.data?.notes ?? "";
  }

  test("names the mode, where people sign in, the admin rule and that the console plugin is not in this release", () => {
    const text = notes(OPENSHIFT);
    expect(text).toContain("Auth Provider:    openshift");
    expect(text).toContain(
      "Access LibreDB Studio via the OpenShift Route:\n  https://v1os-os-lab-v1.apps-crc.testing\n",
    );
    expect(text).toContain("OpenShift sign-in:");
    expect(text).toContain(`whoever may update the Deployment ${NAMESPACE}/${RELEASE}`);
    expect(text).toContain("The OpenShift console plugin is not part of this release");
    expect(text).not.toContain("First-run credentials");
  });

  test("operator-managed, the admin rule names the LibreDBStudio resource", () => {
    const text = notes([...OPENSHIFT, ...set("operator.managed=true")]);
    expect(text).toContain(`whoever may update the LibreDBStudio ${NAMESPACE}/${RELEASE}`);
  });

  test("with discovery, names the egress policy and custom connections off", () => {
    const text = notes([...OPENSHIFT, ...DISCOVERY]);
    expect(text).toContain("database egress only to team-a, team-b");
    expect(text).toContain("networkPolicy.enabled=false");
    expect(text).toContain("ALLOW_CUSTOM_CONNECTIONS=false");
  });

  test("local mode carries none of it", () => {
    expect(notes(set(`fullnameOverride=${RELEASE}`))).not.toContain("OpenShift sign-in:");
  });
});

describe("the chart README documents openshift mode", () => {
  const readme = readFileSync(join(CHART_DIR, "README.md"), "utf8");
  const section = readme.slice(
    readme.indexOf("### OpenShift sign-in"),
    readme.indexOf("### The cluster's trusted CA bundle"),
  );

  test.each([
    "authProvider=openshift",
    "openshiftRoute.host",
    "replicaCount",
    "ALLOW_CUSTOM_CONNECTIONS",
    "networkPolicy.additionalEgress",
    "networkPolicy.enabled=false",
    "seedConnections.cacheTTL",
    "openshift.consoleLink",
    "NamespaceDashboard",
    "operator.clusterStudioNamespace",
    "image.tag",
    "extraVolumes",
  ])("names %s", (needle) => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain(needle);
  });

  test("every new value is in the configuration reference", () => {
    for (const key of [
      "openshift.signIn.tokenExpirationSeconds",
      "openshift.signIn.reviewCacheSeconds",
      "openshift.signIn.review",
      "openshift.consoleLink.enabled",
      "openshift.consoleLink.location",
      "operator.managed",
      "operator.clusterStudioNamespace",
      "discovery.kubernetes.clusterDomain",
    ]) {
      expect(readme).toContain(`| \`${key}\` |`);
    }
  });
});

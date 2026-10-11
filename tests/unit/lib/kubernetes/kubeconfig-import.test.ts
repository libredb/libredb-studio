import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  KUBERNETES_KUBECONFIG_MAX_BYTES,
  KUBERNETES_KUBECONFIG_MAX_DEPTH,
} from "@/lib/db/providers/platform/kubernetes/limits";
import {
  importKubeconfig,
  KUBECONFIG_CONTEXT_REFUSALS as C,
  KUBECONFIG_IMPORT_SENTENCES as S,
  notImportedNotice,
  notPemRefusal,
  notTextRefusal,
  parseFailureSentence,
  unusedTlsNotice,
} from "@/lib/kubernetes/kubeconfig-import";

/**
 * The browser-side kubeconfig importer, every rule of the import: the text as a whole (size, parse, directive, tags,
 * aliases, merge keys), each context against its cluster and user, and the marker token that must never leave the
 * text, neither in a result nor on the console. Every kubeconfig here is synthesized.
 */

const MARKER = "k8s-import-marker-token-5f2c";
const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBtestca\n-----END CERTIFICATE-----\n";
const CERT_PEM = "-----BEGIN CERTIFICATE-----\nMIIBtestclient\n-----END CERTIFICATE-----\n";
const KEY_PEM = "-----BEGIN PRIVATE KEY-----\nMIIBtestkey\n-----END PRIVATE KEY-----\n";
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

/** A kubeconfig of one cluster, one user and one context, each part replaceable as YAML text. */
function kubeconfig(
  parts: { cluster?: string; user?: string; context?: string; current?: string | null; extra?: string } = {},
): string {
  const cluster = parts.cluster ?? `server: https://api.example:6443\n      certificate-authority-data: ${b64(CA_PEM)}`;
  const user = parts.user ?? `token: ${MARKER}`;
  const context = parts.context ?? "cluster: probe\n      user: reader\n      namespace: shop";
  const current =
    parts.current === undefined
      ? "current-context: probe\n"
      : parts.current === null
        ? ""
        : `current-context: ${parts.current}\n`;
  return `apiVersion: v1
kind: Config
${current}clusters:
  - name: probe
    cluster:
      ${cluster}
users:
  - name: reader
    user:
      ${user}
contexts:
  - name: probe
    context:
      ${context}
${parts.extra ?? ""}`;
}

let consoleCalls: unknown[][] = [];
const saved: Partial<Record<"log" | "info" | "warn" | "error" | "debug", (...args: unknown[]) => void>> = {};
beforeEach(() => {
  consoleCalls = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    saved[method] = console[method];
    console[method] = (...args: unknown[]) => {
      consoleCalls.push(args);
    };
  }
});
afterEach(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = saved[method];
    if (original !== undefined) console[method] = original;
  }
});

function only(text: string) {
  const result = importKubeconfig(text);
  expect(result.contexts).toHaveLength(1);
  return result.contexts[0];
}

function refusedContext(text: string): string[] {
  const result = importKubeconfig(text);
  expect(result.contexts).toEqual([]);
  return [...result.refusals];
}

describe("a context fills the form", () => {
  test("server, CA, token and namespace: verify-full with the CA, no notice", () => {
    const result = importKubeconfig(kubeconfig());
    expect(result).toEqual({
      contexts: [
        {
          name: "probe",
          fields: { host: "api.example", port: "6443", password: MARKER, database: "shop" },
          ssl: { mode: "verify-full", caCert: CA_PEM },
          notices: [],
        },
      ],
      refusals: [],
    });
  });

  test("without a CA the mode is verify-system", () => {
    expect(only(kubeconfig({ cluster: "server: https://api.example:6443" })).ssl).toEqual({ mode: "verify-system" });
  });

  test("an https server without a port means 443", () => {
    expect(only(kubeconfig({ cluster: "server: https://api.example" })).fields.port).toBe("443");
  });

  test("a Rancher server splits into host, port and API path, one trailing slash removed", () => {
    const context = only(kubeconfig({ cluster: "server: https://rancher.example/k8s/clusters/c-m-abc12/" }));
    expect(context.fields).toMatchObject({ host: "rancher.example", port: "443", apiPath: "/k8s/clusters/c-m-abc12" });
  });

  test("an IPv6 server keeps its brackets, as the Host box writes one", () => {
    expect(only(kubeconfig({ cluster: "server: https://[fd00::1]:6443" })).fields).toMatchObject({
      host: "[fd00::1]",
      port: "6443",
    });
  });

  test("tls-server-name fills the TLS server name", () => {
    const context = only(kubeconfig({ cluster: "server: https://10.0.0.5:6443\n      tls-server-name: api.internal" }));
    expect(context.fields.tlsServerName).toBe("api.internal");
  });

  test("a client certificate pair goes to the SSL panel", () => {
    const user = `client-certificate-data: ${b64(CERT_PEM)}\n      client-key-data: ${b64(KEY_PEM)}`;
    const context = only(kubeconfig({ user }));
    expect(context.ssl).toEqual({ mode: "verify-full", caCert: CA_PEM, clientCert: CERT_PEM, clientKey: KEY_PEM });
    expect(context.fields.password).toBeUndefined();
  });

  test("base64 wrapped over lines is read as one value, as kubectl reads it", () => {
    const encoded = b64(CA_PEM);
    const cluster = `server: https://api.example:6443\n      certificate-authority-data: "${encoded.slice(0, 20)}\\n${encoded.slice(20)}"`;
    expect(only(kubeconfig({ cluster })).ssl?.caCert).toBe(CA_PEM);
  });

  test("a context with no user fills the server alone", () => {
    const context = only(kubeconfig({ context: "cluster: probe" }));
    expect(context.fields).toEqual({ host: "api.example", port: "6443" });
    expect(context.notices).toEqual([]);
  });

  test("an http server maps to SSL mode disable with its notice, port 80 by default, and names the client pair it drops", () => {
    const user = `token: ${MARKER}\n      client-certificate-data: ${b64(CERT_PEM)}\n      client-key-data: ${b64(KEY_PEM)}`;
    const context = only(kubeconfig({ cluster: "server: http://127.0.0.1", user }));
    expect(context.fields).toMatchObject({ host: "127.0.0.1", port: "80" });
    expect(context.ssl).toEqual({ mode: "disable" });
    expect(context.notices).toEqual([
      S.plaintext,
      unusedTlsNotice(["client-certificate-data", "client-key-data"], "disable"),
    ]);
  });

  test("an http server names the CA it drops", () => {
    const cluster = `server: http://127.0.0.1:8001\n      certificate-authority-data: ${b64(CA_PEM)}`;
    const context = only(kubeconfig({ cluster }));
    expect(context.ssl).toEqual({ mode: "disable" });
    expect(context.notices).toEqual([S.plaintext, unusedTlsNotice(["certificate-authority-data"], "disable")]);
  });

  test("insecure-skip-tls-verify true maps to require with its notice; false changes nothing", () => {
    const insecure = only(
      kubeconfig({ cluster: "server: https://api.example:6443\n      insecure-skip-tls-verify: true" }),
    );
    expect(insecure.ssl).toEqual({ mode: "require" });
    expect(insecure.notices).toEqual([S.insecure]);
    const verified = only(
      kubeconfig({ cluster: "server: https://api.example:6443\n      insecure-skip-tls-verify: false" }),
    );
    expect(verified.ssl).toEqual({ mode: "verify-system" });
  });

  test("insecure-skip-tls-verify true names the CA it leaves unused", () => {
    const cluster = `server: https://api.example:6443\n      certificate-authority-data: ${b64(CA_PEM)}\n      insecure-skip-tls-verify: true`;
    const context = only(kubeconfig({ cluster }));
    expect(context.ssl).toEqual({ mode: "require" });
    expect(context.notices).toEqual([S.insecure, unusedTlsNotice(["certificate-authority-data"], "require")]);
  });

  test("disable-compression and extensions are ignored without a notice", () => {
    const cluster = "server: https://api.example:6443\n      disable-compression: true\n      extensions: []";
    const user = `token: ${MARKER}\n      extensions: []`;
    expect(only(kubeconfig({ cluster, user })).notices).toEqual([]);
  });

  test("a null value is read as absent", () => {
    expect(only(kubeconfig({ user: "token: null" })).fields.password).toBeUndefined();
  });

  test("a kubeconfig written as JSON is read the same way", () => {
    const json = JSON.stringify({
      "current-context": "probe",
      clusters: [{ name: "probe", cluster: { server: "https://api.example:6443" } }],
      users: [{ name: "reader", user: { token: MARKER } }],
      contexts: [{ name: "probe", context: { cluster: "probe", user: "reader" } }],
    });
    expect(only(json).fields).toEqual({ host: "api.example", port: "6443", password: MARKER });
  });
});

describe("partial imports and the settings Studio does not take", () => {
  test.each(["exec", "auth-provider"])(
    "a %s user fills the server, CA, TLS server name and namespace, never a credential",
    (plugin) => {
      const user = `token: ${MARKER}\n      ${plugin}:\n        name: cloud`;
      const cluster = `server: https://api.example:6443\n      certificate-authority-data: ${b64(CA_PEM)}\n      tls-server-name: api.internal`;
      const context = only(kubeconfig({ cluster, user }));
      expect(context.fields).toEqual({
        host: "api.example",
        port: "6443",
        tlsServerName: "api.internal",
        database: "shop",
      });
      expect(context.ssl).toEqual({ mode: "verify-full", caCert: CA_PEM });
      expect(context.notices).toEqual([notImportedNotice([plugin]), S.credentialPlugin]);
    },
  );

  test("every refused setting is named by its key, cluster keys first, and its value is never read", () => {
    const cluster = `server: https://api.example:6443\n      certificate-authority: /etc/${MARKER}\n      proxy-url: http://${MARKER}`;
    const user = [
      `token: ${MARKER}`,
      `client-certificate: /home/${MARKER}`,
      `client-key: /home/${MARKER}`,
      `tokenFile: /var/${MARKER}`,
      `token-file: /var/${MARKER}`,
      `username: ${MARKER}`,
      `password: ${MARKER}`,
      `as: ${MARKER}`,
      `as-uid: ${MARKER}`,
      "as-groups: [admins]",
      "as-user-extra: {}",
    ].join("\n      ");
    const context = only(kubeconfig({ cluster, user }));
    expect(context.notices).toEqual([
      notImportedNotice([
        "certificate-authority",
        "proxy-url",
        "client-certificate",
        "client-key",
        "tokenFile",
        "token-file",
        "username",
        "password",
        "as",
        "as-uid",
        "as-groups",
        "as-user-extra",
      ]),
    ]);
    expect(context.notices.join(" ")).not.toContain(MARKER);
  });
});

describe("a context that cannot be imported is refused by its place, never by a value", () => {
  const place = (sentence: string) => `Context 1 was not imported: ${sentence}`;

  test.each([
    ["no server", "insecure-skip-tls-verify: false", C.noServer],
    ["a server that is not text", "server: 6443", notTextRefusal("server")],
    ["a server with no scheme", `server: ${MARKER}.example:6443`, C.scheme],
    ["an ftp server", `server: ftp://${MARKER}.example`, C.scheme],
    ["userinfo", `server: https://${MARKER}:x@api.example:6443`, C.userinfo],
    ["userinfo without a name", `server: https://:${MARKER}@api.example:6443`, C.userinfo],
    ["a query", `server: https://api.example:6443/?${MARKER}=1`, C.queryOrFragment],
    ["a fragment", `server: https://api.example:6443/#${MARKER}`, C.queryOrFragment],
    ["an invalid host", "server: https://api exa mple:6443", C.host],
    ["an empty host", "server: https://:6443", C.host],
    ["a port out of range", "server: https://api.example:99999", C.host],
    ["a backslash in the authority", "server: 'https://evil.example\\@good.example/'", C.host],
    ["a control character in the authority", 'server: "https://api.example\\t:6443"', C.host],
    ["a percent-encoded dot-dot segment", "server: https://api.example/k8s/%2e%2e/x", C.serverPath],
    ["a percent sign in the path", "server: https://api.example/k8s/c%2D1", C.serverPath],
    ["a dot-dot segment", "server: https://api.example/a/../api", C.serverPath],
    ["a dot segment", "server: https://api.example/k8s/./c-1", C.serverPath],
    ["an empty segment", "server: https://api.example//k8s", C.serverPath],
    ["a backslash in the path", "server: 'https://api.example/k8s\\c-1'", C.serverPath],
    ["whitespace in the path", "server: 'https://api.example/k8s c-1'", C.serverPath],
    [
      "insecure-skip-tls-verify as text",
      "server: https://api.example\n      insecure-skip-tls-verify: 'yes'",
      C.insecureFlag,
    ],
    [
      "insecure-skip-tls-verify as a number",
      "server: https://api.example\n      insecure-skip-tls-verify: 1",
      C.insecureFlag,
    ],
    [
      "tls-server-name not text",
      "server: https://api.example\n      tls-server-name: [a]",
      notTextRefusal("tls-server-name"),
    ],
    [
      "certificate-authority-data not base64",
      `server: https://api.example\n      certificate-authority-data: ${MARKER}!`,
      notPemRefusal("certificate-authority-data"),
    ],
    [
      "certificate-authority-data not PEM",
      `server: https://api.example\n      certificate-authority-data: ${b64(MARKER)}`,
      notPemRefusal("certificate-authority-data"),
    ],
    [
      "certificate-authority-data not UTF-8",
      `server: https://api.example\n      certificate-authority-data: ${Buffer.from([0xff, 0xfe, 0xfd]).toString("base64")}`,
      notPemRefusal("certificate-authority-data"),
    ],
    [
      "certificate-authority-data empty",
      'server: https://api.example\n      certificate-authority-data: ""',
      notPemRefusal("certificate-authority-data"),
    ],
    [
      "certificate-authority-data not text",
      "server: https://api.example\n      certificate-authority-data: 12",
      notTextRefusal("certificate-authority-data"),
    ],
  ])("the cluster: %s", (_name, cluster, sentence) => {
    expect(refusedContext(kubeconfig({ cluster }))).toEqual([place(sentence)]);
  });

  test.each([
    ["a token that is not text", "token: 42", notTextRefusal("token")],
    ["a certificate without its key", `client-certificate-data: ${b64(CERT_PEM)}`, C.clientPair],
    ["a key without its certificate", `client-key-data: ${b64(KEY_PEM)}`, C.clientPair],
    [
      "a certificate that is not base64",
      `client-certificate-data: "${MARKER}"`,
      notPemRefusal("client-certificate-data"),
    ],
    [
      "a key that is not base64",
      `client-certificate-data: ${b64(CERT_PEM)}\n      client-key-data: "${MARKER}"`,
      notPemRefusal("client-key-data"),
    ],
  ])("the user: %s", (_name, user, sentence) => {
    expect(refusedContext(kubeconfig({ user }))).toEqual([place(sentence)]);
  });

  test.each([
    [
      "a namespace that is not a DNS-1123 label",
      `cluster: probe\n      namespace: ${MARKER.toUpperCase()}`,
      C.namespace,
    ],
    ["a namespace that is not text", "cluster: probe\n      namespace: [a]", notTextRefusal("namespace")],
    ["a cluster name that is not text", "cluster: [probe]", notTextRefusal("cluster")],
    ["a cluster the file does not list", `cluster: ${MARKER}`, C.clusterMissing],
    ["a user the file does not list", `cluster: probe\n      user: ${MARKER}`, C.userMissing],
    ["a user name that is not text", "cluster: probe\n      user: 7", notTextRefusal("user")],
  ])("the context: %s", (_name, context, sentence) => {
    expect(refusedContext(kubeconfig({ context }))).toEqual([place(sentence)]);
  });

  test("a cluster or a user listed twice refuses the contexts that name it", () => {
    const twice = (list: "clusters" | "users", body: string) =>
      kubeconfig().replace(
        `${list}:\n`,
        `${list}:\n  - name: ${list === "clusters" ? "probe" : "reader"}\n    ${body}\n`,
      );
    expect(refusedContext(twice("clusters", "cluster: {server: https://other.example}"))).toEqual([
      place(C.clusterRepeated),
    ]);
    expect(refusedContext(twice("users", "user: {token: other}"))).toEqual([place(C.userRepeated)]);
  });

  test("a context entry that is not a mapping, or has no name or no context body, is refused", () => {
    const text = `current-context: probe
clusters: [{name: probe, cluster: {server: "https://api.example:6443"}}]
contexts:
  - just-a-string
  - {context: {cluster: probe}}
  - {name: "", context: {cluster: probe}}
  - {name: body-is-text, context: probe}
  - {name: probe, context: {cluster: probe}}
`;
    expect(importKubeconfig(text)).toEqual({
      contexts: [
        { name: "probe", fields: { host: "api.example", port: "6443" }, ssl: { mode: "verify-system" }, notices: [] },
      ],
      refusals: [
        `Context 1 was not imported: ${C.shape}`,
        `Context 2 was not imported: ${C.name}`,
        `Context 3 was not imported: ${C.name}`,
        `Context 4 was not imported: ${C.shape}`,
      ],
    });
  });

  test("list entries that are not named mappings are skipped when clusters and users are read", () => {
    const text = `current-context: probe
clusters: [plain, {name: 7, cluster: {}}, {name: probe, cluster: {server: "https://api.example"}}]
users: [plain, {name: reader, user: text}]
contexts: [{name: probe, context: {cluster: probe}}]
`;
    expect(only(text).fields).toEqual({ host: "api.example", port: "443" });
  });
});

describe("the list of contexts", () => {
  const two = (
    current: string | null,
  ) => `${current === null ? "" : `current-context: ${current}\n`}clusters: [{name: c, cluster: {server: "https://api.example"}}]
contexts:
  - {name: first, context: {cluster: c}}
  - {name: second, context: {cluster: c}}
`;

  test("the current context comes first, then the others in the file's order", () => {
    expect(importKubeconfig(two("second")).contexts.map((context) => context.name)).toEqual(["second", "first"]);
    expect(importKubeconfig(two("second")).refusals).toEqual([]);
  });

  test("a missing current-context is said, and every context is offered", () => {
    const result = importKubeconfig(two(null));
    expect(result.contexts.map((context) => context.name)).toEqual(["first", "second"]);
    expect(result.refusals).toEqual([S.noCurrentContext]);
  });

  test("a current-context that names no listed context is said", () => {
    expect(importKubeconfig(two(MARKER)).refusals).toEqual([S.unknownCurrentContext]);
  });

  test("contexts that share a name are refused together, by place, and the rest are offered", () => {
    const text = `current-context: probe
clusters: [{name: c, cluster: {server: "https://api.example"}}]
contexts:
  - {name: ${MARKER}, context: {cluster: c}}
  - {name: probe, context: {cluster: c}}
  - {name: ${MARKER}, context: {cluster: c}}
  - {name: ${MARKER}, context: {cluster: c}}
`;
    const result = importKubeconfig(text);
    expect(result.contexts.map((context) => context.name)).toEqual(["probe"]);
    expect(result.refusals).toEqual([
      "Contexts 1, 3 and 4 share one name, so none of them was imported: give each context its own name.",
    ]);
  });

  test.each([
    ["no contexts key", "clusters: []\n"],
    ["an empty list", "contexts: []\n"],
    ["contexts that are not a list", "contexts: {a: 1}\n"],
  ])("%s answers that there is nothing to import", (_name, text) => {
    expect(importKubeconfig(text)).toEqual({ contexts: [], refusals: [S.noContexts] });
  });
});

describe("the text as a whole", () => {
  test("a value that is not text is refused before anything is read", () => {
    expect(importKubeconfig(42 as unknown as string)).toEqual({ contexts: [], refusals: [S.notText] });
  });

  test("the paste is measured in UTF-8 bytes: 1 MiB is read, one byte more is refused before any parse", () => {
    const atCap = `#${"a".repeat(KUBERNETES_KUBECONFIG_MAX_BYTES - 1)}`;
    expect(importKubeconfig(atCap).refusals).toEqual([S.notAConfig]);
    expect(importKubeconfig(`${atCap}a`)).toEqual({ contexts: [], refusals: [S.tooLarge] });
    const twoByteChars = `#${"é".repeat(KUBERNETES_KUBECONFIG_MAX_BYTES / 2)}`;
    expect(importKubeconfig(twoByteChars)).toEqual({ contexts: [], refusals: [S.tooLarge] });
  });

  test.each([
    ["a list", "- a\n- b\n"],
    ["a scalar", "just text\n"],
    ["an empty text", ""],
  ])("a top level that is %s is not a kubeconfig", (_name, text) => {
    expect(importKubeconfig(text)).toEqual({ contexts: [], refusals: [S.notAConfig] });
  });
});

/** Each text holds the marker next to the place it fails, as a pasted token would be. */
const REFUSED_TEXTS: readonly (readonly [name: string, text: string, refusal: string])[] = [
  [
    "a duplicate key",
    kubeconfig({ user: `token: ${MARKER}\n      token: ${MARKER}-again` }),
    parseFailureSentence("DUPLICATE_KEY", 13, 7),
  ],
  ["an alias", `${kubeconfig({ user: `token: &t ${MARKER}` })}extra: *t\n`, S.alias],
  [
    "a merge key",
    `${kubeconfig()}defaults: &d {token: ${MARKER}}\nmerged:\n  <<: *d\n`.replace("*d", "{token: x}"),
    S.mergeKey,
  ],
  ["a %YAML 1.1 directive", `%YAML 1.1\n---\n${kubeconfig()}`, S.directive],
  ["a %TAG directive", `%TAG !k! tag:example.com,2026:\n---\n${kubeconfig()}`, S.tag],
  ["a %TAG directive that points !! elsewhere", `%TAG !! tag:example.com,2026:\n---\n${kubeconfig()}`, S.tag],
  ["a local tag", kubeconfig({ user: `token: !secret ${MARKER}` }), parseFailureSentence("TAG_RESOLVE_FAILED", 12, 14)],
  [
    "a verbatim tag",
    `contexts: !<tag:example.com,2026:${MARKER}> []\n`,
    parseFailureSentence("TAG_RESOLVE_FAILED", 1, 11),
  ],
  ["a tab as indentation", `contexts:\n\t- name: ${MARKER}\n`, parseFailureSentence("TAB_AS_INDENT", 2, 1)],
  ["a second document", `${kubeconfig()}---\ntoken: ${MARKER}\n`, parseFailureSentence("MULTIPLE_DOCS", 19, 1)],
  ["an unclosed flow sequence", `token: [${MARKER}\n`, parseFailureSentence("BAD_INDENT", 2, 1)],
];

describe("parser rules, and the marker token never leaves the text", () => {
  test.each(REFUSED_TEXTS)("%s fails the import with a sentence that quotes nothing", (_name, text, refusal) => {
    const result = importKubeconfig(text);
    expect(result).toEqual({ contexts: [], refusals: [refusal] });
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(consoleCalls).toEqual([]);
  });

  test("a !!binary value is not text, so the context is refused naming the field", () => {
    const result = importKubeconfig(kubeconfig({ user: `token: !!binary ${b64(MARKER)}` }));
    expect(result.refusals).toEqual([`Context 1 was not imported: ${notTextRefusal("token")}`]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  test("every refused context and every notice of the sections above leaves the marker out", () => {
    const texts = [
      kubeconfig({ cluster: `server: https://${MARKER}:x@api.example` }),
      kubeconfig({ context: `cluster: ${MARKER}` }),
      kubeconfig({ user: `token: ${MARKER}\n      exec: {command: ${MARKER}}` }),
      kubeconfig({ user: `token: ${MARKER}\n      username: ${MARKER}` }).replace("token: ", "tokenFile: "),
    ];
    for (const text of texts) {
      const result = importKubeconfig(text);
      expect(JSON.stringify(result.refusals)).not.toContain(MARKER);
      expect(JSON.stringify(result.contexts.map((context) => context.notices))).not.toContain(MARKER);
    }
    expect(consoleCalls).toEqual([]);
  });

  test("a flat mapping of 100,000 keys just under the cap is read in linear time, not stalled on the duplicate check", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `k${i}: 1`).join("\n");
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(KUBERNETES_KUBECONFIG_MAX_BYTES);
    const started = performance.now();
    expect(importKubeconfig(text)).toEqual({ contexts: [], refusals: [S.noContexts] });
    // The quadratic check took 54.6 s; the bound leaves room for a loaded runner under coverage, about 0.5 s alone.
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  test("a paste nested deeper than the cap is refused before the parser reads it, and never throws", () => {
    const deep = (depth: number) => `${"- ".repeat(depth)}x\n`;
    const refused = { contexts: [], refusals: [S.tooDeep] };
    for (const items of [1, 5]) {
      const started = performance.now();
      expect(() => importKubeconfig(`contexts:\n${deep(6_000).repeat(items)}`)).not.toThrow();
      expect(importKubeconfig(`contexts:\n${deep(6_000).repeat(items)}`)).toEqual(refused);
      // The parser itself overflowed its stack on these under coverage; the scan is one pass over the text.
      expect(performance.now() - started).toBeLessThan(3_000);
    }
    expect(importKubeconfig(`contexts:\n${deep(KUBERNETES_KUBECONFIG_MAX_DEPTH + 1)}`)).toEqual(refused);
    expect(importKubeconfig(`${" ".repeat(KUBERNETES_KUBECONFIG_MAX_DEPTH + 1)}x: 1\na: 1\n`)).toEqual(refused);
    expect(importKubeconfig(`${"[".repeat(KUBERNETES_KUBECONFIG_MAX_DEPTH + 1)}\n`)).toEqual(refused);
    expect(importKubeconfig(`a:\n  - [${"{a: [".repeat(50)}\n`)).toEqual(refused);
  });

  test("a paste nested to the cap is read, and a comment line adds no depth", () => {
    const depth = KUBERNETES_KUBECONFIG_MAX_DEPTH;
    expect(importKubeconfig(`contexts:\n${"- ".repeat(depth)}x\n`)).toEqual({
      contexts: [],
      refusals: [`Context 1 was not imported: ${C.shape}`, S.noCurrentContext],
    });
    expect(importKubeconfig(`${"[".repeat(depth)}${"]".repeat(depth)}\n`)).toEqual({
      contexts: [],
      refusals: [S.notAConfig],
    });
    const commented = `${kubeconfig()}${`#${" ".repeat(depth)}[[[[\n`.repeat(30)}`;
    expect(importKubeconfig(commented).contexts).toHaveLength(1);
  });

  test("a 1 MiB paste of nests just under the cap is checked in time linear in its nodes", () => {
    const nest = `${"- ".repeat(KUBERNETES_KUBECONFIG_MAX_DEPTH - 1)}x\n`;
    const items = Math.floor((KUBERNETES_KUBECONFIG_MAX_BYTES - 10) / nest.length);
    const started = performance.now();
    const result = importKubeconfig(`contexts:\n${nest.repeat(items)}`);
    expect(result.contexts).toEqual([]);
    expect(result.refusals).toHaveLength(items + 1);
    // A walk in the square of the depth took about 7.7 s for one 6,000-deep nest; this one is about a second alone.
    expect(performance.now() - started).toBeLessThan(15_000);
  });

  test("a duplicate key is told as the parser tells it: 1 and '1' are two keys, so are two NaN, a repeated null is one", () => {
    expect(importKubeconfig(`${kubeconfig()}x:\n  1: a\n  "1": b\n`).contexts).toHaveLength(1);
    expect(importKubeconfig(`${kubeconfig()}x:\n  .nan: a\n  .NaN: b\n`).contexts).toHaveLength(1);
    expect(importKubeconfig(`${kubeconfig()}x:\n  ~: a\n  null: b\n`)).toEqual({
      contexts: [],
      refusals: [parseFailureSentence("DUPLICATE_KEY", 21, 3)],
    });
  });

  test("never throws, whatever the text", () => {
    const hostile = [
      "[".repeat(100_000),
      "{".repeat(50_000),
      "a: b: c: d",
      "? [a]\n: b\n",
      "*undefined\n",
      "&a [*a]\n",
      "contexts: [{name: x, context: {cluster: x}}]\nclusters: [{name: x, cluster: {server: 'https://\u0000'}}]\n",
      `${String.fromCharCode(0xfeff)}contexts: []\n`,
      "%YAML 9.9\n---\n{}\n",
      "!<tag:example.com,2026:x> {}\n",
    ];
    for (const text of hostile) expect(() => importKubeconfig(text)).not.toThrow();
    expect(consoleCalls).toEqual([]);
  });
});

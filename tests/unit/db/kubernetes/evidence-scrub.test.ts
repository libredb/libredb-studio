import { describe, expect, test } from "bun:test";
import {
  KUBERNETES_EVIDENCE_LEAK_SENTENCE,
  type KubernetesExchange,
  KubernetesEvidenceLeakError,
  KubernetesEvidenceScrubber,
  redactForTerminal,
} from "../../../helpers/kubernetes-evidence-scrub";

/**
 * The scrub every Kubernetes capture passes before it is written: identifiers become placeholders of the same shape,
 * a Secret outside the planted namespaces loses its values, the planted markers survive, and a capture that still
 * holds a credential is refused whole. Every input here is synthesized.
 */

// Built at run time, so the secret scan meets no JWT-shaped literal in this file.
const TOKEN = ["eyJhbGciOiJSUzI1NiJ9", "eyJzdWIiOiJzeXN0ZW06c2VydmljZWFjY291bnQifQ", "c2lnbmF0dXJlLXRva2Vu"].join(".");
const CA =
  "-----BEGIN CERTIFICATE-----\nMIIBdzCCAR2gAwIBAgIBADAKBggqhkjOPQQDAjAjMSEwHwYDVQQDDBhrM3Mtc2VydmVy\n-----END CERTIFICATE-----\n";
/** A PEM block, its header built at run time so the secret scan meets no key-shaped literal in this file. */
const pem = (label: string, body: string) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const KEY = pem("EC PRIVATE KEY", "notarealkeybodynotarealkeybody");
const MARKER_VALUE = "k8s-marker-secret-value-3d9a";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function scrubber() {
  return new KubernetesEvidenceScrubber({ tokens: [TOKEN], pems: [CA, KEY], plantedNamespaces: ["shop"] });
}

function exchange(
  path: string,
  body: unknown,
  request: Partial<KubernetesExchange["request"]> = {},
): KubernetesExchange {
  return {
    request: { method: "GET", path, accept: "application/json", ...request },
    response: {
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

const parsedText = (scrubbed: KubernetesExchange): unknown => JSON.parse(scrubbed.response.text);

describe("identifiers become placeholders of the same shape", () => {
  test("a UID is the same placeholder in the answer and in a later request's field selector", () => {
    const uid = "3f2a9c1e-7b4d-4e8a-9c2b-1d0e5f6a7b8c";
    const s = scrubber();
    const answer = s.exchange(exchange("/apis/apps/v1/namespaces/shop/deployments/web", { metadata: { uid } }));
    expect(parsedText(answer)).toEqual({ metadata: { uid: "00000000-0000-4000-8000-000000000001" } });
    const selector = `involvedObject.uid=${uid},involvedObject.name=web`;
    const later = s.exchange(
      exchange(`/api/v1/namespaces/shop/events?fieldSelector=${encodeURIComponent(selector)}&limit=500`, { items: [] }),
    );
    expect(later.request.path).toBe(
      `/api/v1/namespaces/shop/events?fieldSelector=${encodeURIComponent("involvedObject.uid=00000000-0000-4000-8000-000000000001,involvedObject.name=web").replaceAll("%20", "+")}&limit=500`,
    );
  });

  test("addresses become documentation addresses, loopback stays, the same address the same placeholder", () => {
    const answer = scrubber().exchange(
      exchange("/api/v1/nodes", {
        items: [
          { status: { addresses: [{ address: "172.18.0.2" }, { address: "fd00::12" }, { address: "172.18.0.2" }] } },
        ],
        server: "https://127.0.0.1:6443",
      }),
    );
    expect(parsedText(answer)).toEqual({
      items: [
        { status: { addresses: [{ address: "192.0.2.1" }, { address: "2001:db8::1" }, { address: "192.0.2.1" }] } },
      ],
      server: "https://127.0.0.1:6443",
    });
  });

  test("a 32-digit machine id, a JWT and the run's token are replaced", () => {
    const answer = scrubber().exchange(
      exchange("/apis/authentication.k8s.io/v1/selfsubjectreviews", {
        status: {
          userInfo: { extra: { jti: [TOKEN] }, machine: "0123456789abcdef0123456789abcdef", other: "eyJa.eyJb.c" },
        },
      }),
    );
    expect(parsedText(answer)).toEqual({
      status: {
        userInfo: { extra: { jti: ["<token>"] }, machine: "00000000000000000000000000000001", other: "<jwt>" },
      },
    });
  });

  test("a PEM block and base64 of one become a placeholder of the same label and form", () => {
    const answer = scrubber().exchange(
      exchange("/api/v1/namespaces/kube-system/configmaps", {
        items: [{ data: { "ca.crt": CA }, binaryData: { pem: b64(CA) } }],
      }),
    );
    const placeholder = "-----BEGIN CERTIFICATE-----\nPLACEHOLDER\n-----END CERTIFICATE-----\n";
    expect(parsedText(answer)).toEqual({
      items: [{ data: { "ca.crt": placeholder }, binaryData: { pem: b64(placeholder) } }],
    });
  });

  test("the path's segments are scrubbed as the answers are, so a replayed request finds its answer", () => {
    const uid = "3f2a9c1e-7b4d-4e8a-9c2b-1d0e5f6a7b8c";
    expect(scrubber().exchange(exchange(`/api/v1/namespaces/shop/pods/${uid}`, {})).request.path).toBe(
      "/api/v1/namespaces/shop/pods/00000000-0000-4000-8000-000000000001",
    );
  });

  test("the request body is scrubbed and the Accept header kept; nothing else of the request is recorded", () => {
    const answer = scrubber().exchange(
      exchange(
        "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
        { status: { allowed: true } },
        {
          method: "POST",
          body: JSON.stringify({ spec: { resourceAttributes: { namespace: "shop", name: "172.18.0.9" } } }),
        },
      ),
    );
    expect(answer.request).toEqual({
      method: "POST",
      path: "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      accept: "application/json",
      body: JSON.stringify({ spec: { resourceAttributes: { namespace: "shop", name: "192.0.2.1" } } }),
    });
  });
});

describe("Secrets", () => {
  const planted = {
    kind: "Secret",
    metadata: {
      name: "k8s-marker-secret-name",
      namespace: "shop",
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": `{"stringData":{"password":"${MARKER_VALUE}"}}`,
      },
    },
    data: { password: b64(MARKER_VALUE) },
  };
  const own = {
    kind: "Secret",
    metadata: {
      name: "k3s-serving",
      namespace: "kube-system",
      annotations: { "kubectl.kubernetes.io/last-applied-configuration": "{}", keep: "yes" },
    },
    data: { "tls.crt": b64(CA), "tls.key": b64("not a pem but a value") },
    stringData: { extra: "value" },
  };

  test("the planted Secret keeps its marker values and its last-applied annotation", () => {
    expect(parsedText(scrubber().exchange(exchange("/api/v1/namespaces/shop/secrets/x", planted)))).toEqual(planted);
  });

  test("a Secret elsewhere keeps its keys, loses its values, its stringData and its last-applied annotation", () => {
    const scrubbed = parsedText(scrubber().exchange(exchange("/api/v1/secrets", { items: [own, planted] })));
    expect(scrubbed).toEqual({
      items: [
        {
          kind: "Secret",
          metadata: { name: "k3s-serving", namespace: "kube-system", annotations: { keep: "yes" } },
          data: { "tls.crt": b64("<scrubbed>"), "tls.key": b64("<scrubbed>") },
        },
        planted,
      ],
    });
  });

  test("a Table row of a secrets list is a Secret by the request, so its last-applied annotation goes", () => {
    const table = {
      kind: "Table",
      apiVersion: "meta.k8s.io/v1",
      metadata: { resourceVersion: "42" },
      rows: [
        {
          cells: ["db", "Opaque", 1, "1d"],
          object: {
            kind: "PartialObjectMetadata",
            apiVersion: "meta.k8s.io/v1",
            metadata: {
              name: "db",
              namespace: "prod",
              annotations: {
                "kubectl.kubernetes.io/last-applied-configuration": `{"stringData":{"password":"${MARKER_VALUE}"}}`,
                keep: "yes",
              },
            },
          },
        },
      ],
    };
    const scrubbed = scrubber().exchange(exchange("/api/v1/secrets?includeObject=Metadata&limit=500", table));
    expect(scrubbed.response.text).not.toContain(MARKER_VALUE);
    expect(parsedText(scrubbed)).toMatchObject({
      rows: [{ object: { kind: "PartialObjectMetadata", metadata: { name: "db", annotations: { keep: "yes" } } } }],
    });
  });

  test("a typed list's items carry no kind, and are Secrets because the request asked for Secrets", () => {
    const item = { metadata: { name: "x", namespace: "kube-system" }, data: { token: b64("value") } };
    expect(parsedText(scrubber().exchange(exchange("/api/v1/secrets?limit=500", { items: [item] })))).toEqual({
      items: [{ metadata: { name: "x", namespace: "kube-system" }, data: { token: b64("<scrubbed>") } }],
    });
    expect(parsedText(scrubber().exchange(exchange("/api/v1/configmaps", { items: [item] })))).toEqual({
      items: [item],
    });
  });

  test("a watch answer is read line by line, and a Secret in an event is emptied", () => {
    const lines = [
      JSON.stringify({ type: "ADDED", object: own }),
      JSON.stringify({ type: "BOOKMARK", object: { metadata: { resourceVersion: "12" } } }),
      "",
    ].join("\n");
    const text = scrubber().exchange(exchange("/api/v1/secrets?watch=true", lines)).response.text;
    const [first, second, last] = text.split("\n");
    expect(JSON.parse(first).object.data).toEqual({ "tls.crt": b64("<scrubbed>"), "tls.key": b64("<scrubbed>") });
    expect(JSON.parse(second)).toEqual({ type: "BOOKMARK", object: { metadata: { resourceVersion: "12" } } });
    expect(last).toBe("");
  });

  test("a Node loses its k3s.io/node- annotations", () => {
    const node = {
      kind: "Node",
      metadata: { annotations: { "k3s.io/node-args": "[]", "k3s.io/node-env": "{}", keep: "1" } },
    };
    expect(parsedText(scrubber().exchange(exchange("/api/v1/nodes/n", node)))).toEqual({
      kind: "Node",
      metadata: { annotations: { keep: "1" } },
    });
  });
});

describe("plain text answers", () => {
  test("a log answer is scrubbed as text", () => {
    const log = "2026-10-10T12:00:00.000000000Z connected to 10.42.0.7\n2026-10-10T12:00:01.000000000Z done\n";
    const scrubbed = scrubber().exchange(exchange("/api/v1/namespaces/shop/pods/p/log?tailLines=500", log));
    expect(scrubbed.response.text).toBe(
      "2026-10-10T12:00:00.000000000Z connected to 192.0.2.1\n2026-10-10T12:00:01.000000000Z done\n",
    );
  });
});

describe("base64 of a private key inside a longer string", () => {
  // Not a key the run was given, so only the private-key rule can tell it.
  const OTHER_KEY = pem("PRIVATE KEY", "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnotarealkeybodyatall");
  const BODY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgnotarealkeybodyatall";

  test.each([
    [
      "a ConfigMap value",
      "/api/v1/namespaces/kube-system/configmaps/values",
      { data: { values: `tls:\n  key: ${b64(OTHER_KEY)}\n` } },
    ],
    ["an env value", "/api/v1/namespaces/kube-system/pods/p", { spec: { env: [{ value: `KEY=${b64(OTHER_KEY)}` }] } }],
    ["a log line", "/api/v1/namespaces/kube-system/pods/p/log?tailLines=5", `loaded ${b64(OTHER_KEY)} from disk\n`],
    [
      "a run that starts mid-word",
      "/api/v1/namespaces/kube-system/pods/p/log?tailLines=5",
      `key:abc${b64(OTHER_KEY)}\n`,
    ],
  ])("%s is rewritten to the placeholder block, and the set renders", (_name, path, body) => {
    const s = scrubber();
    const scrubbed = s.exchange(exchange(path, body));
    const rendered = s.render({ "a.json": [scrubbed] })["a.json"];
    expect(rendered).not.toContain(b64(OTHER_KEY).slice(0, 40));
    expect(rendered).toContain(b64("-----BEGIN PRIVATE KEY-----\nPLACEHOLDER\n-----END PRIVATE KEY-----").slice(0, 40));
    expect(Buffer.from(rendered, "utf8").toString()).not.toContain(BODY);
  });

  test("render refuses one the scrub did not see", () => {
    expect(() => scrubber().render({ "a.json": { env: `KEY=${b64(OTHER_KEY)}` } })).toThrow(
      KubernetesEvidenceLeakError,
    );
    expect(() => scrubber().render({ "a.json": { log: `loaded x${b64(OTHER_KEY)} from disk` } })).toThrow(
      KubernetesEvidenceLeakError,
    );
  });
});

describe("render refuses a capture that still holds a credential", () => {
  test("a clean set renders as indented JSON with a final newline", () => {
    expect(scrubber().render({ "a.json": { a: 1 } })).toEqual({ "a.json": '{\n  "a": 1\n}\n' });
  });

  test("documentation and loopback IPv6 addresses render, and a leading :: address is scrubbed like any other", () => {
    expect(() =>
      scrubber().render({ "a.json": { a: "2001:db8::1f", b: "::1", c: "::", d: "std::vector" } }),
    ).not.toThrow();
    const s = scrubber();
    const scrubbed = s.exchange(exchange("/api/v1/nodes", { address: "::a:5" }));
    expect(parsedText(scrubbed)).toEqual({ address: "2001:db8::1" });
  });

  test.each([
    ["the token", { t: TOKEN }, "a token"],
    ["the token in base64", { t: b64(TOKEN) }, "a token"],
    ["the CA body", { t: CA.replaceAll("\n", "") }, "a certificate or key the run was given"],
    ["the key in base64", { t: b64(KEY) }, "a certificate or key the run was given"],
    ["another private key", { t: pem("RSA PRIVATE KEY", "MIIEow") }, "a private key"],
    ["a JWT", { t: "eyJhbGciOi.eyJzdWIi.abc" }, "a JWT"],
    ["an address", { t: "10.43.0.1" }, "an IPv4 address"],
    ["an address inside a JSON text", { text: JSON.stringify({ ip: "10.43.0.1" }) }, "an IPv4 address"],
    ["an IPv6 address", { f: { a: "fd00:10:42::5", b: "node at 2a01:4f8:1c1c:abcd::1" } }, "an IPv6 address"],
    ["an IPv6 address in base64", { t: b64("server https://[fd00:10:42::9]:6443") }, "an IPv6 address"],
    ["an IPv6 address that starts with ::", { t: "peer ::a:5 up" }, "an IPv6 address"],
  ])("%s", (_name, value, label) => {
    try {
      scrubber().render({ "leak.json": value });
      throw new Error("render did not refuse");
    } catch (error) {
      expect(error).toBeInstanceOf(KubernetesEvidenceLeakError);
      expect((error as KubernetesEvidenceLeakError).message).toBe(KUBERNETES_EVIDENCE_LEAK_SENTENCE);
      expect((error as KubernetesEvidenceLeakError).findings).toContain(`leak.json holds ${label}`);
      expect(JSON.stringify((error as KubernetesEvidenceLeakError).findings)).not.toContain(TOKEN);
    }
  });

  test("an exchange the scrub wrote renders clean, the planted marker included", () => {
    const s = scrubber();
    const scrubbed = s.exchange(
      exchange("/api/v1/secrets", {
        items: [
          { kind: "Secret", metadata: { namespace: "kube-system" }, data: { key: b64(KEY), token: b64(TOKEN) } },
          { kind: "Secret", metadata: { namespace: "shop" }, data: { password: b64(MARKER_VALUE) } },
        ],
        token: TOKEN,
        node: "172.18.0.2",
      }),
    );
    const rendered = s.render({ "reader.json": [scrubbed] })["reader.json"];
    expect(rendered).toContain(b64(MARKER_VALUE));
  });
});

describe("redactForTerminal", () => {
  test("replaces the run's tokens and PEM texts", () => {
    expect(redactForTerminal(`failed with ${TOKEN} and ${CA}`, { tokens: [TOKEN, ""], pems: [CA, ""] })).toBe(
      "failed with <token> and <pem>",
    );
  });
});

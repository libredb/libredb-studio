import { afterEach, describe, expect, test } from "bun:test";
import { DatabaseConfigError } from "@/lib/db/errors";
import {
  apiPathRefusal,
  KUBERNETES_ALLOW_INSECURE_TLS,
  KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT,
  KUBERNETES_CONNECTION_SENTENCES as S,
  parseNamespaceList,
  readClusterEndpoint,
} from "@/lib/db/providers/platform/kubernetes/connection-options";
import { TUNNEL_FAR_END, type DatabaseConnection, type WithTunnelFarEnd } from "@/lib/types";
import { kubernetesConnection, TEST_TOKEN } from "../../../helpers/kubernetes-connection";

const CONTEXT = { queryTimeout: 30_000, appVersion: "0.18.2" };

function refusal(connection: DatabaseConnection & WithTunnelFarEnd): DatabaseConfigError {
  try {
    readClusterEndpoint(connection, CONTEXT);
  } catch (error) {
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect((error as DatabaseConfigError).message).not.toContain(TEST_TOKEN);
    return error as DatabaseConfigError;
  }
  throw new Error("expected a refusal, and the connection was accepted");
}

afterEach(() => {
  delete process.env[KUBERNETES_ALLOW_INSECURE_TLS];
  delete process.env[KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT];
});

describe("an accepted connection", () => {
  test("carries the origin, the bearer header, the user-agent, the default namespace and no path prefix", () => {
    const endpoint = readClusterEndpoint(kubernetesConnection(), CONTEXT);
    expect(endpoint.origin).toEqual({ scheme: "https", host: "api.example", port: 6443 });
    expect(endpoint.endpoint).toEqual({ host: "api.example", port: 6443 });
    expect(endpoint.headers).toEqual({
      authorization: `Bearer ${TEST_TOKEN}`,
      "user-agent": "libredb-studio/0.18.2 (kubernetes)",
    });
    expect(endpoint.apiPath).toBe("");
    expect(endpoint.defaultNamespace).toBe("default");
    expect(endpoint.namespaces).toBeUndefined();
    expect(endpoint.tls?.identity).toBe("api.example");
    expect(endpoint.tls?.rejectUnauthorized).toBe(true);
    expect(endpoint.maxSockets).toBe(4);
    expect(endpoint.callTimeoutMs).toBe(30_000);
    expect(endpoint.secretForms).toContain(TEST_TOKEN);
  });

  test("no token sends no authorization header; no version writes none", () => {
    const endpoint = readClusterEndpoint(kubernetesConnection({ password: "" }), {
      queryTimeout: 1000,
      appVersion: null,
    });
    expect(endpoint.headers).toEqual({ "user-agent": "libredb-studio (kubernetes)" });
    expect(endpoint.secretForms).toEqual([]);
  });

  test("an absent port is 6443", () => {
    expect(readClusterEndpoint(kubernetesConnection({ port: undefined }), CONTEXT).origin.port).toBe(6443);
  });

  test("the API path keeps its segments and loses one trailing slash", () => {
    expect(readClusterEndpoint(kubernetesConnection({ apiPath: "/k8s/clusters/c-1/" }), CONTEXT).apiPath).toBe(
      "/k8s/clusters/c-1",
    );
  });

  test("the TLS server name is the certificate identity", () => {
    const endpoint = readClusterEndpoint(kubernetesConnection({ tlsServerName: "kubernetes.default.svc" }), CONTEXT);
    expect(endpoint.tls?.identity).toBe("kubernetes.default.svc");
    expect(endpoint.origin.host).toBe("api.example");
  });

  test("under an SSH tunnel the far end is the endpoint and the identity, the local forward is dialled", () => {
    const tunnelled = {
      ...kubernetesConnection({
        host: "127.0.0.1",
        port: 40123,
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
      }),
      [TUNNEL_FAR_END]: { host: "10.0.0.5", port: 6443 },
    };
    const endpoint = readClusterEndpoint(tunnelled, CONTEXT);
    expect(endpoint.origin).toEqual({ scheme: "https", host: "127.0.0.1", port: 40123 });
    expect(endpoint.endpoint).toEqual({ host: "10.0.0.5", port: 6443 });
    expect(endpoint.tls?.identity).toBe("10.0.0.5");
  });

  test("the Default namespace and the Namespaces list are read, the default inside the list", () => {
    const endpoint = readClusterEndpoint(
      kubernetesConnection({ database: "shop", namespaces: "shop, web  ops" }),
      CONTEXT,
    );
    expect(endpoint.defaultNamespace).toBe("shop");
    expect(endpoint.namespaces).toEqual(["shop", "web", "ops"]);
  });

  test("a list of separators alone is no list", () => {
    expect(readClusterEndpoint(kubernetesConnection({ namespaces: " , " }), CONTEXT).namespaces).toBeUndefined();
  });
});

describe("credentials", () => {
  test("a user name is refused: basic authentication is never sent", () => {
    expect(refusal(kubernetesConnection({ user: "admin" })).message).toBe(S.userNotTaken);
  });

  test("a Bearer prefix is refused with a sentence to remove it, in any case", () => {
    expect(refusal(kubernetesConnection({ password: `Bearer ${TEST_TOKEN}` })).message).toBe(S.bearerPrefix);
    expect(refusal(kubernetesConnection({ password: `bearer ${TEST_TOKEN}` })).message).toBe(S.bearerPrefix);
  });

  test("a token with CR, LF, a space or a non-ASCII character is refused, and the sentence never carries it", () => {
    for (const token of [`${TEST_TOKEN}\r`, `${TEST_TOKEN}\n`, `${TEST_TOKEN} x`, `${TEST_TOKEN}é`]) {
      expect(refusal(kubernetesConnection({ password: token })).message).toBe(S.tokenNotVisible);
    }
  });

  test("a field of the wrong type is refused naming the field", () => {
    expect(refusal(kubernetesConnection({ password: 5 as never })).message).toBe(
      "The connection's password must be a string; nothing was sent.",
    );
    expect(refusal(kubernetesConnection({ sshTunnel: "on" as never })).message).toBe(
      "The connection's sshTunnel must be an object; nothing was sent.",
    );
    expect(refusal(kubernetesConnection({ sshTunnel: { enabled: "yes" } as never })).message).toBe(
      "The connection's sshTunnel.enabled must be true or false; nothing was sent.",
    );
  });
});

describe("the API path", () => {
  test.each([
    "k8s/clusters/c-1",
    "//",
    "//k8s",
    "/k8s//c-1",
    "/k8s/./c-1",
    "/k8s/../c-1",
    "/k8s/%2Fc",
    "/k8s/%2f",
    "/k8s/%2E%2E",
    "/k8s?x=1",
    "/k8s#frag",
    "/k8s;x",
    "/k8s/c 1",
  ])("%s is refused by shape", (apiPath) => {
    expect(apiPathRefusal(apiPath)).toBe(S.apiPathShape);
    expect(refusal(kubernetesConnection({ apiPath })).message).toBe(S.apiPathShape);
  });

  test.each(["api", "apis", "proxy", "namespaces", "nodes", "services", "pods", "openapi", "version", "API"])(
    "a segment %s is refused as reserved",
    (segment) => {
      expect(apiPathRefusal(`/k8s/${segment}/c-1`)).toBe(S.apiPathReserved);
    },
  );

  test("Rancher's prefix is accepted", () => {
    expect(apiPathRefusal("/k8s/clusters/c-m-abc12")).toBeUndefined();
  });

  test("a lone / is the empty prefix, its one trailing / removed", () => {
    expect(apiPathRefusal("/")).toBeUndefined();
    expect(readClusterEndpoint(kubernetesConnection({ apiPath: "/" }), CONTEXT).apiPath).toBe("");
  });
});

describe("names", () => {
  test("a TLS server name that is not a host name is refused", () => {
    expect(refusal(kubernetesConnection({ tlsServerName: "not a host" })).message).toBe(S.tlsServerName);
  });

  test.each(["Shop", "shop_1", "-shop", "a".repeat(64)])("a Default namespace %s is refused", (database) => {
    expect(refusal(kubernetesConnection({ database })).message).toBe(S.defaultNamespace);
  });

  test("a Namespaces entry that is not a label, and a repeat, are refused", () => {
    expect(parseNamespaceList("shop, Web")).toEqual({ refusal: S.namespacesShape });
    expect(parseNamespaceList("shop shop")).toEqual({ refusal: S.namespacesRepeat });
    expect(refusal(kubernetesConnection({ namespaces: "shop, Web" })).message).toBe(S.namespacesShape);
  });

  test("a Namespaces list of up to 1,000 entries is read; one more is refused with a sentence naming the cap", () => {
    const names = (count: number) => Array.from({ length: count }, (_unused, index) => `ns-${index}`).join(",");
    expect(parseNamespaceList(names(1_000))).toHaveLength(1_000);
    expect(parseNamespaceList(names(1_001))).toEqual({ refusal: S.namespacesTooMany });
    expect(S.namespacesTooMany).toBe(
      "Namespaces lists more than 1,000 namespaces, the most the tree shows; list fewer. Nothing was sent.",
    );
    expect(refusal(kubernetesConnection({ database: "ns-0", namespaces: names(1_001) })).message).toBe(
      S.namespacesTooMany,
    );
  });

  test("a default namespace outside a set list is refused, the empty field reading default", () => {
    expect(refusal(kubernetesConnection({ database: "ops", namespaces: "shop" })).message).toBe(S.defaultOutsideList);
    expect(refusal(kubernetesConnection({ namespaces: "shop" })).message).toBe(S.defaultOutsideList);
  });
});

describe("TLS and plain HTTP", () => {
  test("plain HTTP to a host that is not this machine is refused, with or without a token, flag or not", () => {
    process.env[KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT] = "true";
    expect(refusal(kubernetesConnection({ ssl: undefined })).message).toBe(S.plaintextRemote);
    expect(refusal(kubernetesConnection({ ssl: { mode: "disable" }, password: "" })).message).toBe(S.plaintextRemote);
  });

  test("plain HTTP to this machine needs KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT", () => {
    const proxy = kubernetesConnection({ host: "127.0.0.1", port: 8001, ssl: undefined, password: "" });
    expect(refusal(proxy).message).toBe(S.plaintextLoopbackOff);
    process.env[KUBERNETES_ALLOW_LOOPBACK_PLAINTEXT] = "1";
    const endpoint = readClusterEndpoint(proxy, CONTEXT);
    expect(endpoint.origin).toEqual({ scheme: "http", host: "127.0.0.1", port: 8001 });
    expect(endpoint.tls).toBeNull();
  });

  test("require mode and a certificate check turned off need KUBERNETES_ALLOW_INSECURE_TLS", () => {
    expect(refusal(kubernetesConnection({ ssl: { mode: "require" } })).message).toBe(S.insecureTlsOff);
    expect(refusal(kubernetesConnection({ ssl: { mode: "verify-full", rejectUnauthorized: false } })).message).toBe(
      S.insecureTlsOff,
    );
    process.env[KUBERNETES_ALLOW_INSECURE_TLS] = "on";
    expect(
      readClusterEndpoint(kubernetesConnection({ ssl: { mode: "require" } }), CONTEXT).tls?.rejectUnauthorized,
    ).toBe(false);
  });

  test("verify-system without a CA verifies against the system store", () => {
    const endpoint = readClusterEndpoint(kubernetesConnection({ ssl: { mode: "verify-system" } }), CONTEXT);
    expect(endpoint.tls?.rejectUnauthorized).toBe(true);
    expect(endpoint.tls?.ca).toBeUndefined();
  });

  test("a flag that is neither on nor off is refused naming it", () => {
    process.env[KUBERNETES_ALLOW_INSECURE_TLS] = "maybe";
    expect(refusal(kubernetesConnection({ ssl: { mode: "require" } })).message).toBe(
      "Invalid KUBERNETES_ALLOW_INSECURE_TLS: expected true or false.",
    );
  });

  test("a client certificate without its key is refused by the shared TLS rule", () => {
    expect(refusal(kubernetesConnection({ ssl: { mode: "verify-full", clientCert: "x" } })).message).toBe(
      "Invalid ssl.clientCert and ssl.clientKey: give both or neither",
    );
  });
});

describe("the tunnel and the timeout", () => {
  test("a tunnel that is on but did not open is refused", () => {
    const connection = kubernetesConnection({
      sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
    });
    expect(refusal(connection).message).toBe(S.tunnelNotOpened);
  });

  test("a link-local literal far end is refused", () => {
    const tunnelled = {
      ...kubernetesConnection({
        host: "127.0.0.1",
        sshTunnel: { enabled: true, host: "bastion", port: 22, username: "u", authMethod: "password" },
      }),
      [TUNNEL_FAR_END]: { host: "169.254.169.254", port: 6443 },
    };
    expect(refusal(tunnelled).message).toBe(S.tunnelLinkLocal);
  });

  test("a host the shared rule refuses is refused with its sentence, as this provider's", () => {
    const error = refusal(kubernetesConnection({ host: "not a host" }));
    expect(error.provider as string).toBe("kubernetes");
  });

  test("a query timeout outside 1 to 2147483647 is refused", () => {
    expect(() => readClusterEndpoint(kubernetesConnection(), { queryTimeout: 0 })).toThrow(S.queryTimeout);
  });
});

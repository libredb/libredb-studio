/**
 * The Kubernetes discovery export: the document docker/discover-kubernetes.mjs writes into its export Secret, and
 * the parser Studio reads the projected file with.
 *
 * The file is untrusted input: it is refused whole when it does not match the schema, by its size before it is
 * parsed, and a refusal names a field path and an issue code, never text the file chose, because the values are
 * database passwords. Nothing in it can set a connection's roles, managed flag, MCP opt-in or TLS mode: the schema
 * declares none of them.
 */
import { describe, expect, it } from "bun:test";
import {
  KUBERNETES_DISCOVERY_FILE_MAX_BYTES,
  KUBERNETES_DISCOVERY_SECRET_KEYS,
  parseKubernetesDiscoveryExport,
  type KubernetesDiscoveryExport,
} from "@/lib/seed/kubernetes-discovery-export";
import { CONTRACT, LIMITS } from "../../../docker/discover-kubernetes.mjs";

const NOW = "2026-10-28T08:00:00.000Z";
const PASSWORD = "not-a-real-password-orders";

function database(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "cnpg",
    resource: { metadata: { namespace: "team-a", name: "orders" } },
    secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" } },
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    platform: "kubernetes",
    generatedAt: NOW,
    checkedAt: NOW,
    status: { ok: true },
    namespaces: [{ name: "team-a", status: { ok: true } }],
    databases: [database()],
    ...overrides,
  };
}

function parse(value: unknown) {
  return parseKubernetesDiscoveryExport(JSON.stringify(value));
}

function refusal(value: unknown): string {
  const result = parse(value);
  if (result.ok) throw new Error("the export was accepted");
  return result.reason;
}

describe("parseKubernetesDiscoveryExport", () => {
  it("accepts an export of one namespace and one CloudNativePG database", () => {
    const result = parse(document());
    expect(result.ok).toBe(true);
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0]).toEqual({
      kind: "cnpg",
      resource: { metadata: { namespace: "team-a", name: "orders" } },
      secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, dbname: "orders", port: "5432" } },
    });
  });

  it.each([["api_unreachable"], ["credentials_unavailable"], ["unauthorized"], ["api_error"], ["limit_exceeded"]])(
    "accepts the exporter's status code %p",
    (code) => {
      expect(parse(document({ status: { ok: false, code, message: "m" } })).ok).toBe(true);
    },
  );

  it("accepts the exporter's statuses: a failed scan, a forbidden namespace, a missing CRD, a namespace over a bound and Secret problems", () => {
    const result = parse(
      document({
        status: { ok: false, code: "api_error", httpStatus: 500, message: "the API server answered HTTP 500" },
        namespaces: [
          { name: "team-a", status: { ok: true } },
          { name: "team-b", status: { ok: false, code: "forbidden", httpStatus: 403, message: "forbidden" } },
          { name: "team-c", status: { ok: false, code: "crd_missing", httpStatus: 404, message: "not found" } },
          { name: "team-d", status: { ok: false, code: "limit_exceeded", message: "too large to list" } },
        ],
        databases: [
          database(),
          database({ secret: { name: "orders-app", problem: "not_found" } }),
          database({ secret: { name: "orders-app", problem: "forbidden" } }),
          database({ secret: { name: "orders-app", problem: "invalid_value", key: "password" } }),
          database({ secret: { name: "orders-app", problem: "not_owned" } }),
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("keeps the contract's resource fields and drops every other field the file carries", () => {
    const result = parse(
      document({
        databases: [
          database({
            resource: {
              apiVersion: "postgresql.cnpg.io/v1",
              metadata: { namespace: "prod", name: "billing-db", labels: { team: "billing" } },
              spec: { instances: 3, bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
            },
            secret: { name: "billing-owner", data: { username: "billing_owner", password: PASSWORD } },
            roles: ["*"],
            mcp: true,
          }),
        ],
      }),
    );
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0]).toEqual({
      kind: "cnpg",
      resource: {
        metadata: { namespace: "prod", name: "billing-db" },
        spec: { bootstrap: { initdb: { database: "billing", secret: { name: "billing-owner" } } } },
      },
      secret: { name: "billing-owner", data: { username: "billing_owner", password: PASSWORD } },
    });
  });

  it("drops a Secret key the contract does not keep", () => {
    const result = parse(
      document({
        databases: [
          database({ secret: { name: "orders-app", data: { username: "orders", password: PASSWORD, uri: "x" } } }),
        ],
      }),
    );
    const value = (result as { ok: true; value: KubernetesDiscoveryExport }).value;
    expect(value.databases[0].secret).toEqual({
      name: "orders-app",
      data: { username: "orders", password: PASSWORD },
    });
  });

  it("refuses a file over the byte limit by its size, before parsing it", () => {
    const raw = " ".repeat(KUBERNETES_DISCOVERY_FILE_MAX_BYTES + 1);
    expect(KUBERNETES_DISCOVERY_FILE_MAX_BYTES).toBe(1024 * 1024);
    expect(parseKubernetesDiscoveryExport(raw)).toEqual({
      ok: false,
      reason: `the file is ${KUBERNETES_DISCOVERY_FILE_MAX_BYTES + 1} bytes, over the ${KUBERNETES_DISCOVERY_FILE_MAX_BYTES}-byte limit`,
    });
  });

  it("refuses text that is not JSON", () => {
    expect(parseKubernetesDiscoveryExport("{")).toEqual({ ok: false, reason: "the file is not valid JSON" });
  });

  it("refuses another platform's export, such as CapRover's", () => {
    expect(refusal(document({ platform: "caprover" }))).toBe(
      "the file does not match the export schema at platform (invalid_value)",
    );
  });

  it("refuses an unknown version", () => {
    expect(refusal(document({ version: 2 }))).toBe(
      "the file does not match the export schema at version (invalid_value)",
    );
  });

  it("names the first issue's path and code, counts the rest, and never quotes a value", () => {
    const reason = refusal(
      document({
        databases: [
          database({
            secret: { name: "orders-app", data: { username: "orders", password: `${PASSWORD}${"x".repeat(1024)}` } },
          }),
          database({ kind: "mysql" }),
        ],
      }),
    );
    expect(reason).toBe(
      "the file does not match the export schema at databases.0.secret.data.password (too_big) (and 1 more)",
    );
    expect(reason).not.toContain(PASSWORD);
  });

  it("names the top level when the document is not an object", () => {
    expect(refusal([])).toBe("the file does not match the export schema at the top level (invalid_type)");
  });

  it("refuses a namespace or a resource name that is not a Kubernetes name, so no host is built from one", () => {
    expect(refusal(document({ namespaces: [{ name: "Team_A", status: { ok: true } }] }))).toBe(
      "the file does not match the export schema at namespaces.0.name (invalid_format)",
    );
    expect(
      refusal(document({ databases: [database({ resource: { metadata: { namespace: "a.b", name: "orders" } } })] })),
    ).toBe("the file does not match the export schema at databases.0.resource.metadata.namespace (invalid_format)");
    expect(
      refusal(
        document({ databases: [database({ resource: { metadata: { namespace: "team-a", name: "orders/x" } } })] }),
      ),
    ).toBe("the file does not match the export schema at databases.0.resource.metadata.name (invalid_format)");
  });

  it("refuses a Secret entry with both data and a problem, or with neither", () => {
    expect(
      refusal(document({ databases: [database({ secret: { name: "orders-app", data: {}, problem: "not_found" } })] })),
    ).toBe("the file does not match the export schema at databases.0.secret (custom)");
    expect(refusal(document({ databases: [database({ secret: { name: "orders-app" } })] }))).toBe(
      "the file does not match the export schema at databases.0.secret (custom)",
    );
  });

  it("refuses more than 500 databases or 256 namespaces with one issue, before checking any element", () => {
    expect(refusal(document({ databases: Array.from({ length: 501 }, () => 0) }))).toBe(
      "the file does not match the export schema at databases (too_big)",
    );
    expect(refusal(document({ namespaces: Array.from({ length: 257 }, () => 0) }))).toBe(
      "the file does not match the export schema at namespaces (too_big)",
    );
  });

  it("refuses a status message over 512 characters", () => {
    expect(refusal(document({ status: { ok: false, code: "api_error", message: "m".repeat(513) } }))).toBe(
      "the file does not match the export schema at status.message (too_big)",
    );
  });

  /*
   * The schema repeats the exporter's bounds as literals (LIMITS in docker/discover-kubernetes.mjs): whatever the
   * exporter writes at its bound must parse here, and one past it must not.
   */
  describe("the exporter's bounds", () => {
    it("accepts as many databases and namespaces as the exporter writes, and refuses one more", () => {
      const databases = Array.from({ length: LIMITS.databases }, () => database());
      const namespaces = Array.from({ length: LIMITS.namespaces }, (_, index) => ({
        name: `n${index}`,
        status: { ok: true },
      }));
      expect(parse(document({ databases, namespaces })).ok).toBe(true);
      expect(parse(document({ databases: [...databases, database()] })).ok).toBe(false);
      expect(parse(document({ namespaces: [...namespaces, { name: "one-more", status: { ok: true } }] })).ok).toBe(
        false,
      );
    });

    it("accepts a value of the exporter's byte bound and a message of its length, and refuses longer ones", () => {
      const value = "v".repeat(LIMITS.valueBytes);
      const secret = (password: string) => ({ name: "orders-app", data: { username: "orders", password } });
      expect(parse(document({ databases: [database({ secret: secret(value) })] })).ok).toBe(true);
      expect(parse(document({ databases: [database({ secret: secret(`${value}v`) })] })).ok).toBe(false);
      const status = (message: string) => ({ ok: false, code: "api_error", message });
      expect(parse(document({ status: status("m".repeat(LIMITS.messageChars)) })).ok).toBe(true);
      expect(parse(document({ status: status("m".repeat(LIMITS.messageChars + 1)) })).ok).toBe(false);
    });

    it("reads a file of the exporter's size bound, and keeps exactly the keys its contract row keeps", () => {
      expect(LIMITS.exportBytes).toBeLessThanOrEqual(KUBERNETES_DISCOVERY_FILE_MAX_BYTES);
      expect<string[]>([...KUBERNETES_DISCOVERY_SECRET_KEYS]).toEqual([...CONTRACT[0].secretKeys]);
    });
  });

  describe("before the first successful scan", () => {
    const first = { generatedAt: null, status: { ok: false, code: "api_error", message: "no answer yet" } };

    it("accepts an error status with no namespaces and no databases", () => {
      expect(parse(document({ ...first, namespaces: [], databases: [] })).ok).toBe(true);
    });

    it("refuses databases, namespaces or an ok status", () => {
      expect(refusal(document({ ...first, namespaces: [] }))).toBe(
        "the file does not match the export schema at databases (custom)",
      );
      expect(refusal(document({ ...first, databases: [] }))).toBe(
        "the file does not match the export schema at namespaces (custom)",
      );
      expect(refusal(document({ generatedAt: null, namespaces: [], databases: [] }))).toBe(
        "the file does not match the export schema at status (custom)",
      );
    });
  });
});

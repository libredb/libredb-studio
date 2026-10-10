import { describe, expect, test } from "bun:test";
import {
  LAST_APPLIED_ANNOTATION,
  readsSecrets,
  redactResponse,
} from "@/lib/db/providers/platform/kubernetes/redaction";

const SECRETS = { group: "", resource: "secrets" };
const CONFIGMAPS = { group: "", resource: "configmaps" };
const VALUE = "c2VjcmV0LW1hcmtlcg==";
const APPLIED = JSON.stringify({ data: { password: VALUE } });

/** A Secret as the server answers it, optionally without its kind (a typed list's items carry none). */
function secret(withKind = true): Record<string, unknown> {
  return {
    ...(withKind ? { kind: "Secret", apiVersion: "v1" } : {}),
    metadata: {
      name: "db",
      namespace: "shop",
      annotations: { [LAST_APPLIED_ANNOTATION]: APPLIED, team: "shop" },
      managedFields: [{ manager: "kubectl" }],
    },
    type: "Opaque",
    data: { password: VALUE },
    stringData: { password: "secret-marker" },
  };
}

function assertClean(body: unknown): void {
  const text = JSON.stringify(body);
  expect(text).not.toContain(VALUE);
  expect(text).not.toContain("secret-marker");
  expect(text).not.toContain(LAST_APPLIED_ANNOTATION);
  expect(text).not.toContain("managedFields");
}

describe("redactResponse on a request for secrets", () => {
  test("a Secret alone loses data, stringData, the last-applied annotation and managedFields, and keeps the rest", () => {
    const body = redactResponse(SECRETS, secret());
    assertClean(body);
    expect(body).toEqual({
      kind: "Secret",
      apiVersion: "v1",
      metadata: { name: "db", namespace: "shop", annotations: { team: "shop" } },
      type: "Opaque",
    });
  });

  test("in a typed list whose items carry no kind", () => {
    assertClean(redactResponse(SECRETS, { kind: "SecretList", items: [secret(false), secret(false)] }));
  });

  test("in a Table row, and in a one-row Table for describe", () => {
    assertClean(
      redactResponse(SECRETS, {
        kind: "Table",
        rows: [
          { cells: ["db", "Opaque", 1, "5m"], object: { kind: "PartialObjectMetadata", ...secret(false) } },
          "not a row",
        ],
      }),
    );
    assertClean(redactResponse(SECRETS, { kind: "Table", rows: [{ cells: ["db"], object: secret(false) }] }));
  });

  test("in a watch event, a Table inside a watch event, and a document of an -o yaml list", () => {
    assertClean(redactResponse(SECRETS, { type: "MODIFIED", object: secret(false) }));
    assertClean(
      redactResponse(SECRETS, { type: "ADDED", object: { kind: "Table", rows: [{ object: secret(false) }] } }),
    );
    assertClean(redactResponse(SECRETS, { kind: "List", items: [secret()] }));
  });

  test("a Secret without metadata or annotations is still redacted", () => {
    expect(redactResponse<unknown>(SECRETS, { data: { a: VALUE } })).toEqual({});
    expect(redactResponse<unknown>(SECRETS, { metadata: { name: "x" }, data: { a: VALUE } })).toEqual({
      metadata: { name: "x" },
    });
  });
});

describe("redactResponse on any other request", () => {
  test("an object whose kind is Secret is redacted wherever it arrives", () => {
    assertClean(redactResponse({ group: "", resource: "events" }, { kind: "List", items: [secret()] }));
  });

  test("a ConfigMap keeps its data and loses only managedFields and nothing else", () => {
    const configMap = {
      kind: "ConfigMap",
      metadata: { name: "app", annotations: { [LAST_APPLIED_ANNOTATION]: "{}" }, managedFields: [{}] },
      data: { mode: "dark" },
    };
    expect(redactResponse<unknown>(CONFIGMAPS, configMap)).toEqual({
      kind: "ConfigMap",
      metadata: { name: "app", annotations: { [LAST_APPLIED_ANNOTATION]: "{}" } },
      data: { mode: "dark" },
    });
  });

  test("a body that is not an object passes untouched", () => {
    expect(redactResponse(SECRETS, "text")).toBe("text");
    expect(redactResponse(SECRETS, null)).toBeNull();
  });

  test("readsSecrets is the core group's secrets alone", () => {
    expect(readsSecrets(SECRETS)).toBe(true);
    expect(readsSecrets({ group: "external-secrets.io", resource: "secrets" })).toBe(false);
    expect(readsSecrets(CONFIGMAPS)).toBe(false);
  });
});

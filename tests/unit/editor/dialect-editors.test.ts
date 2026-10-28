import { describe, expect, test } from "bun:test";
import { EDITOR_LANGUAGES } from "@/lib/db/editor-language";
import { DIALECT_EDITORS } from "@/lib/editor/dialect-editors";

describe("DIALECT_EDITORS", () => {
  test("holds one record per tab type, the dialect-less ones included", () => {
    expect(Object.keys(DIALECT_EDITORS).sort()).toEqual([
      "cypher",
      "etcd",
      "firestore",
      "influxql",
      "kafka",
      "kubectl",
      "libredb",
      "milvus",
      "modbus",
      "mongodb",
      "mqtt",
      "mtconnect",
      "netconf",
      "opcua",
      "oxia",
      "promql",
      "qdrant",
      "rabbitmq",
      "redis",
      "s3",
      "snmp",
      "sparkplug",
      "sql",
      "weaviate",
    ]);
  });

  test("each tab type renders in the Monaco language it rendered in before the registry", () => {
    const monacoIds = Object.fromEntries(
      Object.entries(DIALECT_EDITORS).map(([type, editor]) => [type, editor.monacoId]),
    );
    expect(monacoIds).toEqual({
      sql: "sql",
      mongodb: "json",
      mqtt: "json",
      modbus: "json",
      opcua: "json",
      mtconnect: "mtconnect",
      netconf: "json",
      snmp: "json",
      sparkplug: "json",
      libredb: "libredb",
      redis: "redis",
      promql: "promql",
      kafka: "json",
      etcd: "etcd",
      cypher: "graph-cypher",
      milvus: "milvus",
      qdrant: "qdrant",
      weaviate: "weaviate",
      influxql: "influxql",
      oxia: "oxia",
      s3: "s3",
      kubectl: "kubectl",
      firestore: "firestore",
      rabbitmq: "json",
    });
  });

  test("every tab type renders in a language the editor language registry holds", () => {
    for (const [tabType, editor] of Object.entries(DIALECT_EDITORS)) {
      expect(Object.hasOwn(EDITOR_LANGUAGES, editor.monacoId), `the ${tabType} tab's language has no row`).toBe(true);
    }
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DIALECT_EDITORS)).toBe(true);
  });

  test("freezes every record too, so no reader can change a tab type's language at run time", () => {
    for (const [tabType, editor] of Object.entries(DIALECT_EDITORS)) {
      expect(Object.isFrozen(editor), `the ${tabType} record is mutable`).toBe(true);
    }
  });
});

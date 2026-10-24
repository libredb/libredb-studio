import assert from "node:assert/strict";
import type { EditorLanguage } from "@/lib/editor/tab-language";
import { vscodeLanguageOf } from "../../../src/host/editor/editor-language";

// Every member of EditorLanguage: a new member fails the typecheck until it is listed here.
const EVERY_LANGUAGE = {
  sql: true,
  json: true,
  libredb: true,
  redis: true,
  promql: true,
  etcd: true,
  "graph-cypher": true,
  milvus: true,
  qdrant: true,
  weaviate: true,
  influxql: true,
  oxia: true,
  s3: true,
  kubectl: true,
  firestore: true,
  mtconnect: true,
} satisfies Record<EditorLanguage, true>;

describe("vscodeLanguageOf", () => {
  it("maps sql to VS Code's sql", () => {
    assert.equal(vscodeLanguageOf("sql"), "sql");
  });

  it("maps json to VS Code's json", () => {
    assert.equal(vscodeLanguageOf("json"), "json");
  });

  const others = (Object.keys(EVERY_LANGUAGE) as EditorLanguage[]).filter(
    (language) => language !== "sql" && language !== "json",
  );
  for (const language of others) {
    it(`maps ${language} to plaintext`, () => {
      assert.equal(vscodeLanguageOf(language), "plaintext");
    });
  }
});

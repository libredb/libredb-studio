import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { graphPolicyProfileOf } from "@/lib/db/graph-policy-profiles";
import { CYPHER_KEYWORDS } from "@/lib/db/graph/cypher/lexer";
import { graphObjectSegment } from "@/lib/db/graph/objects";
import type { GraphPolicyProfile } from "@/lib/db/graph/profile";
import { NEO4J_POLICY_PROFILE } from "@/lib/db/providers/graph/neo4j/profile";
import {
  type CypherCompletionSchema,
  cypherCompletionContext,
  cypherCompletionSchemaOf,
  registerCypherCompletionProvider,
} from "@/lib/editor/cypher-completions";
import { CYPHER_LANGUAGE_ID } from "@/lib/editor/cypher-language";

// ---------------------------------------------------------------------------
// Mock Monaco: only the completion registration and the item kinds, local to this file.
// ---------------------------------------------------------------------------

const KIND = { Keyword: 17, Class: 5, Struct: 6, Field: 3, Function: 1, Module: 8 } as const;

interface Registered {
  readonly languageId: string;
  readonly provider: Monaco.languages.CompletionItemProvider;
  disposed: boolean;
}

function createMockMonaco() {
  const registered: Registered[] = [];
  const monaco = {
    languages: {
      CompletionItemKind: KIND,
      registerCompletionItemProvider: (languageId: string, provider: Monaco.languages.CompletionItemProvider) => {
        const entry: Registered = { languageId, provider, disposed: false };
        registered.push(entry);
        return {
          dispose: () => {
            entry.disposed = true;
          },
        };
      },
    },
  };
  return { monaco: monaco as unknown as typeof Monaco, registered };
}

/** A model holding `text` with the cursor at the `|` it contains; offsets and positions as Monaco counts them. */
function modelAt(withCursor: string): { model: Monaco.editor.ITextModel; position: Monaco.Position } {
  const cursor = withCursor.indexOf("|");
  const text = withCursor.slice(0, cursor) + withCursor.slice(cursor + 1);
  const positionAt = (offset: number) => {
    const before = text.slice(0, offset).split("\n");
    return { lineNumber: before.length, column: before[before.length - 1].length + 1 };
  };
  const model = {
    getValue: () => text,
    getPositionAt: positionAt,
    getOffsetAt: (position: { lineNumber: number; column: number }) => {
      const lines = text.split("\n");
      return (
        lines.slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1
      );
    },
  };
  return { model: model as unknown as Monaco.editor.ITextModel, position: positionAt(cursor) as Monaco.Position };
}

const SCHEMA_OBJECTS = [
  {
    name: "Person",
    path: ["neo4j", graphObjectSegment("label", "Person")],
    columns: [{ name: "name" }, { name: "born" }],
  },
  { name: "Weird Label", path: ["neo4j", graphObjectSegment("label", "Weird Label")], columns: [{ name: "x y" }] },
  {
    name: "ACTED_IN",
    path: ["neo4j", graphObjectSegment("relationship_type", "ACTED_IN")],
    columns: [{ name: "roles" }],
  },
  // A label and a relationship type of one name (SR5): each lands in its own list.
  { name: "KNOWS", path: ["neo4j", graphObjectSegment("label", "KNOWS")] },
  { name: "KNOWS", path: ["neo4j", graphObjectSegment("relationship_type", "KNOWS")], columns: [{ name: "since" }] },
  // Listed, never offered: an index, a constraint, and a path no graph kind produced.
  { name: "person_name", path: ["neo4j", graphObjectSegment("index", "person_name")], columns: [{ name: "ix" }] },
  { name: "c", path: ["neo4j", graphObjectSegment("constraint", "c")] },
  { name: "users", path: ["public", "users"], columns: [{ name: "email" }] },
  { name: "pathless", columns: [{ name: "nope" }] },
  // A name no quoting can write safely is not offered rather than offered broken.
  { name: "bad", path: ["neo4j", graphObjectSegment("label", "bad\u0001name")] },
];

function suggest(
  withCursor: string,
  schema: CypherCompletionSchema = cypherCompletionSchemaOf(SCHEMA_OBJECTS),
  // `null` for no profile, because an `undefined` argument would take the default.
  policy: GraphPolicyProfile | null = NEO4J_POLICY_PROFILE,
) {
  const { monaco, registered } = createMockMonaco();
  registerCypherCompletionProvider(monaco, schema, policy ?? undefined);
  const { model, position } = modelAt(withCursor);
  const result = registered[0]!.provider.provideCompletionItems(
    model,
    position as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.CompletionList;
  return result.suggestions;
}

const labelsOf = (items: Monaco.languages.CompletionItem[]) => items.map((item) => item.label);

describe("cypherCompletionSchemaOf", () => {
  test("reads label and relationship-type names through their kind-qualified segment, and properties from their columns", () => {
    expect(cypherCompletionSchemaOf(SCHEMA_OBJECTS)).toEqual({
      labels: ["KNOWS", "Person", "Weird Label", "bad\u0001name"],
      relationshipTypes: ["ACTED_IN", "KNOWS"],
      properties: ["born", "name", "roles", "since", "x y"],
    });
  });

  test("an empty schema completes nothing from it", () => {
    expect(cypherCompletionSchemaOf([])).toEqual({ labels: [], relationshipTypes: [], properties: [] });
  });
});

describe("cypherCompletionContext", () => {
  const forms = NEO4J_POLICY_PROFILE.readPolicy.allowedShowForms;
  const at = (text: string) => cypherCompletionContext(text, forms);

  test("after a colon inside a node pattern, labels; inside a relationship pattern, relationship types", () => {
    expect(at("MATCH (n:")).toEqual({ kind: "label", start: 9 });
    expect(at("MATCH (n:Pe")).toEqual({ kind: "label", start: 9 });
    expect(at("MATCH (n:Person:")).toEqual({ kind: "label", start: 16 });
    expect(at("MATCH (a)-[r:")).toEqual({ kind: "relationship-type", start: 13 });
    expect(at("MATCH (a)-[:ACTED_IN|KN")).toEqual({ kind: "relationship-type", start: 21 });
    // A label predicate outside any pattern is still a label.
    expect(at("MATCH (n) WHERE n:")).toEqual({ kind: "label", start: 18 });
  });

  test("a colon inside a map is a key's separator, not a label, and so is a bar outside a relationship", () => {
    expect(at("MATCH (n {name:")).toEqual({ kind: "keyword", start: 15 });
    expect(at("RETURN 1 |")).toEqual({ kind: "keyword", start: 10 });
  });

  test("after an identifier and a dot, properties; after a number and a dot, not", () => {
    expect(at("MATCH (n) RETURN n.")).toEqual({ kind: "property", start: 19 });
    expect(at("MATCH (n) RETURN n.na")).toEqual({ kind: "property", start: 19 });
    expect(at("MATCH (`a b`) RETURN `a b`.")).toEqual({ kind: "property", start: 27 });
    expect(at("RETURN 1.")).toEqual({ kind: "keyword", start: 9 });
  });

  test("after CALL, procedures, replacing the whole dotted name typed so far", () => {
    expect(at("CALL ")).toEqual({ kind: "procedure", start: 5 });
    expect(at("CALL db")).toEqual({ kind: "procedure", start: 5 });
    expect(at("CALL db.")).toEqual({ kind: "procedure", start: 5 });
    expect(at("call db.schema.vi")).toEqual({ kind: "procedure", start: 5 });
  });

  test("after SHOW, the forms whose words the text has begun; only the word being typed is replaced", () => {
    expect(at("SHOW ")).toEqual({ kind: "show", start: 5, showWords: [] });
    expect(at("SHOW IN")).toEqual({ kind: "show", start: 5, showWords: [] });
    expect(at("SHOW RANGE ")).toEqual({ kind: "show", start: 11, showWords: ["RANGE"] });
    expect(at("show range in")).toEqual({ kind: "show", start: 11, showWords: ["RANGE"] });
    // A form's words on two lines: the replaced text is still on the cursor's line.
    expect(at("SHOW NODE\nUNIQUENESS CON")).toEqual({ kind: "show", start: 21, showWords: ["NODE", "UNIQUENESS"] });
    // Words no form begins with leave the SHOW context.
    expect(at("SHOW INDEXES YIELD ")).toEqual({ kind: "keyword", start: 19 });
  });

  test("elsewhere, keywords, replacing the word being typed", () => {
    expect(at("")).toEqual({ kind: "keyword", start: 0 });
    expect(at("MATCH (n) RET")).toEqual({ kind: "keyword", start: 10 });
    expect(at("MATCH (n)\nRET")).toEqual({ kind: "keyword", start: 10 });
  });

  test("inside a string, a comment or an open backtick name, nothing", () => {
    expect(at("RETURN 'abc")).toBeUndefined();
    expect(at("RETURN 1 // note")).toBeUndefined();
    expect(at("RETURN 1 /* open")).toBeUndefined();
    expect(at("MATCH (n:`Wei")).toBeUndefined();
  });
});

describe("registerCypherCompletionProvider", () => {
  test("registers on the graph-cypher language, with the trigger characters that open a context, and disposes", () => {
    const { monaco, registered } = createMockMonaco();
    const disposable = registerCypherCompletionProvider(monaco, cypherCompletionSchemaOf([]), undefined);
    expect(registered.map((entry) => entry.languageId)).toEqual([CYPHER_LANGUAGE_ID]);
    expect(registered[0]!.provider.triggerCharacters).toEqual([":", ".", "|"]);
    disposable.dispose();
    expect(registered[0]!.disposed).toBe(true);
  });

  test("labels after a node pattern's colon, backticked where a bare name would not read back", () => {
    const items = suggest("MATCH (n:|");
    expect(labelsOf(items)).toEqual(["KNOWS", "Person", "Weird Label"]);
    expect(items.map((item) => item.insertText)).toEqual(["KNOWS", "Person", "`Weird Label`"]);
    expect(items.every((item) => item.kind === KIND.Class)).toBe(true);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, startColumn: 10, endLineNumber: 1, endColumn: 10 });
  });

  test("relationship types inside a relationship pattern, never the labels", () => {
    const items = suggest("MATCH (a)-[r:AC|]->(b)");
    expect(labelsOf(items)).toEqual(["ACTED_IN", "KNOWS"]);
    expect(items.every((item) => item.kind === KIND.Struct)).toBe(true);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, startColumn: 14, endLineNumber: 1, endColumn: 16 });
  });

  test("property names after a dot, across lines", () => {
    const items = suggest("MATCH (n:Person)\nRETURN n.|");
    expect(labelsOf(items)).toEqual(["born", "name", "roles", "since", "x y"]);
    expect(items.find((item) => item.label === "x y")?.insertText).toBe("`x y`");
    expect(items.every((item) => item.kind === KIND.Field)).toBe(true);
    expect(items[0]!.range).toEqual({ startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 10 });
  });

  test("a name that is a keyword or a word the read policy refuses is backticked, so the read it completes is allowed", () => {
    // `n.set` is refused with the backtick advice (Review focus 1); `n.\`set\`` runs.
    const schema = cypherCompletionSchemaOf([
      {
        path: ["neo4j", graphObjectSegment("label", "Match")],
        columns: [{ name: "set" }, { name: "alter" }, { name: "ok" }],
      },
    ]);
    const items = suggest("MATCH (n) RETURN n.|", schema);
    expect(items.map((item) => item.insertText)).toEqual(["`alter`", "ok", "`set`"]);
    expect(suggest("MATCH (n:|", schema).map((item) => item.insertText)).toEqual(["`Match`"]);
    // Without a profile only the keyword table decides: ALTER is no Cypher keyword the lexer lists.
    expect(suggest("MATCH (n) RETURN n.|", schema, null).map((item) => item.insertText)).toEqual([
      "alter",
      "ok",
      "`set`",
    ]);
  });

  test("after CALL, exactly the profile's allowed procedures", () => {
    const items = suggest("CALL db.|");
    expect(labelsOf(items)).toEqual([...NEO4J_POLICY_PROFILE.readPolicy.allowedProcedures]);
    expect(items.every((item) => item.kind === KIND.Function)).toBe(true);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 9 });
  });

  test("after SHOW, the profile's allowed forms that match what is typed, a name placeholder dropped", () => {
    // The item names the whole form but inserts and filters on the words still to come, over a range that
    // holds no space and no newline, so Monaco's filtering never scores a separator.
    const range = suggest("SHOW RANGE |");
    expect(labelsOf(range)).toEqual(["RANGE INDEXES"]);
    expect(range[0]).toMatchObject({ insertText: "INDEXES", filterText: "INDEXES" });
    expect(range[0]!.range).toEqual({ startLineNumber: 1, startColumn: 12, endLineNumber: 1, endColumn: 12 });
    const typing = suggest("SHOW RANGE IN|");
    expect(typing.map((item) => [item.label, item.insertText, item.filterText])).toEqual([
      ["RANGE INDEXES", "INDEXES", "INDEXES"],
    ]);
    expect(typing[0]!.range).toEqual({ startLineNumber: 1, startColumn: 12, endLineNumber: 1, endColumn: 14 });
    const twoLines = suggest("SHOW RELATIONSHIP\nUNI|");
    expect(twoLines.map((item) => item.insertText)).toEqual(["UNIQUENESS CONSTRAINTS"]);
    expect(twoLines[0]!.range).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 });
    // A form already written in full has nothing left to insert, and is not offered as an empty item.
    expect(suggest("SHOW INDEXES |")).toEqual([]);
    expect(suggest("SHOW DATABASE |")).toEqual([]);
    const all = labelsOf(suggest("SHOW |"));
    expect(all).toContain("INDEXES");
    expect(all).toContain("DATABASE");
    expect(all).not.toContain("DATABASE *");
    expect(all).not.toContain("TRANSACTIONS");
    expect(new Set(all).size).toBe(all.length);
  });

  test("with no graph policy profile, CALL and SHOW offer nothing rather than a guess", () => {
    expect(suggest("CALL |", cypherCompletionSchemaOf([]), null)).toEqual([]);
    expect(suggest("SHOW |", cypherCompletionSchemaOf([]), null)).toEqual([]);
  });

  test("keywords elsewhere, the lexer's own table", () => {
    const items = suggest("MATCH (n) RET|");
    expect(labelsOf(items)).toEqual([...CYPHER_KEYWORDS].sort());
    expect(items.every((item) => item.kind === KIND.Keyword)).toBe(true);
    expect(items[0]!.range).toEqual({ startLineNumber: 1, startColumn: 11, endLineNumber: 1, endColumn: 14 });
  });

  test("nothing inside a string", () => {
    expect(suggest("RETURN 'a|")).toEqual([]);
  });
});

describe("graphPolicyProfileOf", () => {
  test("answers the Neo4j profile for neo4j, and nothing for an engine that is not a graph or an unknown one", () => {
    expect(graphPolicyProfileOf("neo4j")).toBe(NEO4J_POLICY_PROFILE);
    expect(graphPolicyProfileOf("postgres")).toBeUndefined();
    expect(graphPolicyProfileOf(undefined)).toBeUndefined();
  });
});

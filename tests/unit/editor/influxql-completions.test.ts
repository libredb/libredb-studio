import { describe, expect, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { INFLUXQL_KEYWORDS } from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import {
  type InfluxqlCompletionSchema,
  influxqlCompletionContext,
  influxqlCompletionSchemaOf,
  registerInfluxqlCompletionProvider,
} from "@/lib/editor/influxql-completions";
import { INFLUXQL_LANGUAGE_ID } from "@/lib/editor/influxql-language";

const KIND = { Keyword: 17, Class: 5, Field: 3, Property: 9 } as const;

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
    getOffsetAt: (position: { lineNumber: number; column: number }) => {
      const lines = text.split("\n");
      return (
        lines.slice(0, position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + position.column - 1
      );
    },
  };
  return { model: model as unknown as Monaco.editor.ITextModel, position: positionAt(cursor) as Monaco.Position };
}

/** The schema objects as the editor's `schemaContext` carries them: `[database, measurement]` paths, typed columns. */
const SCHEMA_OBJECTS = [
  {
    name: "home",
    path: ["home", "home"],
    columns: [
      { name: "time", type: "time" },
      { name: "room", type: "tag" },
      { name: "temp", type: "float" },
      { name: "hum", type: "integer" },
    ],
  },
  {
    name: 'we"ird name;x',
    path: ["home", 'we"ird name;x'],
    columns: [
      { name: "time", type: "time" },
      { name: "a b", type: "tag" },
      { name: 'say "hi"', type: "string" },
    ],
  },
  { name: "cpu", path: ["telegraf", "cpu"], columns: [{ name: "host", type: "tag" }] },
  // The same measurement name in another database: its keys are offered only where no database is named.
  { name: "home", path: ["other", "home"], columns: [{ name: "site", type: "tag" }] },
  // A database row and a pathless object contribute nothing.
  { name: "home", path: ["home"] },
  { name: "pathless", columns: [{ name: "nope", type: "tag" }] },
  // A name no quoting can write is not offered rather than offered broken.
  { name: "bad", path: ["home", "bad\u0001name"], columns: [{ name: "ok", type: "tag" }] },
];

function suggest(withCursor: string, schema: InfluxqlCompletionSchema = influxqlCompletionSchemaOf(SCHEMA_OBJECTS)) {
  const { monaco, registered } = createMockMonaco();
  registerInfluxqlCompletionProvider(monaco, schema);
  const { model, position } = modelAt(withCursor);
  const result = registered[0]!.provider.provideCompletionItems(
    model,
    position as Monaco.Position,
    {} as Monaco.languages.CompletionContext,
    {} as Monaco.CancellationToken,
  ) as Monaco.languages.CompletionList;
  return { suggestions: result.suggestions, position };
}

const insertsOf = (items: Monaco.languages.CompletionItem[]) => items.map((item) => item.insertText);
const sortedKeywords = [...INFLUXQL_KEYWORDS].sort();

describe("influxqlCompletionSchemaOf", () => {
  test("reads each measurement from a [database, measurement] path, tag keys and field keys from its columns", () => {
    expect(influxqlCompletionSchemaOf(SCHEMA_OBJECTS)).toEqual({
      measurements: [
        { database: "home", measurement: "home", tags: ["room"], fields: ["temp", "hum"] },
        { database: "home", measurement: 'we"ird name;x', tags: ["a b"], fields: ['say "hi"'] },
        { database: "telegraf", measurement: "cpu", tags: ["host"], fields: [] },
        { database: "other", measurement: "home", tags: ["site"], fields: [] },
        { database: "home", measurement: "bad\u0001name", tags: ["ok"], fields: [] },
      ],
    });
  });

  test("an empty schema completes nothing from it", () => {
    expect(influxqlCompletionSchemaOf([])).toEqual({ measurements: [] });
  });
});

describe("influxqlCompletionContext", () => {
  const at = (before: string, after = "") => influxqlCompletionContext(before, after);

  test("after FROM, a source, replacing the whole source typed so far", () => {
    expect(at("SELECT * FROM ")).toEqual({ kind: "source", start: 14 });
    expect(at("SELECT * FROM ho")).toEqual({ kind: "source", start: 14 });
    expect(at('SELECT * FROM "home"..')).toEqual({ kind: "source", start: 14 });
    expect(at('SELECT * FROM "home".."ho')).toEqual({ kind: "source", start: 14 });
    expect(at("select * from home.autogen.c")).toEqual({ kind: "source", start: 14 });
    expect(at("SELECT *\nFROM\n  ho")).toEqual({ kind: "source", start: 16 });
  });

  test("after a comma in a FROM list, the next source", () => {
    expect(at("SELECT * FROM a, ")).toEqual({ kind: "source", start: 17 });
    expect(at("SELECT * FROM a,ho")).toEqual({ kind: "source", start: 16 });
    expect(at('SELECT * FROM "db".."a", /re/, db.autogen.c')).toEqual({ kind: "source", start: 31 });
    // A comma outside a FROM list is no source position.
    expect(at("SELECT a, ")).toEqual({ kind: "keyword", start: 10 });
    expect(at("SELECT a, ", " FROM cpu")).toEqual({ kind: "keyword", start: 10, source: { measurement: "cpu" } });
    expect(at("SELECT * FROM a WHERE x = 1 GROUP BY a, ")).toEqual({
      kind: "keyword",
      start: 40,
      source: { measurement: "a" },
    });
    expect(at(", ")).toEqual({ kind: "keyword", start: 2 });
  });

  test("elsewhere, keywords and the keys of the statement's first FROM source, replacing the word being typed", () => {
    expect(at("")).toEqual({ kind: "keyword", start: 0 });
    expect(at("SEL")).toEqual({ kind: "keyword", start: 0 });
    expect(at("SELECT * FROM")).toEqual({ kind: "keyword", start: 9 });
    expect(at('SELECT * FROM "home".."home" ')).toEqual({
      kind: "keyword",
      start: 29,
      source: { database: "home", measurement: "home" },
    });
    expect(at('SELECT * FROM "home".."home" WHERE "ro')).toEqual({
      kind: "keyword",
      start: 35,
      source: { database: "home", measurement: "home" },
    });
  });

  test("the first FROM source may follow the cursor, and only the cursor's statement is read", () => {
    expect(at("SELECT ", " FROM cpu")).toEqual({ kind: "keyword", start: 7, source: { measurement: "cpu" } });
    expect(at("SELECT te", "mp FROM autogen.home")).toEqual({
      kind: "keyword",
      start: 7,
      source: { measurement: "home" },
    });
    expect(at("SELECT ", " FROM db.autogen.cpu")).toEqual({
      kind: "keyword",
      start: 7,
      source: { database: "db", measurement: "cpu" },
    });
    expect(at("SELECT * FROM cpu; SELECT ", " FROM db..home; SELECT * FROM x")).toEqual({
      kind: "keyword",
      start: 26,
      source: { database: "db", measurement: "home" },
    });
  });

  test("a source the reader cannot name is no source: a regex, a subquery, a cut name, four segments", () => {
    expect(at("SELECT ", " FROM /cpu/")).toEqual({ kind: "keyword", start: 7 });
    expect(at("SELECT ", " FROM (SELECT * FROM cpu)")).toEqual({ kind: "keyword", start: 7 });
    expect(at("SELECT ", ' FROM "cpu')).toEqual({ kind: "keyword", start: 7 });
    expect(at("SELECT ", " FROM a.b.c.d")).toEqual({ kind: "keyword", start: 7 });
    expect(at("SELECT ", " FROM")).toEqual({ kind: "keyword", start: 7 });
  });

  test("inside a string, a regex or a comment, nothing", () => {
    expect(at("SELECT * FROM m WHERE a = 'abc")).toBeUndefined();
    expect(at("SELECT * FROM m WHERE a =~ /ab")).toBeUndefined();
    expect(at("SELECT * FROM m -- note")).toBeUndefined();
    expect(at("SELECT * FROM m /* open")).toBeUndefined();
  });

  test("a closed comment before the cursor is skipped", () => {
    expect(at("SELECT /* c */ ")).toEqual({ kind: "keyword", start: 15 });
    expect(at("SELECT * FROM -- c\n")).toEqual({ kind: "source", start: 19 });
  });
});

describe("registerInfluxqlCompletionProvider", () => {
  test("registers on the influxql language, with its trigger characters, and disposes", () => {
    const { monaco, registered } = createMockMonaco();
    const disposable = registerInfluxqlCompletionProvider(monaco, influxqlCompletionSchemaOf([]));
    expect(registered.map((entry) => entry.languageId)).toEqual([INFLUXQL_LANGUAGE_ID]);
    expect(registered[0]!.provider.triggerCharacters).toEqual([".", '"']);
    disposable.dispose();
    expect(registered[0]!.disposed).toBe(true);
  });

  test("after FROM, every measurement of the schema as a quoted source, replacing what was typed", () => {
    const { suggestions, position } = suggest('SELECT * FROM "home"..|');
    expect(insertsOf(suggestions)).toEqual([
      '"home".."home"',
      '"home".."we\\"ird name;x"',
      '"telegraf".."cpu"',
      '"other".."home"',
    ]);
    expect(suggestions.every((item) => item.kind === KIND.Class)).toBe(true);
    expect(suggestions[0]!.range).toEqual({
      startLineNumber: 1,
      startColumn: 15,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    // Typed with a quote, the quoted text is what Monaco filters on.
    expect(suggestions[0]!.filterText).toBe('"home".."home"');
  });

  test("a bare source typed is filtered on the bare spelling, and the insert is still quoted", () => {
    const { suggestions } = suggest("SELECT * FROM ho|");
    expect(suggestions[0]!.insertText).toBe('"home".."home"');
    expect(suggestions[0]!.filterText).toBe("home..home");
    expect(suggestions[0]!.label).toBe('"home".."home"');
  });

  test("a bare source typed with its retention policy is filtered on the typed policy, not on the default one", () => {
    const three = suggest("SELECT * FROM home.autogen.h|").suggestions;
    expect(three.map((item) => item.filterText)).toEqual([
      "home.autogen.home",
      'home.autogen.we"ird name;x',
      "telegraf.autogen.cpu",
      "other.autogen.home",
    ]);
    expect(three[0]!.insertText).toBe('"home".."home"');
    expect(suggest("SELECT * FROM autogen.c|").suggestions.map((item) => item.filterText)).toEqual([
      "autogen.home",
      'autogen.we"ird name;x',
      "autogen.cpu",
      "autogen.home",
    ]);
    expect(suggest("SELECT * FROM home..|").suggestions[0]!.filterText).toBe("home..home");
  });

  test("every inserted source, a hostile name included, makes a statement the read policy allows", () => {
    const { suggestions } = suggest("SELECT * FROM |");
    expect(suggestions).toHaveLength(4);
    for (const item of suggestions) {
      const verdict = evaluateInfluxql(`SELECT * FROM ${item.insertText}`);
      expect({ insert: item.insertText, allowed: verdict.allowed }).toEqual({ insert: item.insertText, allowed: true });
    }
  });

  test("elsewhere, the tag and field keys of the first FROM source, quoted, then the keywords", () => {
    const { suggestions, position } = suggest('SELECT | FROM "home".."home"');
    const keys = suggestions.filter((item) => item.kind !== KIND.Keyword);
    expect(insertsOf(keys)).toEqual(['"room"', '"temp"', '"hum"']);
    expect(keys.map((item) => item.label)).toEqual(["room", "temp", "hum"]);
    expect(keys.map((item) => item.detail)).toEqual(["Tag key", "Field key", "Field key"]);
    expect(keys.map((item) => item.filterText)).toEqual(["room", "temp", "hum"]);
    const keywords = suggestions.filter((item) => item.kind === KIND.Keyword);
    expect(keywords.map((item) => item.label)).toEqual(sortedKeywords);
    expect(keywords.map((item) => item.insertText)).toEqual(sortedKeywords);
    expect(suggestions[0]!.range).toEqual({
      startLineNumber: 1,
      startColumn: position.column,
      endLineNumber: 1,
      endColumn: position.column,
    });
  });

  test("a source named without its database offers the keys of every database's measurement of that name", () => {
    const { suggestions } = suggest("SELECT | FROM home");
    expect(insertsOf(suggestions.filter((item) => item.kind !== KIND.Keyword))).toEqual([
      '"room"',
      '"temp"',
      '"hum"',
      '"site"',
    ]);
  });

  test("a key shared by the measurement of that name in several databases is offered once", () => {
    const schema: InfluxqlCompletionSchema = {
      measurements: [
        { database: "a", measurement: "m", tags: ["host", "region"], fields: ["v"] },
        { database: "b", measurement: "m", tags: ["host"], fields: ["v", "w"] },
      ],
    };
    const { suggestions } = suggest("SELECT | FROM m", schema);
    const keys = suggestions.filter((item) => item.kind !== KIND.Keyword);
    expect(keys.map((item) => item.label)).toEqual(["host", "region", "v", "w"]);
    expect(keys.map((item) => item.detail)).toEqual(["Tag key", "Tag key", "Field key", "Field key"]);
  });

  test("a hostile measurement's keys are quoted, and the statement they make is allowed", () => {
    const { suggestions } = suggest('SELECT "a| FROM "home".."we\\"ird name;x"');
    const keys = suggestions.filter((item) => item.kind !== KIND.Keyword);
    expect(insertsOf(keys)).toEqual(['"a b"', '"say \\"hi\\""']);
    // Typed with a quote, the quoted text is what Monaco filters on.
    expect(keys.map((item) => item.filterText)).toEqual(['"a b"', '"say \\"hi\\""']);
    for (const item of keys) {
      expect(evaluateInfluxql(`SELECT ${item.insertText} FROM "home".."we\\"ird name;x"`).allowed).toBe(true);
    }
  });

  test("a key no quoting can write is not offered", () => {
    const schema: InfluxqlCompletionSchema = {
      measurements: [{ database: "d", measurement: "m", tags: ["bad\u0001tag", "ok"], fields: [] }],
    };
    const { suggestions } = suggest("SELECT | FROM d..m", schema);
    expect(insertsOf(suggestions.filter((item) => item.kind !== KIND.Keyword))).toEqual(['"ok"']);
  });

  test("without a FROM source, only the keywords; inside a comment, nothing", () => {
    expect(suggest("SEL|").suggestions.every((item) => item.kind === KIND.Keyword)).toBe(true);
    expect(suggest("SELECT * FROM m -- |").suggestions).toEqual([]);
  });

  test("the replaced word is on the cursor's line when the statement spans lines", () => {
    const { suggestions } = suggest("SELECT *\nFROM\n  te|");
    expect(suggestions[0]!.range).toEqual({ startLineNumber: 3, startColumn: 3, endLineNumber: 3, endColumn: 5 });
  });

  test("a model whose lines end in CR LF is read with the lexer's newline rule", () => {
    const { monaco, registered } = createMockMonaco();
    registerInfluxqlCompletionProvider(monaco, influxqlCompletionSchemaOf(SCHEMA_OBJECTS));
    const text = "SELECT *\r\nFROM ho";
    const model = { getValue: () => text, getOffsetAt: () => text.length } as unknown as Monaco.editor.ITextModel;
    const result = registered[0]!.provider.provideCompletionItems(
      model,
      { lineNumber: 2, column: 8 } as Monaco.Position,
      {} as Monaco.languages.CompletionContext,
      {} as Monaco.CancellationToken,
    ) as Monaco.languages.CompletionList;
    expect(result.suggestions[0]!.insertText).toBe('"home".."home"');
    expect(result.suggestions[0]!.range).toEqual({
      startLineNumber: 2,
      startColumn: 6,
      endLineNumber: 2,
      endColumn: 8,
    });
  });
});

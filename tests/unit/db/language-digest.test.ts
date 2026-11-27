/**
 * The language data digest (src/lib/db/language-digest.ts): the SHA-256 of an engine declaration's statement language
 * data, `statementLanguageData`, over the canonical text the grammar digest uses (src/lib/db/canonical-json.ts). The
 * canonical text and the digest are read here on hand-made values; the server catalog's composer, which hands a
 * package engine's digest to the grant reader, is the digest's one importer in src.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { canonicalLanguageDataText, languageDataSha256 } from "@/lib/db/language-digest";

/** Statement language data, not null. */
type Data = NonNullable<StatementLanguageData>;

/** Language data whose top-level members a case may replace. */
type Editable = { -readonly [K in keyof Data]: Data[K] };

/** Language data named `acmeql` whose confirmation names no operation and which has no agent part, changed by `change`. */
function languageData(change: (data: Editable) => void = () => {}): Data {
  const data = {
    name: "acmeql",
    confirmation: {
      operations: [],
      reader: "names-no-operation",
      decidesAlone: true,
      safetyAnalysis: false,
      maxTextBytes: null,
    },
    agent: null,
  } as Data;
  change(data);
  return data;
}

/** An agent part whose request form has no selector, an optional name `topic` and an optional integer `limit`, changed by `change`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a draft form each case changes one fact of.
function requestForm(change: (form: Record<string, any>) => void = () => {}): NonNullable<Data["agent"]> {
  const refusal = (code: string) => ({ code, sentence: `Refused as ${code}.` });
  const form = {
    kind: "json-object",
    maxCharacters: 4096,
    refusals: {
      tooLong: refusal("too-long"),
      empty: refusal("empty"),
      notAnObject: refusal("not-an-object"),
      repeatedKey: refusal("repeated-key"),
      unknownKey: refusal("unknown-key"),
    },
    keys: ["topic", "limit"],
    selector: null,
    common: [
      {
        key: "topic",
        absent: null,
        rule: {
          kind: "name",
          characters: [{ from: "a", to: "z" }],
          minLength: 1,
          maxLength: 249,
          refused: [{ names: ["internal"], prefixes: ["_"], refusal: refusal("withheld") }],
          refusal: refusal("topic"),
        },
      },
      {
        key: "limit",
        absent: null,
        rule: { kind: "integer", minimum: 1, maximum: 500, default: 50, refusal: refusal("limit") },
      },
    ],
    reads: [],
  };
  change(form);
  return { request: form } as NonNullable<Data["agent"]>;
}

describe("the language data digest", () => {
  test("the language data digest is the SHA-256 of the member's canonical text, equal for two member orders and different for any changed fact", () => {
    const data = languageData();
    const reordered = {
      agent: null,
      confirmation: {
        maxTextBytes: null,
        safetyAnalysis: false,
        decidesAlone: true,
        reader: "names-no-operation",
        operations: [],
      },
      name: "acmeql",
    } as Data;
    const digest = languageDataSha256(data);

    expect(canonicalLanguageDataText(data)).toBe(
      '{"agent":null,"confirmation":{"decidesAlone":true,"maxTextBytes":null,"operations":[],"reader":"names-no-operation","safetyAnalysis":false},"name":"acmeql"}',
    );
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash("sha256").update(canonicalLanguageDataText(data)).digest("hex"));
    expect(languageDataSha256(reordered)).toBe(digest);

    const changed = [
      languageData((d) => (d.name = "acmeqm")),
      languageData((d) => (d.confirmation = { ...d.confirmation, operations: ["drop"] })),
      languageData((d) => (d.confirmation = { ...d.confirmation, reader: "names-other" as never })),
      languageData((d) => (d.confirmation = { ...d.confirmation, decidesAlone: false })),
      languageData((d) => (d.confirmation = { ...d.confirmation, safetyAnalysis: true })),
      languageData((d) => (d.confirmation = { ...d.confirmation, maxTextBytes: 1 })),
    ];
    const digests = changed.map((item) => languageDataSha256(item));
    expect(digests).not.toContain(digest);
    expect(new Set(digests).size).toBe(changed.length);
    expect(canonicalLanguageDataText(languageData((d) => (d.agent = requestForm())))).toStartWith(
      '{"agent":{"request":{"common":[{"absent":null,"key":"topic","rule":{"characters":[{"from":"a","to":"z"}],',
    );
    // A list keeps its own order: two operations in another order are another fact.
    expect(
      languageDataSha256(languageData((d) => (d.confirmation = { ...d.confirmation, operations: ["a", "b"] }))),
    ).not.toBe(
      languageDataSha256(languageData((d) => (d.confirmation = { ...d.confirmation, operations: ["b", "a"] }))),
    );
  });

  test("the agent part's request form is digested with the rest of the data: any changed sentence, code, bound or range changes the digest, and member order does not", () => {
    const stated = languageDataSha256(languageData((d) => (d.agent = requestForm())));
    const { request } = requestForm();
    const reordered = languageData((d) => {
      d.agent = {
        request: {
          reads: request.reads,
          common: request.common.map((check) => ({ rule: check.rule, absent: check.absent, key: check.key })),
          selector: request.selector,
          keys: request.keys,
          refusals: request.refusals,
          maxCharacters: request.maxCharacters,
          kind: request.kind,
        },
      };
    });

    expect(languageDataSha256(reordered)).toBe(stated);
    const changed = [
      languageData(),
      languageData((d) => (d.agent = requestForm((f) => (f.refusals.empty.sentence = "Refused as empty!")))),
      languageData((d) => (d.agent = requestForm((f) => (f.refusals.empty.code = "blank")))),
      languageData((d) => (d.agent = requestForm((f) => (f.maxCharacters = 4095)))),
      languageData((d) => (d.agent = requestForm((f) => (f.common[0].rule.characters[0].to = "y")))),
      languageData((d) => (d.agent = requestForm((f) => (f.common[0].rule.refused[0].prefixes = ["-"])))),
      languageData((d) => (d.agent = requestForm((f) => (f.common[1].rule.maximum = 499)))),
      languageData((d) => (d.agent = requestForm((f) => (f.common[1].rule.default = null)))),
      languageData((d) => (d.agent = requestForm((f) => (f.keys = ["limit", "topic"])))),
    ];
    const digests = changed.map((item) => languageDataSha256(item));
    expect(digests).not.toContain(stated);
    expect(new Set(digests).size).toBe(changed.length);
  });

  test("a value that is not JSON is refused by name, naming a statement language, never written as a default", () => {
    for (const [value, name] of [
      [undefined, "undefined"],
      [() => 1, "function"],
      [Number.POSITIVE_INFINITY, "number"],
    ] as const) {
      const holding = languageData((d) => (d.confirmation = { ...d.confirmation, maxTextBytes: value as never }));

      expect(() => canonicalLanguageDataText(holding)).toThrow(
        `a statement language's canonical text holds JSON values only, and this statement language holds a value of type ${name}`,
      );
      expect(() => languageDataSha256(holding)).toThrow(
        `a statement language's canonical text holds JSON values only, and this statement language holds a value of type ${name}`,
      );
    }
  });
});

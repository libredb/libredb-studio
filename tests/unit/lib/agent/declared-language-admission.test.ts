/**
 * A statement language an engine declares as data is admitted by its declared request form alone
 * (src/lib/db/operations/declared-request-form.ts), and the form and the provider's own reader answer every request
 * alike (tests/helpers/declared-language-census.ts).
 *
 * The form here is `acmeread`, a crafted language with a selector naming two reads and every rule kind. Every code and
 * sentence it declares is generated at run time, so an answer that is one of them is the declared one, and a marker
 * written into a request that reaches a refusal would be a quoted request.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRequestForm, AgentRequestRefusal } from "@libredb/provider-sdk/manifest";
import { admitDeclaredRequest } from "@/lib/db/operations/declared-request-form";
import { repeatsAKey } from "@libredb/provider-sdk/values";
import { DECLARED_AGENT_LANGUAGES } from "@/lib/agent/languages/client";
import { composeDeclaredServerPack } from "@/lib/agent/languages/declared-server";
import { languageServerPack } from "@/lib/agent/languages/server";
import { shippedDeclaredLanguage } from "../../../helpers/shipped-declared-language";
import {
  censusDisagreements,
  type ProviderReading,
  READER_ENROLLMENTS,
  shippedLanguageData,
} from "../../../helpers/declared-language-census";

/** A refusal whose code opens with `label` and whose sentence is generated, both distinct for each call. */
function generatedRefusal(label: string): AgentRequestRefusal {
  return { code: `${label}-${randomUUID().slice(0, 8)}`, sentence: `Refused (${label}): ${randomUUID()}.` };
}

const R = {
  tooLong: generatedRefusal("too-long"),
  empty: generatedRefusal("empty"),
  notAnObject: generatedRefusal("not-an-object"),
  repeatedKey: generatedRefusal("repeated-key"),
  unknownKey: generatedRefusal("unknown-key"),
  notARead: generatedRefusal("not-a-read"),
  limit: generatedRefusal("limit"),
  topicNotTaken: generatedRefusal("topic-not-taken"),
  modeNotTaken: generatedRefusal("mode-not-taken"),
  cursor: generatedRefusal("cursor"),
  cursorDots: generatedRefusal("cursor-dots"),
  mode: generatedRefusal("mode"),
  topicRequired: generatedRefusal("topic-required"),
  topic: generatedRefusal("topic"),
  internal: generatedRefusal("internal"),
  withheld: generatedRefusal("withheld"),
  idCursor: generatedRefusal("id-cursor"),
};

/**
 * `acmeread`: the selector `read` names `topics` and `offsets`; `limit` is a common integer 1 to 500 with a default;
 * `topics` refuses `topic` and takes an optional dotted cursor name and a `mode`; `offsets` refuses `mode`, requires a
 * `topic` name (lower-case letters, digits, `_`, `-` and a range of emoji, 2 to 12 code points, refusing `internal`
 * and then anything opening with `_`, `in` or `connect-`) and takes an optional integer cursor.
 */
const FORM: AgentRequestForm = {
  kind: "json-object",
  maxCharacters: 4096,
  refusals: {
    tooLong: R.tooLong,
    empty: R.empty,
    notAnObject: R.notAnObject,
    repeatedKey: R.repeatedKey,
    unknownKey: R.unknownKey,
  },
  keys: ["read", "topic", "after", "limit", "mode"],
  selector: { key: "read", refusal: R.notARead },
  common: [
    { key: "limit", absent: null, rule: { kind: "integer", minimum: 1, maximum: 500, default: 50, refusal: R.limit } },
  ],
  reads: [
    {
      value: "topics",
      refuses: [{ key: "topic", refusal: R.topicNotTaken }],
      checks: [
        {
          key: "after",
          absent: null,
          rule: {
            kind: "name",
            characters: [
              { from: "a", to: "z" },
              { from: ".", to: "." },
            ],
            minLength: 1,
            maxLength: 8,
            refused: [{ names: [".", ".."], prefixes: [], refusal: R.cursorDots }],
            refusal: R.cursor,
          },
        },
        { key: "mode", absent: null, rule: { kind: "enumeration", values: ["fast", "slow"], refusal: R.mode } },
      ],
    },
    {
      value: "offsets",
      refuses: [{ key: "mode", refusal: R.modeNotTaken }],
      checks: [
        {
          key: "topic",
          absent: R.topicRequired,
          rule: {
            kind: "name",
            characters: [
              { from: "a", to: "z" },
              { from: "0", to: "9" },
              { from: "_", to: "_" },
              { from: "-", to: "-" },
              { from: "\u{1F600}", to: "\u{1F64F}" },
            ],
            minLength: 2,
            maxLength: 12,
            refused: [
              { names: ["internal"], prefixes: [], refusal: R.internal },
              { names: [], prefixes: ["_", "in", "connect-"], refusal: R.withheld },
            ],
            refusal: R.topic,
          },
        },
        {
          key: "after",
          absent: null,
          rule: { kind: "integer", minimum: 0, maximum: 2147483647, default: null, refusal: R.idCursor },
        },
      ],
    },
  ],
};

/** Each request of the cases below and the refusal it meets, or null where it is admitted. */
const CASES: readonly (readonly [string, AgentRequestRefusal | null])[] = [
  // (1) The bound, before anything else: an over-long blank text is too long, not empty.
  ["x".repeat(4097), R.tooLong],
  [" ".repeat(4097), R.tooLong],
  // (2) Blank.
  ["", R.empty],
  ["  \n\t", R.empty],
  // (3) No JSON object.
  ["nope", R.notAnObject],
  ["[]", R.notAnObject],
  ["null", R.notAnObject],
  ['"x"', R.notAnObject],
  ["1", R.notAnObject],
  ["true", R.notAnObject],
  ['{"read": "topics"} {"read": "topics"}', R.notAnObject],
  ['{"read": "topics"', R.notAnObject],
  // (4) A key written twice, by any spelling JSON reads as the same key, at any depth.
  ['{"read": "topics", "read": "offsets", "topic": "ab"}', R.repeatedKey],
  ['{"read": "offsets", "topic": "ab", "t\\u006fpic": "cd"}', R.repeatedKey],
  ['{"read": "topics", "mode": {"a": 1, "a": 2}}', R.repeatedKey],
  // (5) A key outside the closed set, the prototype's names among them.
  ['{"read": "topics", "sql": "SELECT 1"}', R.unknownKey],
  ['{"__proto__": 1, "read": "topics"}', R.unknownKey],
  ['{"read": "topics", "constructor": 1}', R.unknownKey],
  // (6) The selector: absent, no string, or no read's value.
  ["{}", R.notARead],
  ['{"read": 1}', R.notARead],
  ['{"read": null}', R.notARead],
  ['{"read": ["topics"]}', R.notARead],
  ['{"read": "records"}', R.notARead],
  ['{"read": "toString"}', R.notARead],
  ['{"read": "Topics"}', R.notARead],
  // (7) The common check, before the read's own: a JSON null is a wrong type, never the default.
  ['{"read": "topics", "limit": 0}', R.limit],
  ['{"read": "topics", "limit": 501}', R.limit],
  ['{"read": "topics", "limit": -1}', R.limit],
  ['{"read": "topics", "limit": 1.5}', R.limit],
  ['{"read": "topics", "limit": "5"}', R.limit],
  ['{"read": "topics", "limit": null}', R.limit],
  ['{"read": "topics", "limit": true}', R.limit],
  ['{"read": "topics", "limit": 1e400}', R.limit],
  ['{"read": "topics", "limit": -0}', R.limit],
  ['{"read": "topics", "topic": "ab", "limit": 0}', R.limit],
  // (8) A key the read refuses, before the read's checks.
  ['{"read": "topics", "topic": "ab"}', R.topicNotTaken],
  ['{"read": "topics", "topic": "ab", "after": "!"}', R.topicNotTaken],
  ['{"read": "offsets", "topic": "ab", "mode": "fast"}', R.modeNotTaken],
  ['{"read": "offsets", "mode": "fast"}', R.modeNotTaken],
  // (9) The read's checks in order: a required key, then each value rule.
  ['{"read": "offsets"}', R.topicRequired],
  ['{"read": "offsets", "after": -1}', R.topicRequired],
  ['{"read": "offsets", "topic": "a"}', R.topic],
  ['{"read": "offsets", "topic": "abcdefghijklm"}', R.topic],
  ['{"read": "offsets", "topic": "a b"}', R.topic],
  ['{"read": "offsets", "topic": "A1"}', R.topic],
  ['{"read": "offsets", "topic": "a\u{1F680}"}', R.topic],
  ['{"read": "offsets", "topic": "a\\ud800"}', R.topic],
  ['{"read": "offsets", "topic": "\\ude00\\ud83d"}', R.topic],
  [`{"read": "offsets", "topic": "${"\u{1F600}".repeat(13)}"}`, R.topic],
  ['{"read": "offsets", "topic": 7}', R.topic],
  ['{"read": "offsets", "topic": null}', R.topic],
  ['{"read": "offsets", "topic": ["ab"]}', R.topic],
  ['{"read": "offsets", "topic": "internal"}', R.internal],
  ['{"read": "offsets", "topic": "inner"}', R.withheld],
  ['{"read": "offsets", "topic": "_x"}', R.withheld],
  ['{"read": "offsets", "topic": "connect-a"}', R.withheld],
  ['{"read": "offsets", "topic": "ab", "after": -1}', R.idCursor],
  ['{"read": "offsets", "topic": "ab", "after": 2147483648}', R.idCursor],
  ['{"read": "offsets", "topic": "ab", "after": "3"}', R.idCursor],
  ['{"read": "offsets", "topic": "ab", "after": 1.5}', R.idCursor],
  ['{"read": "topics", "after": "."}', R.cursorDots],
  ['{"read": "topics", "after": ".."}', R.cursorDots],
  ['{"read": "topics", "after": ""}', R.cursor],
  ['{"read": "topics", "after": "abcdefghi"}', R.cursor],
  ['{"read": "topics", "after": 3}', R.cursor],
  ['{"read": "topics", "mode": "medium"}', R.mode],
  ['{"read": "topics", "mode": 1}', R.mode],
  ['{"read": "topics", "after": "!", "mode": "medium"}', R.cursor],
  // (10) Admitted: defaults left out, keys in any order and spacing, -0 and 5.0 as integers, emoji as code points.
  ['{"read": "topics"}', null],
  ['{ "limit" : 5 ,\n  "read":"topics" }', null],
  ['{"read": "topics", "limit": 5.0}', null],
  ['{"read": "topics", "after": "...", "mode": "slow", "limit": 500}', null],
  ['{"read": "offsets", "topic": "ab", "after": -0}', null],
  ['{"after": 2147483647, "topic": "a-b_9", "read": "offsets", "limit": 1}', null],
  [`{"read": "offsets", "topic": "${"\u{1F600}".repeat(12)}"}`, null],
  ['{"read": "offsets", "topic": "\\ud83d\\ude00x"}', null],
  ['{"read": "offsets", "topic": "nin"}', null],
];

/** The admission's answer to `text` as the declared refusal's shape, or null. */
function admitted(text: string): AgentRequestRefusal | null {
  const answer = admitDeclaredRequest(FORM, text);
  return answer === null ? null : { code: answer.code, sentence: answer.message };
}

/**
 * `acmeread`'s reader, written by hand as a provider would write its own, with the repeated-key scan the provider
 * readers share: the same answers as the form, reached by code rather than by data.
 */
function acmereadReader(text: string): ProviderReading {
  const refuse = (refusal: AgentRequestRefusal): ProviderReading => ({
    ok: false,
    code: refusal.code,
    message: refusal.sentence,
  });
  if (/^\s*$/.test(text)) return refuse(R.empty);
  let request: unknown;
  try {
    request = JSON.parse(text);
  } catch {
    return refuse(R.notAnObject);
  }
  if (typeof request !== "object" || request === null || Array.isArray(request)) return refuse(R.notAnObject);
  const keys = Object.keys(request);
  if (repeatsAKey(text)) return refuse(R.repeatedKey);
  if (!keys.every((key) => ["read", "topic", "after", "limit", "mode"].includes(key))) return refuse(R.unknownKey);
  const { read, topic, after, limit, mode } = request as Record<string, unknown>;
  const has = (key: string) => keys.includes(key);
  if (read !== "topics" && read !== "offsets") return refuse(R.notARead);
  if (has("limit") && !(Number.isInteger(limit) && (limit as number) >= 1 && (limit as number) <= 500)) {
    return refuse(R.limit);
  }
  if (read === "topics") {
    if (has("topic")) return refuse(R.topicNotTaken);
    if (has("after")) {
      if (typeof after !== "string" || !/^[a-z.]{1,8}$/.test(after)) return refuse(R.cursor);
      if (after === "." || after === "..") return refuse(R.cursorDots);
    }
    if (has("mode") && mode !== "fast" && mode !== "slow") return refuse(R.mode);
    return { ok: true };
  }
  if (has("mode")) return refuse(R.modeNotTaken);
  if (!has("topic")) return refuse(R.topicRequired);
  if (typeof topic !== "string" || !/^[a-z0-9_\-\u{1F600}-\u{1F64F}]{2,12}$/u.test(topic)) return refuse(R.topic);
  if (topic === "internal") return refuse(R.internal);
  if (/^(?:_|in|connect-)/.test(topic)) return refuse(R.withheld);
  if (has("after") && !(Number.isInteger(after) && (after as number) >= 0 && (after as number) <= 2147483647)) {
    return refuse(R.idCursor);
  }
  return { ok: true };
}

describe("a data-declared language's admission", () => {
  test("a data-declared language's statement is admitted or refused by its declared request form, with its declared sentence and code, and never quoted", () => {
    const declared = Object.values(R);
    for (const [text, expected] of CASES) {
      const answer = admitted(text);

      expect({ text, answer }).toEqual({ text, answer: expected });
      if (answer !== null) expect(declared).toContainEqual(answer);
    }

    const marker = randomUUID();
    for (const text of [
      `{"read": "topics", "${marker}": 1}`,
      `{"read": "offsets", "topic": "${marker}"}`,
      `{"read": "${marker}"}`,
      `{"read": "topics", "mode": "${marker}"}`,
      `{"read": "topics", "after": "${marker}"}`,
      `{"read": "topics", "limit": "${marker}"}`,
      `${marker}`,
      `{"${marker}": 1, "${marker}": 2}`,
      `{"read": "offsets", "topic": "in${marker}"}`,
    ]) {
      const answer = admitted(text);

      expect(answer).not.toBeNull();
      expect(JSON.stringify(answer)).not.toContain(marker);
      expect(declared).toContainEqual(answer as AgentRequestRefusal);
    }
  });

  test("a request nested as deep as the bound allows is answered, never thrown", () => {
    const bound = { ...FORM, maxCharacters: 65536 };
    const arrays = `${"[".repeat(32768)}${"]".repeat(32768)}`;
    const objects = `${'{"a":'.repeat(10922)}1${"}".repeat(10922)}`;

    expect(arrays.length).toBe(65536);
    expect(admitDeclaredRequest(bound, arrays)).toEqual({ code: R.notAnObject.code, message: R.notAnObject.sentence });
    expect(objects.length).toBeLessThanOrEqual(65536);
    expect(admitDeclaredRequest(bound, objects)).toEqual({ code: R.unknownKey.code, message: R.unknownKey.sentence });
    expect(admitDeclaredRequest(bound, `${arrays} `)).toEqual({ code: R.tooLong.code, message: R.tooLong.sentence });
  });

  test("a name is a well-formed string whatever its character ranges hold", () => {
    const wide: AgentRequestForm = {
      ...FORM,
      keys: ["topic"],
      selector: null,
      reads: [],
      common: [
        {
          key: "topic",
          absent: null,
          rule: {
            kind: "name",
            characters: [{ from: "\u{D7FF}", to: "\u{E000}" }],
            minLength: 1,
            maxLength: 4,
            refused: [],
            refusal: R.topic,
          },
        },
      ],
    };

    expect(admitDeclaredRequest(wide, '{"topic": "\\ud7ff\\ue000"}')).toBeNull();
    for (const surrogate of ["\\ud800", "\\udfff", "\\ude00\\ud83d"]) {
      expect(admitDeclaredRequest(wide, `{"topic": "${surrogate}"}`)).toEqual({
        code: R.topic.code,
        message: R.topic.sentence,
      });
    }
  });

  test("a request form with no selector is read by its common checks alone", () => {
    const common: AgentRequestForm = { ...FORM, keys: ["limit"], selector: null, reads: [] };

    expect(admitDeclaredRequest(common, "{}")).toBeNull();
    expect(admitDeclaredRequest(common, '{"limit": 9}')).toBeNull();
    expect(admitDeclaredRequest(common, '{"limit": 0}')).toEqual({ code: R.limit.code, message: R.limit.sentence });
    expect(admitDeclaredRequest(common, '{"read": "topics"}')).toEqual({
      code: R.unknownKey.code,
      message: R.unknownKey.sentence,
    });
  });
});

describe("the census of a declared request form", () => {
  test("a declared request form and the provider's reader answer every request of the corpus alike", () => {
    const declaring = shippedLanguageData()
      .filter((data) => data.agent !== null)
      .map((data) => data.name)
      .sort();
    expect([...READER_ENROLLMENTS.keys()].sort()).toEqual(declaring);
    for (const data of shippedLanguageData()) {
      const enrollment = READER_ENROLLMENTS.get(data.name);
      if (data.agent === null || enrollment === undefined) continue;
      expect(censusDisagreements(data.name, data.agent.request, enrollment.reader, enrollment.corpus)).toEqual([]);
    }

    const corpus = new Set(CASES.map(([text]) => text));
    const reads = [undefined, "topics", "offsets", "records", 1, null];
    const topics = [undefined, "ab", "a", "internal", "inner", "_x", "connect-a", "nin", "A1", 7, "\u{1F600}x", "a.b"];
    const afters = [undefined, ".", "..", "...", "abc", -1, 0, 2147483648, 1.5, "3"];
    const limits = [undefined, 0, 1, 500, 501, 1.5, "5", null];
    const modes = [undefined, "fast", "slow", "medium"];
    for (const read of reads)
      for (const topic of topics)
        for (const after of afters)
          for (const limit of limits)
            for (const mode of modes) {
              const request = Object.fromEntries(
                Object.entries({ read, topic, after, limit, mode }).filter(([, value]) => value !== undefined),
              );
              corpus.add(JSON.stringify(request));
            }
    expect(corpus.size).toBeGreaterThan(20000);

    expect(censusDisagreements("acmeread", FORM, acmereadReader, corpus)).toEqual([]);

    const differing = '{"read": "offsets", "topic": "inner"}';
    const otherSentence = (text: string): ProviderReading =>
      text === differing ? { ok: false, code: R.withheld.code, message: "Another sentence." } : acmereadReader(text);
    expect(censusDisagreements("acmeread", FORM, otherSentence, corpus)).toEqual([
      `acmeread: ${JSON.stringify(differing)} is refused ${R.withheld.code} ${JSON.stringify(R.withheld.sentence)} by the declared form and refused ${R.withheld.code} "Another sentence." by the provider's reader`,
    ]);

    const admitting = '{"read": "offsets", "topic": "internal"}';
    const looser = (text: string): ProviderReading => (text === admitting ? { ok: true } : acmereadReader(text));
    expect(censusDisagreements("acmeread", FORM, looser, corpus)).toEqual([
      `acmeread: ${JSON.stringify(admitting)} is refused ${R.internal.code} ${JSON.stringify(R.internal.sentence)} by the declared form and admitted by the provider's reader`,
    ]);

    // A text over the bound is the agent's own refusal, never the reader's, so the census passes over it.
    const overBound = "x".repeat(4097);
    expect(censusDisagreements("acmeread", FORM, () => ({ ok: true }), [overBound])).toEqual([]);
  });

  test("each enrolled language's composed repair fingerprint groups its corpus as its provider reader's plans do", () => {
    expect(READER_ENROLLMENTS.size).toBeGreaterThan(0);
    for (const [language, { reader, corpus }] of READER_ENROLLMENTS) {
      // The server facet one run reads for the language is the one composed from its declared data.
      expect<readonly string[]>(DECLARED_AGENT_LANGUAGES.map(({ id }) => id)).toContain(language);
      const { fingerprint } = languageServerPack(shippedDeclaredLanguage(language)).adapter;
      // The provider reader's identity of a request: the plan it reads, or the raw text of a request it refuses. Two
      // requests share a fingerprint exactly when they share this identity, so the partitions are the same.
      const identity = (text: string) => {
        const reading = reader(text);
        return reading.ok ? `plan:${reading.plan}` : `raw:${text}`;
      };
      const byFingerprint = new Map<string, string>();
      const byIdentity = new Map<string, string>();
      const clashes: string[] = [];
      for (const text of corpus) {
        const print = fingerprint(text);
        const own = identity(text);
        if ((byFingerprint.get(print) ?? own) !== own)
          clashes.push(`${JSON.stringify(text)} joins another read's class`);
        if ((byIdentity.get(own) ?? print) !== print) clashes.push(`${JSON.stringify(text)} splits its read's class`);
        byFingerprint.set(print, own);
        byIdentity.set(own, print);
      }
      expect({ language, clashes }).toEqual({ language, clashes: [] });
      expect({ language, classes: byFingerprint.size }).toEqual({ language, classes: byIdentity.size });
      // Vacuity: the corpus holds reads written in more than one spelling, and refused requests.
      expect(byIdentity.size).toBeLessThan(corpus.length);
      expect([...byIdentity.keys()].some((key) => key.startsWith("raw:"))).toBe(true);
    }
  });

  test("a declared form that admits no object value gives an admitted read one fingerprint whatever its key order and spacing", () => {
    // The out-of-tree fixture's listget, read from its manifest: a form whose values are names, never objects.
    const fixture = JSON.parse(
      readFileSync(path.join(import.meta.dir, "../../../fixtures/out-of-tree-provider/libredb-provider.json"), "utf8"),
    );
    const { fingerprint } = composeDeclaredServerPack(
      "listget",
      fixture.engines[0].statementLanguageData.agent,
      "x",
    ).adapter;

    expect(fingerprint('{"read":"get","name":"beta"}')).toBe(fingerprint('{ "name": "beta", "read": "get" }'));
    expect(fingerprint('{"read":"list"}')).toBe(fingerprint('{ "read": "list" }'));
    // Vacuity: two reads of different names are two classes.
    expect(fingerprint('{"read":"get","name":"beta"}')).not.toBe(fingerprint('{"read":"get","name":"gamma"}'));
  });
});

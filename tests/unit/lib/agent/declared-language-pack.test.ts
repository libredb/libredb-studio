/**
 * A statement language an engine declares as data is composed from its data alone: one engine-neutral composer builds
 * its client facet (src/lib/agent/languages/declared-client.ts) and its server facet
 * (src/lib/agent/languages/declared-server.ts) from the language's declared text and request form, byte for byte as
 * declared, with the members Studio fixes for every declared JSON request language. Read here on the crafted `acmeread`
 * (tests/helpers/declared-agent-language.ts), whose every text carries a marker generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_TEXT_FILLS,
  type AgentLanguageText,
  type AgentText,
  compileManifestValidator,
} from "@libredb/provider-sdk/manifest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { composeDeclaredClientPack, fillAgentText } from "@/lib/agent/languages/declared-client";
import { composeDeclaredServerPack } from "@/lib/agent/languages/declared-server";
import { canonicalText, OPERATIONS_TOOL_RULE } from "@/lib/agent/languages/shared";
import { OPERATIONS_VARIANT } from "@/lib/agent/workflow-tool-sets";
import { DECLARED_STATEMENT_LANGUAGES } from "@/lib/db/declared-statement-languages";
import { admitDeclaredRequest, declaredRequestIdentity } from "@/lib/db/operations/declared-request-form";
import { acmereadData, acmereadForm, acmereadText } from "../../../helpers/declared-agent-language";
import { shippedLanguageData } from "../../../helpers/declared-language-census";

const BOUNDS = Object.freeze({ maxResultRows: 7, statementTimeoutMs: 2500 });
const NOUN = Object.freeze({ singular: "topic", plural: "topics" });

/** A text's string parts and fills, written out with `values` in place of each fill. */
function written(text: AgentText, values: Readonly<Record<string, string>>): string {
  return typeof text === "string"
    ? text
    : text.map((part) => (typeof part === "string" ? part : (values[part.fill] as string))).join("");
}

/** The requests the admission and the repair identity are read over: admitted and refused, in several spellings. */
const CORPUS = [
  '{"read":"topics"}',
  '{ "read" : "topics" }',
  '{"limit":50,"read":"topics"}',
  '{"read":"topics","limit":49}',
  '{"read":"topics","limit":5.0}',
  '{"read":"topics","limit":5}',
  '{"read":"offsets","topic":"orders"}',
  '{"topic":"orders","read":"offsets","limit":500}',
  '{"read":"offsets"}',
  '{"read":"offsets","topic":"Orders"}',
  '{"read":"topics","topic":"orders"}',
  '{"read":"nope"}',
  '{ "read":"nope"}',
  '{"read":"topics","read":"topics"}',
  '{"read":"topics","sql":"select 1"}',
  '{"read":"topics","limit":0}',
  '{"read":"topics","limit":null}',
  "[]",
  "not json",
  "   ",
  "x".repeat(257),
];

describe("the composer of a data-declared language", () => {
  test("a data-declared language's client and server facets are composed from its data, with no module of its own", () => {
    const data = acmereadData();
    const agent = data.agent as NonNullable<typeof data.agent>;
    const { text } = agent;
    const answerNotADataRead = `Not a data read ${randomUUID()}.`;
    const client = composeDeclaredClientPack(text);
    const server = composeDeclaredServerPack("acmeread", agent, answerNotADataRead);
    const budget = { rows: "7", seconds: "2.5" };

    expect(client.copy).toEqual({
      subject: text.copy.subject as string,
      noun: text.copy.noun as string,
      argument: "statement",
      writes: text.copy.writes as string,
      reached: text.copy.reached as string,
      defect: text.copy.defect as string,
      adviceKeys: [],
    });
    expect(Object.keys(client.variants)).toEqual(["investigation", "operations"]);
    expect(client.variants.investigation).toEqual({
      tools: ["run_read_query", "compose_report"],
      narrowedExtras: [],
      classifierDescription: text.investigation.classifierDescription as string,
      objective: text.investigation.objective as string,
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: [],
      verifier: "agent-investigation.1",
    });
    expect(client.variants.operations).toBe(OPERATIONS_VARIANT);
    expect(client.planEstimateOperation).toBeNull();
    for (const member of ["evidenceEvents", "shortfallSentences", "readingRefusalHeadlines", "requirements"] as const) {
      expect(client[member]).toEqual({});
    }
    expect(client.posture.reads(BOUNDS)).toEqual({
      qualifier: written(text.posture.qualifier, budget),
      title: written(text.posture.title, budget),
      body: written(text.posture.body, budget),
    });
    expect(client.posture.reads(BOUNDS).qualifier).toContain(" 7 rows, 2.5 s");
    expect(client.posture.handoverTerms(BOUNDS)).toBe(written(text.posture.handover, budget));
    expect(client.posture.widened).toBeUndefined();
    expect(client.posture.plan).toBeUndefined();

    const { adapter } = server;
    expect<string>(adapter.readOperation).toBe("acmeread.query.read");
    expect(adapter.canonicalize).toBe(canonicalText);
    expect(adapter.rowCapAdvice(`any ${randomUUID()}`, "12")).toBe(written(text.advice.rowCap, { allowed: "12" }));
    expect(adapter.shapeAdvice).toBe(text.advice.shape as string);
    expect(adapter.inventoryProblem).toBeUndefined();
    expect(adapter.planDraftIdentifiers).toBeUndefined();
    for (const request of CORPUS)
      expect(adapter.admit?.(request)).toEqual(admitDeclaredRequest(agent.request, request));

    expect(Object.keys(server.toolOverrides)).toEqual(["investigation"]);
    const definition = server.toolOverrides.investigation?.run_read_query;
    expect(definition?.name).toBe("run_read_query");
    expect(definition?.description).toBe(text.investigation.toolDescription as string);
    expect<string | undefined>(definition?.operationId).toBe("acmeread.query.read");
    expect(definition?.inputSchema.safeParse({ statement: '{"read":"topics"}', rationale: "why" }).success).toBe(true);
    for (const refused of [{ statement: "" }, { sql: '{"read":"topics"}' }, { statement: "{}", sql: "x" }, {}]) {
      expect(definition?.inputSchema.safeParse(refused).success).toBe(false);
    }
    expect(server.baseDefinitions).toEqual({});
    expect(server.answerNotADataRead).toBe(answerNotADataRead);
    expect(server.grounding.omissionAdvice).toBe(text.grounding.omissionAdvice as string);
    expect(server.grounding.relations).toBe(false);
    expect(server.grounding.ungrounded?.("d", NOUN)).toBe(
      `d\n${written(text.grounding.ungrounded, { noun: "topic" })}`,
    );
    expect(server.grounding.sampledFields).toBeUndefined();
    expect(server.grounding.planningRules).toBeUndefined();
    expect(server.workflowToolRules).toEqual({
      investigation: text.investigation.toolRule as string,
      operations: OPERATIONS_TOOL_RULE,
    });
    expect(server.shortfallNotices).toEqual({});
    expect(server.catalogAdvice).toBeUndefined();
    expect(server.recommendationCard).toBeUndefined();

    for (const composed of [
      client,
      client.copy,
      client.variants,
      client.variants.investigation,
      client.posture,
      server,
      adapter,
      server.toolOverrides,
      server.toolOverrides.investigation,
      definition,
      server.grounding,
      server.workflowToolRules,
    ]) {
      expect(Object.isFrozen(composed)).toBe(true);
    }
  });

  test("a declared text naming a placeholder Studio does not fill is refused by name", () => {
    // What each text is composed into: one accessor for every text the SDK names, each handed `text`.
    const accessors: Readonly<Record<string, Readonly<Record<string, (text: AgentLanguageText) => string>>>> = {
      copy: {
        subject: (t) => composeDeclaredClientPack(t).copy.subject,
        noun: (t) => composeDeclaredClientPack(t).copy.noun,
        writes: (t) => composeDeclaredClientPack(t).copy.writes,
        reached: (t) => composeDeclaredClientPack(t).copy.reached,
        defect: (t) => composeDeclaredClientPack(t).copy.defect,
      },
      investigation: {
        classifierDescription: (t) =>
          composeDeclaredClientPack(t).variants.investigation?.classifierDescription as string,
        objective: (t) => composeDeclaredClientPack(t).variants.investigation?.objective as string,
        toolDescription: (t) => serverOf(t).toolOverrides.investigation?.run_read_query?.description as string,
        toolRule: (t) => serverOf(t).workflowToolRules.investigation as string,
      },
      posture: {
        qualifier: (t) => composeDeclaredClientPack(t).posture.reads(BOUNDS).qualifier,
        title: (t) => composeDeclaredClientPack(t).posture.reads(BOUNDS).title,
        body: (t) => composeDeclaredClientPack(t).posture.reads(BOUNDS).body,
        handover: (t) => composeDeclaredClientPack(t).posture.handoverTerms(BOUNDS),
      },
      grounding: {
        omissionAdvice: (t) => serverOf(t).grounding.omissionAdvice,
        ungrounded: (t) => serverOf(t).grounding.ungrounded?.("", NOUN).slice(1) as string,
      },
      advice: {
        rowCap: (t) => serverOf(t).adapter.rowCapAdvice("", "12"),
        shape: (t) => serverOf(t).adapter.shapeAdvice as string,
      },
    };
    const studioValues: Readonly<Record<string, string>> = { rows: "7", seconds: "2.5", noun: "topic", allowed: "12" };
    const every = Object.keys(studioValues);

    // The composer fills each text with exactly the values the SDK's table lists for it, and no other.
    expect(Object.keys(accessors)).toEqual(Object.keys(AGENT_TEXT_FILLS));
    for (const [group, texts] of Object.entries(AGENT_TEXT_FILLS)) {
      const fills = texts as Readonly<Record<string, readonly string[]>>;
      expect(Object.keys(accessors[group] as object)).toEqual(Object.keys(fills));
      for (const [name, names] of Object.entries(fills)) {
        const read = (accessors[group] as Record<string, (text: AgentLanguageText) => string>)[name] as (
          text: AgentLanguageText,
        ) => string;
        const marker = randomUUID();
        const filled = withText(group, name, [marker, ...names.flatMap((fill) => ["|", { fill }])]);
        expect(read(filled)).toBe([marker, ...names.map((fill) => `|${studioValues[fill]}`)].join(""));
        for (const other of every.filter((fill) => !names.includes(fill))) {
          expect(() => read(withText(group, name, [marker, { fill: other }]))).toThrow(
            `The agent text names the fill "${other}", which Studio was not handed for it.`,
          );
        }
      }
    }

    // The data such a composer would read is refused before it is composed, by name at the fill's pointer.
    const validator = compileManifestValidator(
      readFileSync(path.join(import.meta.dir, "../../../../packages/provider-sdk/src/manifest/manifest.schema.json")),
    );
    const engine = JSON.parse(
      readFileSync(path.join(import.meta.dir, "../../../../src/lib/db/engine-declarations/kafka.json"), "utf8"),
    );
    engine.agent.statementLanguage = "acmeread";
    engine.statementLanguageData = acmereadData();
    expect(validator.validateEngine(engine).admitted).toBe(true);
    engine.statementLanguageData.agent.text.posture.title = ["Bounded to ", { fill: "allowed" }];
    expect(validator.validateEngine(engine)).toEqual({
      admitted: false,
      refusals: [
        {
          code: "PROVIDER_SCHEMA_INVALID",
          rule: "agent-text-fill-unknown",
          pointer: "/statementLanguageData/agent/text/posture/title/1/fill",
        },
      ],
    });
  });

  test("fillAgentText writes a text's parts as declared, each fill replaced by its value", () => {
    expect(fillAgentText("As written {rows}.", { rows: "7" })).toBe("As written {rows}.");
    expect(fillAgentText(["a", { fill: "rows" }, "b", { fill: "rows" }], { rows: "7" })).toBe("a7b7");
    expect(() => fillAgentText(["a", { fill: "rows" }], {})).toThrow(
      'The agent text names the fill "rows", which Studio was not handed for it.',
    );
    expect(() => fillAgentText([{ fill: "toString" }], {})).toThrow('"toString"');
  });

  test("a declared read's repair identity is one for one read however it is written, and a refused request is identified by its text", () => {
    const form = acmereadForm();
    const { fingerprint } = composeDeclaredServerPack("acmeread", { request: form, text: acmereadText() }, "x").adapter;
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");

    for (const request of CORPUS) {
      const refused = admitDeclaredRequest(form, request) !== null;
      expect({ request, identity: declaredRequestIdentity(form, request) === null }).toEqual({
        request,
        identity: refused,
      });
    }
    expect(declaredRequestIdentity(form, '{"read":"topics"}')).toBe('{"read":"topics","limit":50}');
    expect(declaredRequestIdentity(form, '{"topic":"orders","read":"offsets"}')).toBe(
      '{"read":"offsets","topic":"orders","limit":50}',
    );
    expect(fingerprint('{"read":"topics"}')).toBe(sha('acmeread:{"read":"topics","limit":50}'));

    const alike = [
      ['{"read":"topics"}', '{ "read" : "topics" }'],
      ['{"read":"topics"}', '{"limit":50,"read":"topics"}'],
      ['{"read":"topics","limit":5.0}', '{"read":"topics","limit":5}'],
    ];
    for (const [first, second] of alike) expect(fingerprint(first as string)).toBe(fingerprint(second as string));
    expect(fingerprint('{"read":"topics","limit":49}')).not.toBe(fingerprint('{"read":"topics"}'));

    // Negative zero and zero are one read where the range admits them.
    const signed = acmereadForm();
    const limit = signed.common[0] as (typeof signed.common)[number];
    const widened = { ...signed, common: [{ ...limit, rule: { ...limit.rule, minimum: -5 } }] } as typeof signed;
    expect(declaredRequestIdentity(widened, '{"read":"topics","limit":-0}')).toBe(
      declaredRequestIdentity(widened, '{"read":"topics","limit":0}'),
    );

    // A refused request is identified by its raw text: stable for one text, different for two spellings.
    expect(fingerprint('{"read":"nope"}')).toBe(sha('acmeread-raw:{"read":"nope"}'));
    expect(fingerprint('{"read":"nope"}')).toBe(fingerprint('{"read":"nope"}'));
    expect(fingerprint('{"read":"nope"}')).not.toBe(fingerprint('{ "read":"nope"}'));
    // The language's name is part of the identity.
    const other = composeDeclaredServerPack("acmereadtwo", { request: form, text: acmereadText() }, "x").adapter;
    expect(other.fingerprint('{"read":"topics"}')).not.toBe(fingerprint('{"read":"topics"}'));
  });

  test("the declared statement languages are exactly the data the committed declarations state", () => {
    expect(DECLARED_STATEMENT_LANGUAGES).toHaveLength(0);
    expect(DECLARED_STATEMENT_LANGUAGES).toEqual(shippedLanguageData());
    expect(Object.isFrozen(DECLARED_STATEMENT_LANGUAGES)).toBe(true);
  });
});

/** The server facet composed from `text` and the crafted form. */
function serverOf(text: AgentLanguageText) {
  return composeDeclaredServerPack("acmeread", { request: acmereadForm(), text }, "x");
}

/** The crafted text with its text `group`.`name` replaced by `parts`. */
function withText(group: string, name: string, parts: AgentText): AgentLanguageText {
  const text = acmereadText() as unknown as Record<string, Record<string, AgentText>>;
  (text[group] as Record<string, AgentText>)[name] = parts;
  return text as unknown as AgentLanguageText;
}

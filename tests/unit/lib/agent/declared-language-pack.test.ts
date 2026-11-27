/**
 * A statement language an engine declares as data is composed from its data alone: one engine-neutral composer builds
 * its client facet (src/lib/agent/languages/declared-client.ts), its server facet
 * (src/lib/agent/languages/declared-server.ts) and its MCP facet (src/lib/agent/languages/declared-mcp.ts) from the
 * language's declared text, request form and MCP statement tool, byte for byte as declared, with the members Studio
 * fixes for every declared JSON request language. Read here on the crafted `acmeread`
 * (tests/helpers/declared-agent-language.ts), whose every text carries a marker generated at run time.
 */
import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_MCP_TEXT_FILLS,
  AGENT_TEXT_FILLS,
  type AgentLanguageText,
  type AgentMcpText,
  type AgentText,
  compileManifestValidator,
} from "@libredb/provider-sdk/manifest";
import type { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AGENT_LANGUAGE_COPY, type AgentDeclaredLanguageId } from "@/lib/agent/agent-manifest";
import {
  composeDeclaredClientPack,
  type DeclaredAgentLanguage,
  fillAgentText,
} from "@/lib/agent/languages/declared-client";
import { composeDeclaredMcpFacet, declaredMcpFacets } from "@/lib/agent/languages/declared-mcp";
import { composeDeclaredServerPack } from "@/lib/agent/languages/declared-server";
import { AGENT_LANGUAGE_MCP_FACETS, type AgentLanguageMcpFacet } from "@/lib/agent/languages/mcp";
import { RABBITREAD_MCP_FACET } from "@/lib/agent/languages/rabbitread/mcp";
import { canonicalText, OPERATIONS_TOOL_RULE } from "@/lib/agent/languages/shared";
import { OPERATIONS_VARIANT } from "@/lib/agent/workflow-tool-sets";
import { BUNDLED_STATEMENT_LANGUAGE_DATA } from "@/lib/db/engine-catalog/statement-language.generated";
import { DECLARED_AGENT_LANGUAGES } from "@/lib/agent/languages/client";
import { admitDeclaredRequest, declaredRequestIdentity } from "@/lib/db/operations/declared-request-form";
import { acmereadData, acmereadForm, acmereadMcp, acmereadText } from "../../../helpers/declared-agent-language";
import { shippedStatementLanguages } from "../../../helpers/declared-language-census";

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
  test("a data-declared language's client, server and MCP facets are composed from its data, with no module of its own", () => {
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

    // The MCP facet: the declared tool, flag and words, and the members Studio fixes.
    const mcp = agent.mcp as NonNullable<typeof agent.mcp>;
    const facet = composeDeclaredMcpFacet(agent);
    if (facet?.fence !== "language-admission") throw new Error("acmeread states a tool fenced by its request form");
    expect<string>(facet.tool).toBe("run_acme_read");
    expect(facet.title).toBe(mcp.text.title as string);
    expect(facet.holdsNoTables).toBe(true);
    expect(facet.describe({ engines: "E", limits: "L" })).toBe(
      written(mcp.text.description, { engines: "E", limits: "L" }),
    );
    expect(facet.describe({ engines: "E", limits: "L" })).toEndWith(" Runs on E. L.");
    expect(facet.words.fewerFields).toBe(mcp.text.fewerFields as string);
    expect(facet.words.rowOverCap).toBe(mcp.text.rowOverCap as string);
    expect(facet.words.readPast(12, "max_rows", "x")).toBe(written(mcp.text.readPast, { shown: "12" }));
    expect(facet.words.readPast(12, "result_bytes", "y")).toBe(written(mcp.text.readPast, { shown: "12" }));
    // What a refused request never reached is said once, in the text's copy.
    expect(facet.words.reached).toBe(client.copy.reached);
    expect(issuesOf(facet.statementInput, "")).toEqual([["too_small", "statement cannot be empty"]]);
    expect(issuesOf(facet.statementInput, '{"read":"topics"}')).toEqual([]);
    // Each member Studio fixes is what rabbitread's module states, and what the facet composed from another language's
    // declared data holds, member for member: the out-of-tree fixture's listget, read from its manifest.
    const fixture = JSON.parse(
      readFileSync(path.join(import.meta.dir, "../../../fixtures/out-of-tree-provider/libredb-provider.json"), "utf8"),
    );
    const listget = composeDeclaredMcpFacet(fixture.engines[0].statementLanguageData.agent);
    if (listget === null) throw new Error("the fixture's listget states no MCP statement tool");
    for (const moduleFacet of [listget, RABBITREAD_MCP_FACET] as readonly AgentLanguageMcpFacet[]) {
      for (const member of ["takesDatabase", "strictInput", "paging", "fence"] as const) {
        expect<{ member: string; value: unknown }>({ member, value: facet[member] }).toEqual({
          member,
          value: moduleFacet[member],
        });
      }
      for (const member of ["leastTimeout", "answersWarnings", "withholdsDatabase"]) {
        expect({ member, stated: member in facet }).toEqual({ member, stated: member in moduleFacet });
      }
      for (const value of ["", "x", 5, null]) {
        expect(issuesOf(facet.statementInput, value)).toEqual(issuesOf(moduleFacet.statementInput, value));
      }
    }
    for (const composed of [facet, facet.words]) expect(Object.isFrozen(composed)).toBe(true);
    expect(composeDeclaredMcpFacet({ ...agent, mcp: null })).toBeNull();

    // Every module tool fenced by its language's admission says what a refused statement never reached as its
    // language's copy does, so the composed facet's single source is the one every module language keeps.
    for (const [language, moduleFacet] of Object.entries(AGENT_LANGUAGE_MCP_FACETS)) {
      if (moduleFacet?.fence !== "language-admission") continue;
      const copy = AGENT_LANGUAGE_COPY[language as keyof typeof AGENT_LANGUAGE_COPY];
      expect({ language, reached: moduleFacet.words.reached }).toEqual({ language, reached: copy.reached });
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
      readFileSync(
        path.join(import.meta.dir, "../../../../packages/provider-sdk/tests/fixtures/minimal-manifest.json"),
        "utf8",
      ),
    ).engines[0];
    engine.agent = { statementLanguage: "acmeread", overlay: { dialect: null, grounding: null } };
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

    // The MCP statement tool's texts, by the same rule: each filled with exactly its own values, and the data naming
    // any other refused at the fill's pointer.
    const mcpAccessors: Readonly<Record<string, (text: AgentMcpText) => string>> = {
      title: (t) => mcpFacetOf(t).title,
      description: (t) => mcpFacetOf(t).describe({ engines: "E", limits: "L" }),
      fewerFields: (t) => mcpWordsOf(t).fewerFields,
      readPast: (t) => mcpWordsOf(t).readPast(12, "max_rows", "x"),
      rowOverCap: (t) => mcpWordsOf(t).rowOverCap,
    };
    const mcpValues: Readonly<Record<string, string>> = { engines: "E", limits: "L", shown: "12" };
    const everyValue = [...every, ...Object.keys(mcpValues)];
    expect(Object.keys(mcpAccessors)).toEqual(Object.keys(AGENT_MCP_TEXT_FILLS));
    for (const [name, names] of Object.entries(AGENT_MCP_TEXT_FILLS)) {
      const read = mcpAccessors[name] as (text: AgentMcpText) => string;
      const marker = randomUUID();
      const filled = withMcpText(name, [marker, ...names.flatMap((fill) => ["|", { fill }])]);
      expect(read(filled)).toBe([marker, ...names.map((fill) => `|${mcpValues[fill]}`)].join(""));
      for (const other of everyValue.filter((fill) => !(names as readonly string[]).includes(fill))) {
        expect(() => read(withMcpText(name, [marker, { fill: other }]))).toThrow(
          `The agent text names the fill "${other}", which Studio was not handed for it.`,
        );
      }
    }
    engine.statementLanguageData = acmereadData();
    engine.statementLanguageData.agent.mcp.text.readPast = ["read past ", { fill: "rows" }];
    expect(validator.validateEngine(engine)).toEqual({
      admitted: false,
      refusals: [
        {
          code: "PROVIDER_SCHEMA_INVALID",
          rule: "agent-text-fill-unknown",
          pointer: "/statementLanguageData/agent/mcp/text/readPast/1/fill",
        },
      ],
    });
  });

  test("a declared MCP tool whose name a module language's tool or another declared language's tool holds is refused at load by name", () => {
    const moduleTools = Object.values(AGENT_LANGUAGE_MCP_FACETS).flatMap((facet) =>
      facet === null ? [] : [facet.tool],
    );
    expect(moduleTools).toContain("run_rabbitmq_read");
    expect(moduleTools).toContain("run_read_query");
    const declaring = (id: string, tool: string | null): DeclaredAgentLanguage => {
      const agent = acmereadData().agent as NonNullable<ReturnType<typeof acmereadData>["agent"]>;
      return {
        id: id as AgentDeclaredLanguageId,
        agent: { ...agent, mcp: tool === null ? null : { ...acmereadMcp(), tool } },
      };
    };

    const facets = declaredMcpFacets(
      [declaring("acmeread", "run_acme_read"), declaring("acmeplain", null)],
      moduleTools,
    );
    expect(Object.keys(facets)).toEqual(["acmeread", "acmeplain"]);
    expect<string | undefined>(facets.acmeread?.tool).toBe("run_acme_read");
    expect(facets.acmeplain).toBeNull();
    expect(Object.isFrozen(facets)).toBe(true);
    // Two languages with no tool clash on nothing.
    expect(declaredMcpFacets([declaring("acmeone", null), declaring("acmetwo", null)], moduleTools)).toEqual({
      acmeone: null,
      acmetwo: null,
    });

    for (const tool of ["run_rabbitmq_read", "run_read_query"]) {
      expect(() => declaredMcpFacets([declaring("acmeread", tool)], moduleTools)).toThrow(
        `The MCP statement tool "${tool}" is declared as data and is also a module language's tool of this build.`,
      );
    }
    expect(() =>
      declaredMcpFacets([declaring("acmeread", "run_acme_read"), declaring("acmeother", "run_acme_read")], moduleTools),
    ).toThrow('The MCP statement tool "run_acme_read" is declared as data twice.');
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
    const { fingerprint } = composeDeclaredServerPack(
      "acmeread",
      { request: form, text: acmereadText(), mcp: null },
      "x",
    ).adapter;
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
    const other = composeDeclaredServerPack(
      "acmereadtwo",
      { request: form, text: acmereadText(), mcp: null },
      "x",
    ).adapter;
    expect(other.fingerprint('{"read":"topics"}')).not.toBe(fingerprint('{"read":"topics"}'));
  });

  test("the MCP facet the shipped registry serves for each bundled declared language is the one composed from its committed declaration", () => {
    const declarations = shippedStatementLanguages().filter(({ source }) => source === "declaration");
    let served = 0;
    for (const { id } of DECLARED_AGENT_LANGUAGES) {
      const declared = declarations.find(({ data }) => data.name === id);
      if (declared?.data.agent == null) throw new Error(`no committed declaration states the agent part of ${id}`);
      const composed = composeDeclaredMcpFacet(declared.data.agent);
      const facet = AGENT_LANGUAGE_MCP_FACETS[id];
      expect([id, facet === null ? null : servedShape(facet)]).toEqual([
        id,
        composed === null ? null : servedShape(composed),
      ]);
      if (facet !== null) served += 1;
    }
    // Vacuity: the registry serves some bundled declared language on MCP, so the census compares a facet.
    expect(served).toBeGreaterThan(0);
  });

  test("the declared statement languages are the projection's data, equal to the committed declarations'", () => {
    const projected = Object.values(BUNDLED_STATEMENT_LANGUAGE_DATA).filter((data) => data !== null);
    // The projection is built from the committed declarations alone, so a provider package's language is not in it.
    expect(projected).toEqual(
      shippedStatementLanguages()
        .filter(({ source }) => source === "declaration")
        .map(({ data }) => data),
    );
    // A census pin: the languages the committed declarations state as data, a set that leaves with their engines.
    expect(projected.map(({ name }) => name)).toEqual(["kafkaread"]);
    // The registries compose exactly the projection's languages that state an agent part, in its order.
    expect<readonly string[]>(DECLARED_AGENT_LANGUAGES.map(({ id }) => id)).toEqual(
      projected.filter((data) => data.agent !== null).map(({ name }) => name),
    );
    expect(Object.isFrozen(BUNDLED_STATEMENT_LANGUAGE_DATA)).toBe(true);
  });
});

/** The server facet composed from `text` and the crafted form. */
function serverOf(text: AgentLanguageText) {
  return composeDeclaredServerPack("acmeread", { request: acmereadForm(), text, mcp: null }, "x");
}

/** The `[code, message]` of each issue `schema` finds in `value`, none where it admits the value. */
function issuesOf(schema: z.ZodType, value: unknown): readonly (readonly [string, string])[] {
  return (schema.safeParse(value).error?.issues ?? []).map((issue) => [issue.code, issue.message] as const);
}

/**
 * What an MCP facet serves, written out as data: its members by name, each function member read on fixed values, and
 * its statement input's issues on a few values, so two facets compare member for member.
 */
function servedShape(facet: AgentLanguageMcpFacet) {
  const { describe, statementInput, ...members } = facet;
  const words =
    facet.fence === "language-admission"
      ? {
          ...facet.words,
          readPast: [facet.words.readPast(12, "max_rows", "x"), facet.words.readPast(12, "result_bytes", "y")],
        }
      : null;
  return {
    ...members,
    members: Object.keys(facet).sort(),
    describe: describe({ engines: "E", limits: "L" }),
    statementInput: ["", "x", 5, null].map((value) => issuesOf(statementInput, value)),
    words,
  };
}

/** The MCP facet composed from the crafted agent part with its MCP texts `text`. */
function mcpFacetOf(text: AgentMcpText) {
  const agent = acmereadData().agent as NonNullable<ReturnType<typeof acmereadData>["agent"]>;
  const facet = composeDeclaredMcpFacet({ ...agent, mcp: { ...acmereadMcp(), text } });
  if (facet === null) throw new Error("the crafted agent part states an MCP statement tool");
  return facet;
}

/** The words of the MCP facet composed from the crafted agent part with its MCP texts `text`. */
function mcpWordsOf(text: AgentMcpText) {
  const facet = mcpFacetOf(text);
  if (facet.fence !== "language-admission") throw new Error("a declared tool is fenced by its request form");
  return facet.words;
}

/** The crafted MCP texts with the text `name` replaced by `parts`. */
function withMcpText(name: string, parts: AgentText): AgentMcpText {
  const text = { ...acmereadMcp().text } as unknown as Record<string, AgentText>;
  text[name] = parts;
  return text as unknown as AgentMcpText;
}

/** The crafted text with its text `group`.`name` replaced by `parts`. */
function withText(group: string, name: string, parts: AgentText): AgentLanguageText {
  const text = acmereadText() as unknown as Record<string, Record<string, AgentText>>;
  (text[group] as Record<string, AgentText>)[name] = parts;
  return text as unknown as AgentLanguageText;
}

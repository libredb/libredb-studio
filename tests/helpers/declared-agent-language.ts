/**
 * A crafted statement language an engine declares as data, `acmeread`, for the tests of the agent's composer and of the
 * registries that hold a data-declared language (src/lib/agent/languages/declared-client.ts, declared-server.ts,
 * declared-mcp.ts). Its data is read in place of a shipped declaration's wherever a test plants a language, so this
 * module loads no registry of Studio's: tests/helpers/shipped-declared-language.ts names a shipped declared language.
 *
 * Every string of its text carries a marker generated at run time, so an assertion that finds a text in a composed
 * member finds the declared text and nothing else by accident; each text Studio fills a value into names its fills as
 * parts.
 */
import { randomUUID } from "node:crypto";
import type {
  AgentLanguageText,
  AgentMcpTool,
  AgentRequestForm,
  AgentRequestRefusal,
  StatementLanguageData,
} from "@libredb/provider-sdk/manifest";

/** `label` and a marker generated at run time. */
function marked(label: string): string {
  return `${label} ${randomUUID()}.`;
}

/** A refusal coded `code`, whose sentence carries a generated marker. */
function refusal(code: string): AgentRequestRefusal {
  return { code, sentence: marked(`Refused as ${code}`) };
}

/**
 * The text of `acmeread`: every string marked, the posture's four texts filled with the rows and the seconds, the
 * ungrounded text with the noun and the row-cap advice with the allowed count.
 */
export function acmereadText(): AgentLanguageText {
  return {
    copy: {
      subject: marked("subject"),
      noun: marked("noun"),
      writes: marked("writes"),
      reached: marked("reached"),
      defect: marked("defect"),
    },
    investigation: {
      classifierDescription: marked("classifier"),
      objective: marked("objective"),
      toolDescription: marked("tool"),
      toolRule: marked("rule"),
    },
    posture: {
      qualifier: [marked("qualifier"), " ", { fill: "rows" }, " rows, ", { fill: "seconds" }, " s"],
      title: [marked("title"), " ", { fill: "rows" }],
      body: [marked("body"), " ", { fill: "rows" }, " rows and ", { fill: "seconds" }, " seconds each."],
      handover: [marked("handover"), " ", { fill: "seconds" }, " seconds."],
    },
    grounding: {
      omissionAdvice: marked("omission"),
      ungrounded: [marked("ungrounded"), " Not one ", { fill: "noun" }, " name."],
    },
    advice: {
      rowCap: [marked("rowCap"), ' Write "limit": ', { fill: "allowed" }, " or less."],
      shape: marked("shape"),
    },
  };
}

/**
 * The request form of `acmeread`: a JSON object naming one of two reads by `read`, with an optional `limit` of 1 to 500
 * whose default is 50; `topics` refuses a `topic`, and `offsets` requires one, a name of lower-case letters.
 */
export function acmereadForm(): AgentRequestForm {
  return {
    kind: "json-object",
    maxCharacters: 256,
    refusals: {
      tooLong: refusal("too-long"),
      empty: refusal("empty"),
      notAnObject: refusal("not-an-object"),
      repeatedKey: refusal("repeated-key"),
      unknownKey: refusal("unknown-key"),
    },
    keys: ["read", "topic", "limit"],
    selector: { key: "read", refusal: refusal("not-a-read") },
    common: [
      {
        key: "limit",
        absent: null,
        rule: { kind: "integer", minimum: 1, maximum: 500, default: 50, refusal: refusal("limit") },
      },
    ],
    reads: [
      { value: "topics", refuses: [{ key: "topic", refusal: refusal("topic-not-taken") }], checks: [] },
      {
        value: "offsets",
        refuses: [],
        checks: [
          {
            key: "topic",
            absent: refusal("topic-required"),
            rule: {
              kind: "name",
              characters: [{ from: "a", to: "z" }],
              minLength: 1,
              maxLength: 64,
              refused: [],
              refusal: refusal("topic"),
            },
          },
        ],
      },
    ],
  };
}

/**
 * The MCP statement tool of `acmeread`, `run_acme_read`: every string marked, the description filled with the engines
 * and the limits and the way past a cut result with the rows shown. Its engines hold no table, so inspect_schema points
 * to it.
 */
export function acmereadMcp(): NonNullable<AgentMcpTool> {
  return {
    tool: "run_acme_read",
    holdsNoTables: true,
    text: {
      title: marked("mcpTitle"),
      description: [marked("mcpDescription"), " Runs on ", { fill: "engines" }, ". ", { fill: "limits" }, "."],
      fewerFields: marked("fewerFields"),
      readPast: ["read past the ", { fill: "shown" }, " rows returned, ", marked("readPast")],
      rowOverCap: marked("rowOverCap"),
    },
  };
}

/** The statement language data `name` states: a request language naming no operation, with `acmeread`'s agent part. */
export function acmereadData(name = "acmeread"): NonNullable<StatementLanguageData> {
  return {
    name,
    confirmation: {
      operations: [],
      reader: "names-no-operation",
      decidesAlone: true,
      safetyAnalysis: false,
      maxTextBytes: null,
    },
    agent: { request: acmereadForm(), text: acmereadText(), mcp: acmereadMcp() },
  };
}

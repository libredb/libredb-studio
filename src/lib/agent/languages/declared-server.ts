/**
 * The server facet of a statement language an engine declares as data, composed from the language's declared request
 * form and text, so the language needs no module of its own. Its client facet is `declared-client.ts`'s. It reaches
 * `node:crypto`, so it is server only.
 *
 * Studio fixes everything a declared JSON request language's server facet holds besides its words and its form: its
 * read operation is `<language>.query.read`, read by the one generic descriptor
 * (`src/lib/db/operations/declared-language-read.ts`); a model's argument is its text as written (`canonicalText`); a
 * request is admitted by core's one admission of the declared form (`admitDeclaredRequest`); its repair identity is the
 * SHA-256 of `<language>:` and the admitted request's identity (`declaredRequestIdentity`), or of `<language>-raw:` and
 * the text where the form refuses it; it overrides only the investigation's `run_read_query`, whose input is a strict
 * object of a non-empty `statement` and an optional `rationale`, and defines no tool of its own; a plan or a profile
 * is answered with Studio's `ANSWER_NOT_A_DATA_READ`, which its caller hands in; its grounding draws no relation and
 * joins the reason a run is ungrounded and the declared text with a newline; its workflow rules are the declared
 * investigation rule and Studio's `OPERATIONS_TOOL_RULE`; and it has no shortfall notice.
 */
import { createHash } from "node:crypto";
import type { StatementLanguageAgent } from "@libredb/provider-sdk/manifest";
import { z } from "zod";
import { admitDeclaredRequest, declaredRequestIdentity } from "@/lib/db/operations/declared-request-form";
import type { AgentInventoryNoun } from "../inventory-noun";
import type { AgentToolDefinition } from "../tools";
import { filledText } from "./declared-client";
import type { AgentDeclaredReadOperation, AgentLanguageServerPack } from "./pack";
import { canonicalText, OPERATIONS_TOOL_RULE } from "./shared";

/** The investigation's statement: one request, and why the model wrote it, accepted and not recorded. */
const DECLARED_STATEMENT_INPUT = z.strictObject({
  statement: z.string().min(1),
  rationale: z.string().optional(),
});

/**
 * The server facet of the declared language `name` whose agent part is `agent`, frozen, answering a plan or a profile
 * with `answerNotADataRead`.
 */
export function composeDeclaredServerPack(
  name: string,
  agent: NonNullable<StatementLanguageAgent>,
  answerNotADataRead: string,
): AgentLanguageServerPack {
  const { request: form, text } = agent;
  const readOperation = `${name}.query.read` as AgentDeclaredReadOperation;
  const runReadQuery: AgentToolDefinition = Object.freeze({
    name: "run_read_query",
    description: filledText(text, "investigation", "toolDescription", {}),
    inputSchema: DECLARED_STATEMENT_INPUT,
    operationId: readOperation,
  });
  return Object.freeze({
    adapter: Object.freeze({
      readOperation,
      canonicalize: canonicalText,
      fingerprint: (statement: string) => {
        const identity = declaredRequestIdentity(form, statement);
        const canonical = identity === null ? `${name}-raw:${statement}` : `${name}:${identity}`;
        return createHash("sha256").update(canonical).digest("hex");
      },
      rowCapAdvice: (_statement: string, allowed: string) => filledText(text, "advice", "rowCap", { allowed }),
      admit: (statement: string) => admitDeclaredRequest(form, statement),
      shapeAdvice: filledText(text, "advice", "shape", {}),
    }),
    toolOverrides: Object.freeze({ investigation: Object.freeze({ run_read_query: runReadQuery }) }),
    baseDefinitions: Object.freeze({}),
    answerNotADataRead,
    grounding: Object.freeze({
      omissionAdvice: filledText(text, "grounding", "omissionAdvice", {}),
      relations: false,
      ungrounded: (detail: string, noun: AgentInventoryNoun) =>
        `${detail}\n${filledText(text, "grounding", "ungrounded", { noun: noun.singular })}`,
    }),
    workflowToolRules: Object.freeze({
      investigation: filledText(text, "investigation", "toolRule", {}),
      operations: OPERATIONS_TOOL_RULE,
    }),
    shortfallNotices: Object.freeze({}),
  } satisfies AgentLanguageServerPack);
}

/**
 * The read operation of a statement language an engine declares as data: one generic descriptor, built from the
 * language's data alone, whose id is `<language>.query.read`, the id a language's read has always had, so the audit
 * action, the policy and the MCP answers keep naming it as they did.
 *
 * Its facts are those of every model-written statement read: R1, a data read, heavy, a statement the model writes, no
 * dry run, no approval and no capability required. Its input is one statement, admitted by the language's declared
 * request form through core's one admission (./declared-request-form), whose refusal is the declared sentence at the
 * path `statement`; the object is strict, so a stray `sql` key is refused.
 *
 * The verification marker is one engine-neutral constant, the same for every declared language: no code reads a
 * descriptor's boundary text, and the review of each engine's boundary is its grant register row, which reviews the
 * language data by its digest.
 */
import type { StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { z } from "zod";
import { admitDeclaredRequest } from "./declared-request-form";
import type { RegistrableOperationDescriptor } from "./types";

/** The verification marker of every data-declared language's read. */
const DECLARED_LANGUAGE_VERIFICATION = Object.freeze({
  reviewedBy: "Declared statement language admission review (#2585)",
  boundary:
    "A data-declared statement language: the provider reads every request with its own reader before it sends " +
    "anything, and the engine's structural boundary bounds what it sends; the engine's grant register row reviewed " +
    "that boundary together with the digest of the language data. The declared request form is the agent's " +
    "admission, which tells the model why a request was refused before anything is sent, not the boundary.",
  verifiedOn: "2026-11-27",
});

/**
 * The read operation of the statement language `data` states.
 *
 * @throws {Error} Naming the language, for data with no agent part, since agent mode sends such a language nothing.
 */
export function declaredLanguageReadDescriptor(
  data: NonNullable<StatementLanguageData>,
): RegistrableOperationDescriptor {
  const { agent } = data;
  if (agent === null) {
    throw new Error(
      `The statement language ${data.name} states no agent part, so agent mode sends it no statement to read.`,
    );
  }
  const form = agent.request;
  return {
    id: `${data.name}.query.read`,
    riskClass: 1,
    accessLevel: "data-read",
    requiredCapabilities: [],
    resourceCost: "heavy",
    supportsDryRun: false,
    requiresApproval: false,
    modelStatement: true,
    inputSchema: z
      .strictObject({ statement: z.string().min(1).max(form.maxCharacters) })
      .superRefine((value, context) => {
        const refusal = admitDeclaredRequest(form, value.statement);
        if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
      }),
    verification: DECLARED_LANGUAGE_VERIFICATION,
  };
}

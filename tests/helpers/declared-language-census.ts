/**
 * The census of a statement language some engine declares as data: the declared request form, read by core's one
 * engine-neutral admission (src/lib/db/operations/declared-request-form.ts), and the provider's own reader, which reads
 * every request before it sends anything, must answer every request of a corpus alike, admitted or refused with the
 * same code and the same sentence. The form is the agent's admission and the reader is the provider's, so a form that
 * drifted from its reader would tell the model one thing and the engine another; the census names every such
 * request instead.
 *
 * `READER_ENROLLMENTS` names each language's reader and corpus by the language's name. A language enters it in the same
 * change that makes a shipped declaration state the language's agent part, and the declared language admission test
 * (tests/unit/lib/agent/declared-language-admission.test.ts) holds the two sets equal, so no shipped form goes
 * uncensused.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRequestForm, StatementLanguageData } from "@libredb/provider-sdk/manifest";
import { admitDeclaredRequest, type DeclaredRequestRefusal } from "@/lib/db/operations/declared-request-form";

/** What a provider's reader answers for one request: admitted, or refused with a code and a sentence. */
export type ProviderReading =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A provider's own reader of a request in its language. */
export type ProviderReader = (text: string) => ProviderReading;

/** A language's reader and the requests the census reads it over. */
export interface ReaderEnrollment {
  readonly reader: ProviderReader;
  readonly corpus: readonly string[];
}

/** Each language a shipped declaration states an agent part for, by name: its reader and its corpus. */
export const READER_ENROLLMENTS: ReadonlyMap<string, ReaderEnrollment> = new Map();

const DECLARATIONS = path.join(import.meta.dir, "../../src/lib/db/engine-declarations");

/** The statement language data every shipped declaration states, the null ones left out, in file name order. */
export function shippedLanguageData(): NonNullable<StatementLanguageData>[] {
  return readdirSync(DECLARATIONS)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) =>
        (
          JSON.parse(readFileSync(path.join(DECLARATIONS, file), "utf8")) as {
            statementLanguageData: StatementLanguageData;
          }
        ).statementLanguageData,
    )
    .filter((data): data is NonNullable<StatementLanguageData> => data !== null);
}

/** One answer in words: admitted, or the code and the sentence it was refused with. */
function described(answer: DeclaredRequestRefusal | null): string {
  return answer === null ? "admitted" : `refused ${answer.code} ${JSON.stringify(answer.message)}`;
}

/**
 * One line for each request of `corpus` that the declared form of `language` and `reader` answer differently, naming
 * the language, the request as a JSON string and both answers; empty where they agree on every request. A request
 * longer than the form's bound is passed over: that refusal is the agent's own, which the reader never meets.
 */
export function censusDisagreements(
  language: string,
  form: AgentRequestForm,
  reader: ProviderReader,
  corpus: Iterable<string>,
): string[] {
  const lines: string[] = [];
  for (const text of corpus) {
    if (text.length > form.maxCharacters) continue;
    const declared = admitDeclaredRequest(form, text);
    const reading = reader(text);
    const read = reading.ok ? null : { code: reading.code, message: reading.message };
    if (described(declared) !== described(read)) {
      lines.push(
        `${language}: ${JSON.stringify(text)} is ${described(declared)} by the declared form and ${described(read)} by the provider's reader`,
      );
    }
  }
  return lines;
}

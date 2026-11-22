/**
 * The one core scrub of a provider's text on the agent, hand-over and MCP paths.
 *
 * A provider scrubs the server's text at its own entry with `serverText` (src/lib/db/utils/server-text.ts); this is
 * the pass core runs after it, over every error, warning and notice text a provider hands core on those paths,
 * before any fence, prompt, ledger row, response or log line. It reads the calling connection's own secret-class
 * values through the central walk (`secretFieldValues`) and expands them with `secretForms`. A text holding any form is
 * replaced whole by `PROVIDER_TEXT_WITHHELD`, matched exactly as `serverText` matches (`holdsSecretForm`).
 *
 * What it does not catch, stated in docs/AGENT_DATA_FLOW.md: a secret that is part of a field's value rather than
 * the whole of it, an echo in a different case, and database content, which is never scrubbed.
 *
 * It also says who wrote a refusal: `providerAuthor` names the provider for a fence or a notice, and
 * `isStudioRefusal` tells Studio's own refusals apart by class, never by text or code.
 */
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import {
  AuthenticationError,
  ProviderTextWithheldError,
  QueryError,
  ReadAllowanceExceededError,
  StudioProfileRefusal,
} from "@/lib/db/errors";
import { holdsSecretForm, secretForms } from "@/lib/db/utils/server-text";
import { type SecretFieldRecord, secretFieldValues } from "@/lib/storage/secret-fields";
import type { DatabaseType, QueryResult, QueryWarning } from "@/lib/types";

/** Replaces a provider's text whole when it holds a credential of the calling connection; it echoes none of it. */
export const PROVIDER_TEXT_WITHHELD =
  "(Studio withheld this text because it contained a credential of this connection)";

/** The forms of one connection's secret-class values, computed once per call site, and the connection's type. */
export interface ProviderTextScrub {
  readonly type: DatabaseType;
  readonly forms: readonly string[];
}

/** The scrub of one connection: its secret-class values and their forms. */
export function providerTextScrub(connection: SecretFieldRecord): ProviderTextScrub {
  const values: string[] = [];
  for (const value of Object.values(secretFieldValues(connection))) {
    values.push(value);
  }
  return { type: connection.type, forms: secretForms(values) };
}

/** The text itself, or `PROVIDER_TEXT_WITHHELD` when it holds any form of the connection's credential. */
export function scrubProviderText(scrub: ProviderTextScrub, text: string): string {
  return holdsSecretForm(text, scrub.forms) ? PROVIDER_TEXT_WITHHELD : text;
}

/** Each warning with its message, a string code and its severity scrubbed; a numeric code is kept. */
export function scrubProviderWarnings(scrub: ProviderTextScrub, warnings: readonly QueryWarning[]): QueryWarning[] {
  return warnings.map((warning) => {
    const scrubbed: QueryWarning = { ...warning, message: scrubProviderText(scrub, warning.message) };
    if (typeof warning.code === "string") scrubbed.code = scrubProviderText(scrub, warning.code);
    if (warning.severity !== undefined) scrubbed.severity = scrubProviderText(scrub, warning.severity);
    return scrubbed;
  });
}

/** The same result when it carries no warnings, otherwise a copy whose warnings are scrubbed. */
export function withScrubbedWarnings(scrub: ProviderTextScrub, result: QueryResult): QueryResult {
  if (result.warnings === undefined) return result;
  return { ...result, warnings: scrubProviderWarnings(scrub, result.warnings) };
}

/** Every text a renderer reads from an error: its name, message and stack, a QueryError's detail, a fix statement. */
function renderedTexts(error: Error): string[] {
  const texts = [error.name, error.message, error.stack ?? ""];
  if (error instanceof QueryError && error.detail !== undefined) texts.push(error.detail);
  if (error instanceof AuthenticationError && error.fixStatement !== undefined) texts.push(error.fixStatement);
  return texts;
}

/**
 * For an error leaving core to a renderer that does not hold the connection (an error response, a route's log line):
 * the same error when none of the texts a renderer reads holds a form, otherwise a `ProviderTextWithheldError` naming
 * the connection's type. The error given is never changed, because providers throw shared instances.
 */
export function withholdProviderError(scrub: ProviderTextScrub, error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (!renderedTexts(error).some((text) => holdsSecretForm(text, scrub.forms))) return error;
  return new ProviderTextWithheldError(PROVIDER_TEXT_WITHHELD, scrub.type);
}

/** The author a fence or a notice names for a provider's own text: the engine's form label, bundled with Studio. */
export function providerAuthor(type: DatabaseType): string {
  return `${CONNECTION_FORM[type].label} provider, bundled with Studio`;
}

/** Whether a refusal is Studio's own: the two classes only core constructs. */
export function isStudioRefusal(error: unknown): boolean {
  return error instanceof ReadAllowanceExceededError || error instanceof StudioProfileRefusal;
}

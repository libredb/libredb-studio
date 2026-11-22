/**
 * The one core scrub of a provider's text on the agent, hand-over and MCP paths, the editor's query, script and
 * transaction routes, the connection test and the VS Code extension's backend child.
 *
 * A provider scrubs the server's text at its own entry with `serverText` (src/lib/db/utils/server-text.ts); this is
 * the pass core runs after it, over every error, warning and notice text a provider hands core on those paths,
 * before any fence, prompt, ledger row, response or log line. It reads the secret-class values of the calling
 * connection that its providers receive (`ScrubbedProviders`) through the central walk (`secretFieldValues`) and
 * expands them with `secretForms`. A text holding any form is
 * replaced whole by `PROVIDER_TEXT_WITHHELD`, matched exactly as `serverText` matches (`holdsSecretForm`).
 *
 * What it does not catch, stated in docs/AGENT_DATA_FLOW.md: a secret that is part of a field's value rather than
 * the whole of it, an echo in a different case, and database content, which is never scrubbed.
 *
 * It also says who wrote a refusal: `providerAuthor` names the provider for a fence or a notice, and
 * `isStudioRefusal` tells Studio's own refusals apart by class, never by text or code. And it is the only builder of
 * an error's full record (`errorRecord`), whose string fields therefore never hold a form, and which keeps the
 * error's own kind, code and outcome when its text is withheld.
 */
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { type ErrorRecord, errorCode, errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  AuthenticationError,
  DatabaseError,
  ProviderTextWithheldError,
  QueryError,
  ReadAllowanceExceededError,
  StudioByteBudgetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
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

/**
 * Which providers of a connection a scrub covers, so it holds only the values those providers receive: a value a
 * provider never received is no credential of its own text, and is left out.
 * - `"profiled"`: a provider `acquireExecutionProfileProvider` builds, the statement paths' (the agent's tools, the
 *   hand-over, MCP). Where the connection configures an agent password the factory hands that provider the agent
 *   password in place of the connection's own (`resolveAgentCredential`), so the connection's own is left out.
 * - `"any"`: every provider core builds for the connection, the editor's handle and a capability read included, so
 *   the connection's own password is kept beside the agent's.
 * Neither covers the SSH tunnel's secrets: `providerConnection` strips them before any provider is built.
 */
export type ScrubbedProviders = "profiled" | "any";

/** Whether a secret path holds a value the providers `reach` names receive. */
function providerReceives(connection: SecretFieldRecord, path: string, reach: ScrubbedProviders): boolean {
  if (path.startsWith("sshTunnel.")) return false;
  if (reach === "profiled" && path === "password") return !connection.agentPassword;
  return true;
}

/** The scrub of one connection's providers: the secret-class values they receive and their forms. */
export function providerTextScrub(connection: SecretFieldRecord, reach: ScrubbedProviders): ProviderTextScrub {
  const values: string[] = [];
  for (const [path, value] of Object.entries(secretFieldValues(connection))) {
    if (!providerReceives(connection, path, reach)) continue;
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

/**
 * The lines of a stack before its first frame line: the name and the message as the stack was built, which still
 * shows a message changed after construction. The frame lines are code locations no provider writes (a deployment
 * path, a chunk name, a line and column), so a credential that happens to occur in one is not the error's text.
 */
function stackHeader(stack: string): string {
  const lines = stack.split("\n");
  const firstFrame = lines.findIndex((line) => /^\s+at /.test(line));
  return (firstFrame === -1 ? lines : lines.slice(0, firstFrame)).join("\n");
}

/**
 * Every text a renderer reads from a thrown value: an error's name, message and stack header, a QueryError's detail,
 * a fix statement, and a database error's SQLSTATE, which its error record carries; anything else as
 * `String(value)`, which is how the logger renders it.
 */
function renderedTexts(error: unknown): string[] {
  if (!(error instanceof Error)) return [String(error)];
  const texts = [error.name, error.message, stackHeader(error.stack ?? "")];
  if (error instanceof DatabaseError && error.sqlstate !== undefined) texts.push(error.sqlstate);
  if (error instanceof QueryError && error.detail !== undefined) texts.push(error.detail);
  if (error instanceof AuthenticationError && error.fixStatement !== undefined) texts.push(error.fixStatement);
  return texts;
}

/** The message of the error `withholdProviderError` answers in place of one of class `replaced`. */
export function withheldErrorMessage(replaced: string): string {
  return `(Studio withheld the text of this ${replaced} because it contained a credential of this connection)`;
}

/**
 * The class of the error `withholdProviderError` replaced, for its message: code identity, not provider text, so an
 * operator still reads what failed. A name that itself holds a form is not named.
 */
function replacedClass(scrub: ProviderTextScrub, error: unknown): string {
  if (!(error instanceof Error)) return `thrown ${typeof error}`;
  return holdsSecretForm(error.name, scrub.forms) ? "error" : error.name;
}

/**
 * The one detection over a thrown value leaving core: `null` when none of the texts a renderer reads holds a form,
 * otherwise a `ProviderTextWithheldError` naming the connection's type, whose message names the class it replaced and
 * says its text was withheld, and which keeps the replaced error's `outcome`: whether a statement reached the database
 * is no text of the error. The value given is never changed, because providers throw shared instances.
 */
export function withheldProviderError(scrub: ProviderTextScrub, error: unknown): ProviderTextWithheldError | null {
  if (!renderedTexts(error).some((text) => holdsSecretForm(text, scrub.forms))) return null;
  const withheld = new ProviderTextWithheldError(withheldErrorMessage(replacedClass(scrub, error)), scrub.type);
  if (errorOutcome(error) === "not-sent") withheld.outcome = "not-sent";
  return withheld;
}

/**
 * For a thrown value leaving core to a renderer that does not hold the connection (the agent paths' error response, a
 * log line): the withheld error `withheldProviderError` answers, or the same value when it answers `null`.
 */
export function withholdProviderError(scrub: ProviderTextScrub, error: unknown): unknown {
  return withheldProviderError(scrub, error) ?? error;
}

/**
 * The error record of a thrown value (src/lib/db/error-record.ts). `kind`, `code` and `outcome` are closed
 * vocabularies and always the error's own, so a reader branches on what failed whether or not its text was withheld.
 * `sqlState` is the only string field an error carries today; `renderedTexts` reads it, and the record carries it only
 * when `withheldProviderError` answers `null`, so a credential in any text the error holds leaves it out.
 */
export function errorRecord(scrub: ProviderTextScrub, error: unknown): ErrorRecord {
  const sqlState =
    error instanceof DatabaseError && withheldProviderError(scrub, error) === null ? error.sqlstate : undefined;
  return {
    kind: errorKind(error),
    code: errorCode(error),
    ...(sqlState === undefined ? {} : { sqlState }),
    outcome: errorOutcome(error),
  };
}

/** The author a fence or a notice names for a provider's own text: the engine's form label, bundled with Studio. */
export function providerAuthor(type: DatabaseType): string {
  return `${CONNECTION_FORM[type].label} provider, bundled with Studio`;
}

/**
 * Whether a refusal is Studio's own: the six classes only core constructs. `ReadAllowanceExceededError` (the run's
 * read allowance, before sending) and `StudioProfileRefusal` (an execution profile refusal) come before a statement is
 * sent; `StudioRowBudgetRefusal`, `StudioByteBudgetRefusal` and `StudioTimeBudgetRefusal` (core's row, byte and time
 * refusals of an answer) and `StudioTimeoutRefusal` (the agent's statistics read outlasting its time) come after.
 */
export function isStudioRefusal(error: unknown): boolean {
  return (
    error instanceof ReadAllowanceExceededError ||
    error instanceof StudioProfileRefusal ||
    error instanceof StudioRowBudgetRefusal ||
    error instanceof StudioByteBudgetRefusal ||
    error instanceof StudioTimeBudgetRefusal ||
    error instanceof StudioTimeoutRefusal
  );
}

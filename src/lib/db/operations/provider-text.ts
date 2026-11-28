/**
 * The one core scrub of a provider's text on the agent, hand-over and MCP paths, every database route that resolves the
 * calling connection and reaches its provider, the object routes, the fleet health check, the query events those
 * routes record, the provider factory's log lines about a provider's or a tunnel's failure and the VS Code extension's
 * backend child.
 *
 * A provider scrubs the server's text at its own entry with `serverText` (src/lib/db/utils/server-text.ts); this is
 * the pass core runs after it, over every error, warning and notice text a provider hands core on those paths, and over
 * the sentences an object read answers in a provider's words (`scrubKindCounts`, `scrubObjectDetail`, which read them
 * under the record's grant of a package's own words, `providerSentence`, and `scrubSourceDocument`) and a success answer writes in them (`scrubMonitoringData`, `scrubMaintenanceResult`,
 * `scrubMaintenancePreview`, `scrubKeyScanPage`, and an object edit's `scrubObjectEditRefusal`, `scrubObjectEditPlan`,
 * `scrubObjectEditPreimage` and `scrubObjectEditOutcome`), before any fence, prompt, ledger row, response or log line.
 * A code a record keeps goes through `recordedProviderCode`. It reads the secret-class values
 * of the calling connection that its providers receive (`ScrubbedProviders`) through the central walk
 * (`secretFieldValues`) and expands them with `secretForms`. A text holding any form is replaced whole by
 * `PROVIDER_TEXT_WITHHELD`, matched exactly as `serverText` matches (`holdsSecretForm`).
 *
 * What it does not catch, stated in docs/AGENT_DATA_FLOW.md: a secret that is part of a field's value rather than
 * the whole of it, an echo in a different case, and database content, which is never scrubbed.
 *
 * It also says who wrote a refusal: `providerAuthor` names the provider for a fence or a notice, and
 * `isStudioRefusal` tells Studio's own refusals apart by class, never by text or code. And it is the only builder of
 * an error's full record (`errorRecord`), whose string fields therefore never hold a form, and which keeps the
 * error's own kind, code and outcome when its text is withheld.
 */
import type { MaintenanceRunAnswer } from "@libredb/provider-sdk/calls";
import { CONNECTION_FORM } from "@/lib/db/connection-form";
import { type ErrorRecord, errorCode, errorKind, errorOutcome } from "@/lib/db/error-record";
import {
  AuthenticationError,
  DatabaseError,
  ProviderTextWithheldError,
  QueryError,
  ReadAllowanceExceededError,
  StudioByteBudgetRefusal,
  StudioObjectModelRefusal,
  StudioOffsetRefusal,
  StudioProfileRefusal,
  StudioRowBudgetRefusal,
  StudioTimeBudgetRefusal,
  StudioTimeoutRefusal,
} from "@/lib/db/errors";
import {
  isCountSampled,
  isCountUnavailable,
  isIndexesUnavailable,
  isSourcePartUnavailable,
} from "@/lib/db/object-kinds";
import type { EngineRecord } from "@/lib/db/server-catalog";
import { holdsSecretForm, secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import { type SecretFieldRecord, secretFieldValues } from "@/lib/storage/secret-fields";
import type {
  KeyScanPage,
  KindCount,
  MaintenancePreview,
  MonitoringData,
  ObjectDetail,
  ObjectEditOutcome,
  ObjectEditPlan,
  ObjectEditPreimage,
  ObjectEditRefusal,
  ObjectEditRevision,
  ObjectSourceDocument,
  ObjectSourcePart,
} from "@/lib/db/types";
import type { DatabaseType, QueryResult, QueryWarning } from "@/lib/types";

/** Replaces a provider's text whole when it holds a credential of the calling connection; it echoes none of it. */
export const PROVIDER_TEXT_WITHHELD =
  "(Studio withheld this text because it contained a credential of this connection)";

/**
 * The forms of one connection's secret-class values, computed once per call site, and the connection's type when its
 * engine's record offers a legacy provider, which the withheld error names its provider by.
 */
export interface ProviderTextScrub {
  readonly type: DatabaseType | undefined;
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
export function providerTextScrub(
  connection: SecretFieldRecord & { readonly type: DatabaseType },
  reach: ScrubbedProviders,
): ProviderTextScrub {
  return connectionTextScrub(connection, connection.type, reach);
}

/**
 * The scrub of a connection of any engine the server serves, `providerTextScrub`'s reading of its fields: `type` is the
 * engine's id as the published `DatabaseType` when its record offers a legacy provider (`legacyProviderType` in
 * ../server-catalog), and undefined for a provider package's engine, whose withheld error then names no provider.
 */
export function connectionTextScrub(
  connection: SecretFieldRecord,
  type: DatabaseType | undefined,
  reach: ScrubbedProviders,
): ProviderTextScrub {
  const values: string[] = [];
  for (const [path, value] of Object.entries(secretFieldValues(connection))) {
    if (!providerReceives(connection, path, reach)) continue;
    values.push(value);
  }
  return { type, forms: secretForms(values) };
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
 * How a provider's sentences in a success answer reach the client (docs/providers/CONTRACT.md, clause C-112): core's
 * scrub of the connection, how the engine's record grants its own words (`grants.ownWords`, the register row's grant;
 * a legacy engine's row grants `"scrubbed"`), and the route a sentence Studio withholds is logged under.
 */
export interface ProviderWords {
  readonly scrub: ProviderTextScrub;
  readonly ownWords: EngineRecord["grants"]["ownWords"];
  readonly route: string;
}

/** Studio's sentence in place of a provider package's own sentence in an answer, where its record grants no words. */
export const PACKAGE_SENTENCE_WITHHELD = "The provider package gave a reason; the server's log holds its words.";

/**
 * A sentence a provider wrote in an answer, as the client receives it under `words`: through core's scrub where the
 * record grants the engine its own words (`"scrubbed"`), and otherwise Studio's sentence, `PACKAGE_SENTENCE_WITHHELD`,
 * the words logged once under the route through core's scrub. A name, a path, a kind and a flag of an answer are data,
 * never read here.
 */
export function providerSentence(words: ProviderWords, text: string): string {
  if (words.ownWords === "scrubbed") return scrubProviderText(words.scrub, text);
  logger.warn("A provider package's answer gave a reason", {
    route: words.route,
    reason: scrubProviderText(words.scrub, text),
  });
  return PACKAGE_SENTENCE_WITHHELD;
}

/**
 * The counts of an object count read with each `unavailable` and `sampledFrom` sentence read under `words`
 * (`providerSentence`): a provider writes them in its own words. Every count is kept, and the value given is not
 * changed. Each count's arm is read by its member's value (`isCountUnavailable`, `isCountSampled`): a member present
 * with no value reads as absent (docs/providers/CONTRACT.md, clause C-62).
 */
export function scrubKindCounts(
  words: ProviderWords,
  counts: Readonly<Record<string, KindCount>>,
): Record<string, KindCount> {
  return Object.fromEntries(
    Object.entries(counts).map(([kind, count]): [string, KindCount] => {
      if (isCountUnavailable(count)) return [kind, { unavailable: providerSentence(words, count.unavailable) }];
      if (isCountSampled(count)) {
        return [kind, { count: count.count, sampledFrom: providerSentence(words, count.sampledFrom) }];
      }
      return [kind, count];
    }),
  );
}

/**
 * An object's description with its `indexes.unavailable` sentence read under `words` (`providerSentence`), the
 * provider's own words; a description whose indexes are a list is answered as given. Columns, keys and the path are
 * database content, never scrubbed.
 */
export function scrubObjectDetail(words: ProviderWords, detail: ObjectDetail): ObjectDetail {
  if (!isIndexesUnavailable(detail.indexes)) return detail;
  return { ...detail, indexes: { unavailable: providerSentence(words, detail.indexes.unavailable) } };
}

/**
 * One source part with its refusal, truncation and refused edit sentences scrubbed; its text is database content. Its
 * form is read by the value of its `unavailable`, as the host core's check read it (`isSourcePartUnavailable`).
 */
function scrubSourcePart(scrub: ProviderTextScrub, part: ObjectSourcePart): ObjectSourcePart {
  if (isSourcePartUnavailable(part)) return { ...part, unavailable: scrubProviderText(scrub, part.unavailable) };
  return {
    ...part,
    ...(part.truncated === undefined
      ? {}
      : { truncated: { limit: part.truncated.limit, reason: scrubProviderText(scrub, part.truncated.reason) } }),
    ...(part.edit === undefined || part.edit.offered
      ? {}
      : { edit: { offered: false, reason: scrubProviderText(scrub, part.edit.reason) } }),
  };
}

/**
 * A source document with each part's `unavailable`, `truncated.reason` and refused `edit.reason` scrubbed, the
 * provider's own sentences. A part's text, label and statement flag and an offered edit are kept, and `parts` stays a
 * non-empty tuple in the same order.
 *
 * The source route scrubs the document the host core's source call checked and cut (`sourceCall` in
 * src/lib/provider-host/core/objects.ts), which holds at least one part, each in the form the check read it.
 */
export function scrubSourceDocument(scrub: ProviderTextScrub, document: ObjectSourceDocument): ObjectSourceDocument {
  // Destructured rather than mapped, because `parts` is a non-empty tuple and `Array.prototype.map` answers a plain
  // array that no longer satisfies it.
  const [first, ...rest] = document.parts;
  return {
    ...document,
    parts: [scrubSourcePart(scrub, first), ...rest.map((part) => scrubSourcePart(scrub, part))],
  };
}

/**
 * Monitoring data with the two sentences a provider writes in a panel's answer, the overview's
 * `tableCountSampledFrom` and the performance panel's `cacheHitAdvice`, read under `words` (`providerSentence`), and
 * each panel's `errors` entry through core's scrub, since a failed panel's sentence is already the request's answer
 * of that failure (a package's through its `PackageAnswers`). Every panel key the provider answered is kept, no key is
 * added, and data holding none of the three is answered as given; the data given is never changed. The panels'
 * figures and statement texts are database content, never scrubbed.
 */
export function scrubMonitoringData(words: ProviderWords, data: MonitoringData): MonitoringData {
  const { overview, performance, errors } = data;
  const sampled = overview?.tableCountSampledFrom;
  const advice = performance?.cacheHitAdvice;
  if (errors === undefined && sampled === undefined && advice === undefined) return data;
  return {
    ...data,
    ...(overview === undefined || sampled === undefined
      ? {}
      : { overview: { ...overview, tableCountSampledFrom: providerSentence(words, sampled) } }),
    ...(performance === undefined || advice === undefined
      ? {}
      : { performance: { ...performance, cacheHitAdvice: providerSentence(words, advice) } }),
    ...(errors === undefined
      ? {}
      : {
          // `Object.entries` widens a panel key to `string`; every key here is one the provider answered in `errors`.
          errors: Object.fromEntries(
            Object.entries(errors).map(([panel, sentence]) => [panel, scrubProviderText(words.scrub, sentence)]),
          ) as MonitoringData["errors"],
        }),
  };
}

/**
 * A maintenance answer with its `message`, the engine's sentence, read under `words` (`providerSentence`): through
 * core's scrub where the record grants its words, Studio's sentence where it does not, logged once. Its verdict, time,
 * `rows` and `fields` are kept as given. It takes the run answer's readonly lists, so the answer the maintenance facade
 * passes by reference reaches it as it is.
 */
export function scrubMaintenanceResult(words: ProviderWords, result: MaintenanceRunAnswer): MaintenanceRunAnswer {
  return { ...result, message: providerSentence(words, result.message) };
}

/**
 * A maintenance preview with its `summary`, and its `refusal` and `note` when present, the engine's sentences, each
 * read under `words` (`providerSentence`): through core's scrub where the record grants its words, Studio's sentence
 * where it does not, logged once. Its `facts` are field names and figures, kept as given.
 */
export function scrubMaintenancePreview(words: ProviderWords, preview: MaintenancePreview): MaintenancePreview {
  return {
    ...preview,
    summary: providerSentence(words, preview.summary),
    ...(preview.refusal === undefined ? {} : { refusal: providerSentence(words, preview.refusal) }),
    ...(preview.note === undefined ? {} : { note: providerSentence(words, preview.note) }),
  };
}

/**
 * A key page with its `skipped.reason`, `readOutcome.endReason` and each `readOutcome.provenLoss` entry scrubbed, the
 * provider's own words. Keys, types, prefixes, the cursor, the total, the skipped count and the scope are kept, and a
 * page with neither `skipped` nor `readOutcome` is answered as given.
 */
export function scrubKeyScanPage(scrub: ProviderTextScrub, page: KeyScanPage): KeyScanPage {
  const { skipped, readOutcome } = page;
  if (skipped === undefined && readOutcome === undefined) return page;
  return {
    ...page,
    ...(skipped === undefined
      ? {}
      : { skipped: { count: skipped.count, reason: scrubProviderText(scrub, skipped.reason) } }),
    ...(readOutcome === undefined
      ? {}
      : {
          readOutcome: {
            scope: readOutcome.scope,
            endReason: scrubProviderText(scrub, readOutcome.endReason),
            ...(readOutcome.provenLoss === undefined
              ? {}
              : { provenLoss: readOutcome.provenLoss.map((loss) => scrubProviderText(scrub, loss)) }),
          },
        }),
  };
}

/**
 * An object edit refusal with its `sentence`, and its `code` and `hint` when present, scrubbed: the engine's own words
 * and identifier. A string code is scrubbed whole, as a warning's is. The refusal class and the position are kept.
 */
export function scrubObjectEditRefusal(scrub: ProviderTextScrub, refusal: ObjectEditRefusal): ObjectEditRefusal {
  return {
    ...refusal,
    sentence: scrubProviderText(scrub, refusal.sentence),
    ...(refusal.code === undefined ? {} : { code: scrubProviderText(scrub, refusal.code) }),
    ...(refusal.hint === undefined ? {} : { hint: scrubProviderText(scrub, refusal.hint) }),
  };
}

/** A revision of check `"unavailable"` with its `reason` scrubbed; a token, its basis and its scope are kept. */
function scrubRevision(scrub: ProviderTextScrub, revision: ObjectEditRevision): ObjectEditRevision {
  if (revision.check !== "unavailable") return revision;
  return { check: "unavailable", reason: scrubProviderText(scrub, revision.reason) };
}

/** A text with its `truncated.reason` scrubbed; the text, its language and the limit are kept. */
function scrubTruncation<T extends { readonly truncated?: { readonly limit: number; readonly reason: string } }>(
  scrub: ProviderTextScrub,
  text: T,
): T {
  if (text.truncated === undefined) return text;
  return {
    ...text,
    truncated: { limit: text.truncated.limit, reason: scrubProviderText(scrub, text.truncated.reason) },
  };
}

/**
 * A plan with the `reason` of a revision of check `"unavailable"` scrubbed; any other plan is answered as given. Its
 * unit, session pins, revision token and basis and its consequences are database facts, never scrubbed.
 */
export function scrubObjectEditPlan(scrub: ProviderTextScrub, plan: ObjectEditPlan): ObjectEditPlan {
  const revision = scrubRevision(scrub, plan.revision);
  return revision === plan.revision ? plan : { ...plan, revision };
}

/** A build's pre-image with its `truncated.reason` scrubbed; its text is database content, kept as given. */
export function scrubObjectEditPreimage(scrub: ProviderTextScrub, preimage: ObjectEditPreimage): ObjectEditPreimage {
  return scrubTruncation(scrub, preimage);
}

/**
 * An apply outcome with each sentence and engine code the provider wrote scrubbed: a refusal's, an engine's concurrent
 * refusal's sentence and code, an interruption's sentence, the current text's truncation reason and an unavailable
 * revision's reason. What was written and lost, the current text, the commit disposition and the duration are kept.
 */
export function scrubObjectEditOutcome(scrub: ProviderTextScrub, outcome: ObjectEditOutcome): ObjectEditOutcome {
  switch (outcome.outcome) {
    case "refused":
      return { ...outcome, refusal: scrubObjectEditRefusal(scrub, outcome.refusal) };
    case "conflict":
      if (outcome.conflict === "object-changed") {
        const current = scrubTruncation(scrub, outcome.current);
        return current === outcome.current ? outcome : { ...outcome, current };
      }
      return {
        ...outcome,
        sentence: scrubProviderText(scrub, outcome.sentence),
        ...(outcome.code === undefined ? {} : { code: scrubProviderText(scrub, outcome.code) }),
      };
    case "interrupted":
      return { ...outcome, sentence: scrubProviderText(scrub, outcome.sentence) };
    case "applied":
    case "applied-with-collateral": {
      const revision = scrubRevision(scrub, outcome.revision);
      return revision === outcome.revision ? outcome : { ...outcome, revision };
    }
    case "applied-elsewhere":
      return outcome;
  }
}

/**
 * A provider's code for a record's code column, or `undefined` when it holds a form: that column holds a code and never
 * a sentence, so a code that holds a credential of the connection is recorded as none.
 */
export function recordedProviderCode(scrub: ProviderTextScrub, code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return holdsSecretForm(code, scrub.forms) ? undefined : code;
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
  return bundledAuthor(CONNECTION_FORM[type].label);
}

/** The author of a provider bundled with Studio, named by its engine's label. */
function bundledAuthor(label: string): string {
  return `${label} provider, bundled with Studio`;
}

/**
 * The author a notice names for the text a provider of any engine the server serves relayed: a legacy engine's as
 * `providerAuthor` names it, since its record's `displayName` is its connection form's label, and a provider package's
 * engine by its declared display name and the package's name and version, which serve it.
 */
export function engineAuthor(engine: EngineRecord): string {
  const { name, version, package: served } = engine.source;
  if (served === null) return bundledAuthor(engine.displayName);
  return `${engine.displayName} provider, from the provider package ${name} ${version}`;
}

/**
 * Whether a refusal is Studio's own: the eight classes only core constructs. `ReadAllowanceExceededError` (the run's
 * read allowance, before sending), `StudioProfileRefusal` (an execution profile refusal), `StudioOffsetRefusal` (an
 * offset the provider's prepare did not apply, before sending) and `StudioObjectModelRefusal` (a tree request naming a
 * level or a kind the object model does not state, before any call) come before a statement is sent;
 * `StudioRowBudgetRefusal`, `StudioByteBudgetRefusal` and `StudioTimeBudgetRefusal` (core's row, byte and time
 * refusals of an answer) and `StudioTimeoutRefusal` (the agent's statistics read outlasting its time) come after.
 */
export function isStudioRefusal(error: unknown): boolean {
  return (
    error instanceof ReadAllowanceExceededError ||
    error instanceof StudioProfileRefusal ||
    error instanceof StudioOffsetRefusal ||
    error instanceof StudioObjectModelRefusal ||
    error instanceof StudioRowBudgetRefusal ||
    error instanceof StudioByteBudgetRefusal ||
    error instanceof StudioTimeBudgetRefusal ||
    error instanceof StudioTimeoutRefusal
  );
}

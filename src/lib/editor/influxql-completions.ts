/**
 * InfluxQL completion for the `influxql` editor language (InfluxDB spec 6.7, I12, C6).
 *
 * Pure utility module (no React). The position a suggestion is for is read through the provider's own
 * browser-safe lexer, so a `FROM` inside a string, a regex or a comment opens nothing, and the names offered
 * come from the schema objects the editor already holds: a measurement's path is `[database, measurement]`
 * and its columns are `time`, its tag keys (type `tag`) and its field keys (any other type).
 *
 * What is offered where:
 * - after `FROM`, or after a comma in its source list: every measurement as the source `"db".."m"` (the database's
 *   default retention policy), replacing the whole source typed so far;
 * - elsewhere: the tag keys and field keys of the measurement the statement's first `FROM` source names, then
 *   the lexer's keyword table. The statement is the one the cursor is in, read up to the next `;`, so a source
 *   written after the cursor counts. A source that names no database matches the measurement of that name in
 *   every database, and a key two of them share is offered once.
 *
 * Every inserted name is built by `influxql-quote.ts`, so an inserted source or key reads back as exactly that
 * name and a statement made of them passes the read policy (E6); a name the quoter refuses is not offered.
 */
import type * as Monaco from "monaco-editor";
import {
  INFLUXQL_KEYWORDS,
  type InfluxqlToken,
  lexInfluxql,
  normaliseInfluxqlNewlines,
} from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import {
  InfluxqlQuoteError,
  influxqlSource,
  quoteInfluxqlIdentifier,
} from "@/lib/db/providers/timeseries/influxdb/influxql-quote";
import { INFLUXQL_LANGUAGE_ID } from "./influxql-language";

/** One measurement as completion offers it. */
export interface InfluxqlCompletionMeasurement {
  readonly database: string;
  readonly measurement: string;
  readonly tags: readonly string[];
  readonly fields: readonly string[];
}

/** The names InfluxQL completion offers, in the schema's order. */
export interface InfluxqlCompletionSchema {
  readonly measurements: readonly InfluxqlCompletionMeasurement[];
}

/** A schema object as the editor's `schemaContext` carries it: only its path and its typed columns are read. */
export interface InfluxqlSchemaObject {
  readonly path?: readonly string[];
  readonly columns?: readonly { readonly name: string; readonly type: string }[];
}

/** The column type `describeObject` gives a tag key; `time` is the timestamp, every other type a field's. */
const TAG_TYPE = "tag";
const TIME_TYPE = "time";

/** The measurements of a schema: every object whose path is `[database, measurement]`. */
export function influxqlCompletionSchemaOf(objects: readonly InfluxqlSchemaObject[]): InfluxqlCompletionSchema {
  const measurements: InfluxqlCompletionMeasurement[] = [];
  for (const object of objects) {
    if (object.path?.length !== 2) continue;
    const columns = object.columns ?? [];
    measurements.push({
      database: object.path[0],
      measurement: object.path[1],
      tags: columns.filter((column) => column.type === TAG_TYPE).map((column) => column.name),
      fields: columns
        .filter((column) => column.type !== TAG_TYPE && column.type !== TIME_TYPE)
        .map((column) => column.name),
    });
  }
  return { measurements };
}

/** The measurement a statement's first `FROM` source names; `database` only when the source names one. */
export interface InfluxqlNamedSource {
  readonly database?: string;
  readonly measurement: string;
}

/** What to offer at the cursor, and the offset in the text before it where the replaced text begins. */
export interface InfluxqlCompletionContext {
  readonly kind: "source" | "keyword";
  readonly start: number;
  /** For `keyword` only: the statement's first `FROM` source, when it names a measurement. */
  readonly source?: InfluxqlNamedSource;
}

const NOT_SIGNIFICANT: ReadonlySet<InfluxqlToken["kind"]> = new Set(["whitespace", "line-comment", "block-comment"]);

const isDot = (text: string, token: InfluxqlToken): boolean =>
  token.kind === "punctuation" && text[token.start] === ".";

/** A token that can be part of a source: a name, quoted or not, or a dot. */
const isSourcePart = (text: string, token: InfluxqlToken): boolean =>
  token.kind === "identifier" || token.kind === "quoted-identifier" || isDot(text, token);

const isComma = (text: string, token: InfluxqlToken): boolean =>
  token.kind === "punctuation" && text[token.start] === ",";

/**
 * Whether a source is written after `token`, the significant token at `index`: `FROM`, or a comma that follows
 * nothing but sources (names, dots, regexes) and commas back to a `FROM`.
 */
function opensSource(text: string, significant: readonly InfluxqlToken[], index: number): boolean {
  let i = index;
  if (significant[i] !== undefined && isComma(text, significant[i])) {
    i -= 1;
    while (
      i >= 0 &&
      (isSourcePart(text, significant[i]) || significant[i].kind === "regex" || isComma(text, significant[i]))
    ) {
      i -= 1;
    }
  }
  const token = significant[i];
  return token?.kind === "keyword" && token.value === "FROM";
}

/** The significant tokens of the statement the cursor is in: those between the `;` before it and the `;` after it. */
function statementAt(text: string, cursor: number): readonly InfluxqlToken[] {
  const tokens = lexInfluxql(text).filter((token) => !NOT_SIGNIFICANT.has(token.kind));
  let first = 0;
  let last = tokens.length;
  tokens.forEach((token, index) => {
    if (token.kind !== "semicolon") return;
    if (token.end <= cursor) first = index + 1;
    else if (last === tokens.length) last = index;
  });
  return tokens.slice(first, last);
}

/**
 * The measurement named by the first `FROM` source of the statement around `cursor`: a run of names and dots with
 * nothing between them, read as `m`, `rp.m` or `db.rp.m` (`db..m` included). Any other source, a regex or a
 * subquery among them, names none.
 */
function firstSource(text: string, cursor: number): InfluxqlNamedSource | undefined {
  const statement = statementAt(text, cursor);
  const from = statement.findIndex((token) => token.kind === "keyword" && token.value === "FROM");
  const parts: InfluxqlToken[] = [];
  for (const token of from < 0 ? [] : statement.slice(from + 1)) {
    if (!isSourcePart(text, token) || (parts.length > 0 && token.start !== parts[parts.length - 1].end)) break;
    parts.push(token);
  }
  const segments: string[] = [""];
  for (const part of parts) {
    if (isDot(text, part)) segments.push("");
    else if (segments[segments.length - 1] === "") segments[segments.length - 1] = part.value ?? "";
    // Two names with no dot between them are no source the server reads.
    else return undefined;
  }
  // Only `db..m` leaves a segment empty, and then only the middle one.
  const blank = segments.some((segment, index) => segment === "" && !(index === 1 && segments.length === 3));
  if (blank || segments.length > 3) return undefined;
  const measurement = segments[segments.length - 1];
  return segments.length === 3 ? { database: segments[0], measurement } : { measurement };
}

/**
 * The completion context at the cursor, read from the editor text before it and after it (both with the lexer's
 * newline rule applied); undefined inside a string, a regex or a comment, where nothing is offered.
 */
export function influxqlCompletionContext(before: string, after: string): InfluxqlCompletionContext | undefined {
  const tokens = lexInfluxql(before);
  const last = tokens[tokens.length - 1];
  if (last?.kind === "line-comment") return undefined;
  // An unterminated string, regex or block comment is one invalid token from its opening character.
  if (last?.kind === "invalid" && (before[last.start] === "'" || before[last.start] === "/")) return undefined;

  const significant = tokens.filter((token) => !NOT_SIGNIFICANT.has(token.kind));
  const touching = significant[significant.length - 1]?.end === before.length;
  // The word or quoted name being typed, when the cursor touches one; a quoted name may still be open.
  const end = significant.length;
  const lastSignificant = significant[end - 1];
  const typing =
    touching &&
    (lastSignificant.kind === "identifier" ||
      lastSignificant.kind === "keyword" ||
      lastSignificant.kind === "quoted-identifier" ||
      (lastSignificant.kind === "invalid" && before[lastSignificant.start] === '"'))
      ? lastSignificant
      : undefined;

  // The source typed so far: names and dots touching each other and the cursor. A keyword ends it, except the
  // one being typed.
  let run = end;
  if (touching) {
    if (typing !== undefined) run -= 1;
    while (
      run > 0 &&
      isSourcePart(before, significant[run - 1]) &&
      significant[run - 1].end === (significant[run]?.start ?? before.length)
    ) {
      run -= 1;
    }
  }
  if (opensSource(before, significant, run - 1)) {
    return { kind: "source", start: significant[run]?.start ?? before.length };
  }

  const start = typing?.start ?? before.length;
  const source = firstSource(before.slice(0, start) + after, start);
  return source === undefined ? { kind: "keyword", start } : { kind: "keyword", start, source };
}

/** A name quoted for insertion, or undefined when the quoter refuses it. */
function quoted(write: () => string): string | undefined {
  try {
    return write();
  } catch (error) {
    if (!(error instanceof InfluxqlQuoteError)) throw error;
    return undefined;
  }
}

/**
 * Registers the InfluxQL completion item provider with Monaco.
 *
 * @param monaco - The Monaco namespace
 * @param schema - The connection's measurements, from `influxqlCompletionSchemaOf`
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerInfluxqlCompletionProvider(
  monaco: typeof Monaco,
  schema: InfluxqlCompletionSchema,
): Monaco.IDisposable {
  const Kind = monaco.languages.CompletionItemKind;
  // Code-unit order, as the default sort gives, written out so no locale can reorder the list.
  const keywords = [...INFLUXQL_KEYWORDS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return monaco.languages.registerCompletionItemProvider(INFLUXQL_LANGUAGE_ID, {
    triggerCharacters: [".", '"'],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const text = model.getValue();
      const offset = model.getOffsetAt(position);
      const before = normaliseInfluxqlNewlines(text.slice(0, offset));
      const context = influxqlCompletionContext(before, normaliseInfluxqlNewlines(text.slice(offset)));
      if (context === undefined) return { suggestions: [] };
      // The replaced text never spans a line: a name, quoted or not, and a source run hold no newline.
      const typed = before.slice(context.start);
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      // Typed with a quote, Monaco filters on the quoted insert; typed bare, on the bare spelling.
      const filterOn = (insertText: string, bare: string) => (typed.startsWith('"') ? insertText : bare);

      if (context.kind === "source") {
        // A bare source typed as `rp.m` or `db.rp.m` is filtered with its own policy, so the spelling still matches.
        const segments = typed.split(".");
        const bareSource = (database: string, measurement: string) =>
          segments.length === 2
            ? `${segments[0]}.${measurement}`
            : `${database}.${segments.length === 3 ? segments[1] : ""}.${measurement}`;
        return {
          suggestions: schema.measurements.flatMap(({ database, measurement }) => {
            const insertText = quoted(() => influxqlSource(database, measurement));
            if (insertText === undefined) return [];
            const filterText = filterOn(insertText, bareSource(database, measurement));
            return [{ label: insertText, kind: Kind.Class, insertText, filterText, range, detail: "Measurement" }];
          }),
        };
      }

      const named = context.source;
      const owners = schema.measurements.filter(
        (entry) =>
          named !== undefined &&
          entry.measurement === named.measurement &&
          (named.database === undefined || entry.database === named.database),
      );
      // The same measurement in several databases may share a key: each key is offered once, where it first appears.
      const seen = new Set<string>();
      const keys = (names: readonly string[], detail: string) =>
        names.flatMap((label) => {
          if (seen.has(label)) return [];
          seen.add(label);
          const insertText = quoted(() => quoteInfluxqlIdentifier(label));
          if (insertText === undefined) return [];
          return [{ label, kind: Kind.Field, insertText, filterText: filterOn(insertText, label), range, detail }];
        });
      return {
        suggestions: [
          ...owners.flatMap((entry) => keys(entry.tags, "Tag key").concat(keys(entry.fields, "Field key"))),
          ...keywords.map((label) => ({ label, kind: Kind.Keyword, insertText: label, range, detail: "Keyword" })),
        ],
      };
    },
  });
}

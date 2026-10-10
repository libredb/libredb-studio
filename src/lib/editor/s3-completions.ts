/**
 * Completion for the `s3` editor language.
 *
 * Pure utility module (no React). Where the cursor stands is read through the console's own lexer, so a word drawn
 * as a service, an operation or an option is the word the parser reads. What is offered: the commands before the
 * service; `ls` after `s3` and the eight reads after `s3api`; the operation's flags not yet given, then the accepted
 * global options, never a refused one; a closed value set after its flag; and bucket names after `--bucket` or as an
 * `s3://` path. Bucket names come from the schema context the editor already holds, the buckets the tree listed, so
 * completion never sends a request and offers no folder or key. Every inserted name is written by
 * `quoteShellWord`, so it reads back as that name.
 */
import type * as Monaco from "monaco-editor";
import { quoteShellWord } from "@/lib/db/console/shell-words";
import {
  S3_ACCEPTED_GLOBAL_OPTIONS,
  S3_COMMAND_TABLE,
  S3_GLOBAL_OPTION_VALUES,
  type S3OperationKind,
} from "@/lib/db/providers/objectstore/s3/console/commands";
import {
  isOptionWord,
  S3_VALUE_GLOBAL_OPTIONS,
  s3CommandShape,
  s3Words,
} from "@/lib/db/providers/objectstore/s3/console/lexer";
import { S3_LANGUAGE_ID } from "./s3-language";

/** The bucket names of the editor's schema context: each object's first path segment, else its name. */
export function s3CompletionBucketsOf(objects: readonly { name: string; path?: string[] }[]): readonly string[] {
  const names = new Set<string>();
  for (const object of objects) names.add(object.path?.[0] ?? object.name);
  return [...names];
}

export type S3CompletionContext =
  | { readonly kind: "command"; readonly start: number }
  | { readonly kind: "operation"; readonly service: "s3" | "s3api"; readonly start: number }
  | {
      readonly kind: "flag";
      readonly operation: S3OperationKind;
      readonly given: readonly string[];
      readonly start: number;
    }
  | { readonly kind: "value"; readonly flag: string; readonly values: readonly string[]; readonly start: number }
  | { readonly kind: "bucket"; readonly asPath: boolean; readonly start: number };

const COMMANDS: readonly string[] = ["aws s3 ls", "aws s3api", "preview"];
const S3_SCHEME = "s3://";

const specOf = (operation: S3OperationKind | undefined) =>
  operation === undefined ? undefined : S3_COMMAND_TABLE.find((entry) => entry.operation === operation);

/** The operation a service and an operation word name, when the table has it. */
function operationOf(service: string | undefined, operation: string | undefined): S3OperationKind | undefined {
  if (service === "preview") return "preview";
  if (service === "s3") return operation === "ls" ? "ls" : undefined;
  if (service === "s3api")
    return S3_COMMAND_TABLE.find((entry) => entry.service === "s3api" && entry.operation === operation)?.operation;
  return undefined;
}

function takesValue(flag: string, operation: S3OperationKind | undefined): boolean {
  if (S3_VALUE_GLOBAL_OPTIONS.has(flag)) return true;
  return specOf(operation)?.flags.find((candidate) => candidate.name === flag)?.takes === "value";
}

function closedValues(flag: string, operation: S3OperationKind | undefined): readonly string[] | undefined {
  if (flag === "--output" || flag === "--color") return S3_GLOBAL_OPTION_VALUES[flag];
  return specOf(operation)?.flags.find((candidate) => candidate.name === flag)?.values;
}

/** The offset in `text` of a word's 1-based line and 0-based column. */
function offsetOf(text: string, word: { readonly line: number; readonly column: number }): number {
  const breaks = /\r\n|\r|\n/g;
  let offset = 0;
  for (let line = 1; line < word.line; line++) {
    const found = breaks.exec(text);
    offset = found === null ? text.length : found.index + found[0].length;
  }
  return offset + word.column;
}

/** Where the cursor stands, from the text before it; undefined where nothing is offered. */
export function s3CompletionContext(before: string): S3CompletionContext | undefined {
  const typed = /[^ \t\r\n]*$/.exec(before)?.[0] ?? "";
  const start = before.length - typed.length;
  // A word being typed inside quotes or after an escape is the user's own spelling.
  if (/['"\\]/.test(typed)) return undefined;
  const head = before.slice(0, start);
  const read = s3Words(head);
  if (!read.ok) return undefined;
  const { lead, words } = read;
  if (typed.startsWith(S3_SCHEME))
    return typed.slice(S3_SCHEME.length).includes("/") ? undefined : { kind: "bucket", asPath: true, start };
  const shape = s3CommandShape(words, head);
  const service = shape.serviceAt === undefined ? undefined : words[shape.serviceAt].text;
  const operation = operationOf(service, shape.operationAt === undefined ? undefined : words[shape.operationAt].text);
  const previous = words[words.length - 1];
  if (
    previous !== undefined &&
    isOptionWord(previous, head) &&
    !previous.text.includes("=") &&
    takesValue(previous.text, operation)
  ) {
    const values = closedValues(previous.text, operation);
    if (values !== undefined) return { kind: "value", flag: previous.text, values, start };
    return previous.text === "--bucket" ? { kind: "bucket", asPath: false, start } : undefined;
  }
  if (service === undefined) {
    if (typed.startsWith("-")) return undefined;
    // After a typed `aws`, a command replaces it too, so `aws s3 ls` is not written twice.
    const aws = lead.find((word) => !word.quoted && word.text === "aws");
    return { kind: "command", start: aws === undefined ? start : offsetOf(head, aws) };
  }
  if ((service === "s3" || service === "s3api") && shape.operationAt === undefined)
    return typed.startsWith("-") ? undefined : { kind: "operation", service, start };
  if (operation === undefined) return undefined;
  if (typed.startsWith("-"))
    return {
      kind: "flag",
      operation,
      given: words.filter((word) => isOptionWord(word, head)).map((word) => word.text.split("=")[0]),
      start,
    };
  if (operation === "ls" || operation === "preview") return { kind: "bucket", asPath: true, start };
  return undefined;
}

type ItemKind = "keyword" | "flag" | "value" | "bucket";

/** A name as an insert reads it back, or undefined when no command line spells it. */
function quoted(name: string): string | undefined {
  try {
    return quoteShellWord(name);
  } catch {
    return undefined;
  }
}

function itemsOf(
  context: S3CompletionContext,
  buckets: readonly string[],
): readonly { readonly label: string; readonly insertText: string; readonly kind: ItemKind }[] {
  const plain = (kind: ItemKind) => (label: string) => ({ label, insertText: label, kind });
  switch (context.kind) {
    case "command":
      return COMMANDS.map(plain("keyword"));
    case "operation":
      return (
        context.service === "s3"
          ? ["ls"]
          : S3_COMMAND_TABLE.filter((entry) => entry.service === "s3api").map((entry) => entry.operation)
      ).map(plain("keyword"));
    case "flag": {
      const own = specOf(context.operation)?.flags.map((flag) => flag.name) ?? [];
      return [...own, ...S3_ACCEPTED_GLOBAL_OPTIONS].filter((name) => !context.given.includes(name)).map(plain("flag"));
    }
    case "value":
      return context.values.map(plain("value"));
    case "bucket":
      return buckets.flatMap((bucket) => {
        const label = context.asPath ? `${S3_SCHEME}${bucket}/` : bucket;
        const insertText = quoted(label);
        return insertText === undefined ? [] : [{ label, insertText, kind: "bucket" as const }];
      });
  }
}

/**
 * Registers the S3 completion item provider with Monaco.
 *
 * @param monaco - The Monaco namespace
 * @param buckets - The bucket names of the editor's schema context, from `s3CompletionBucketsOf`
 * @returns An `IDisposable` that should be called on cleanup.
 */
export function registerS3CompletionProvider(monaco: typeof Monaco, buckets: readonly string[]): Monaco.IDisposable {
  const Kind = monaco.languages.CompletionItemKind;
  const kinds: Readonly<Record<ItemKind, Monaco.languages.CompletionItemKind>> = {
    keyword: Kind.Keyword,
    flag: Kind.Property,
    value: Kind.EnumMember,
    bucket: Kind.Folder,
  };
  return monaco.languages.registerCompletionItemProvider(S3_LANGUAGE_ID, {
    triggerCharacters: ["-", "/"],
    provideCompletionItems: (model: Monaco.editor.ITextModel, position: Monaco.Position) => {
      const before = model.getValue().slice(0, model.getOffsetAt(position));
      const context = s3CompletionContext(before);
      if (context === undefined) return { suggestions: [] };
      const typed = before.slice(context.start);
      // The replaced text is one line: a lead that a backslash-newline split from the cursor is left as it is.
      if (/[\r\n]/.test(typed)) return { suggestions: [] };
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: position.column - typed.length,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };
      return {
        suggestions: itemsOf(context, buckets).map((item) => ({
          label: item.label,
          kind: kinds[item.kind],
          insertText: item.insertText,
          range,
        })),
      };
    },
  });
}

/**
 * What the server does for a MongoDB command (#1821): the command's text, the repair ledger's identity of one read,
 * the row-cap advice, the admission pre-check and the reads against the run's inventory. It reaches `node:crypto`,
 * so it is server only.
 */
import { createHash } from "node:crypto";
import { admitMongoStatement } from "@/lib/db/operations/mongo-admission";
import type { PlanStatementIdentifiers } from "../../plan-statement";
import type { AgentInventory } from "../../types";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";
import { collectionsNotListed, mongoInventoryProblem } from "./inventory-check";

/**
 * A MongoDB command as text: a string as written, and a plain object as its JSON in the order the model wrote it.
 *
 * Written order, never sorted, because key order is part of the command: `{"b": 1, "a": 1}` and `{"a": 1, "b": 1}`
 * are two sorts and two exact embedded-document matches, and a sorted text would run a different read from the one
 * the model wrote. `JSON.stringify` keeps the insertion order `JSON.parse` gave the arguments, so the text is that
 * order. The one residual is JavaScript's own: integer-like keys come first in every object before any code here
 * sees it.
 *
 * An array, `{}` (and an object whose every value JSON drops) and any object that is not plain, such as a `Date`,
 * carry no command and answer null.
 */
function canonicalMongoText(raw: unknown): string | null {
  if (typeof raw === "string") return canonicalText(raw);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) return null;
  // Typed with undefined because a `toJSON` that returns nothing serialises to nothing at all.
  const text: string | undefined = JSON.stringify(raw);
  return text !== undefined && text.length > 2 ? text : null;
}

/**
 * A MongoDB command's identity in the repair ledger: the command re-serialised in the order it was written, so
 * whitespace is not part of it and key order is. Two key orders are two reads, because order is meaningful in a
 * sort document and in an exact embedded-document match: `{"b": 1, "a": 1}` and `{"a": 1, "b": 1}` return different
 * documents. Total: a line that does not parse is identified by its raw text, so a refused line is still refused
 * the second time. The fingerprint is taken over the text the pipeline carries (the adapter's `canonicalize`) rather
 * than over the object the model sent, so the ledger and the timeline, which carry text, agree with it by
 * construction.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintMongo(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return createHash("sha256").update(`mongo-raw:${text}`).digest("hex");
  }
  return createHash("sha256")
    .update(`mongo:${JSON.stringify(parsed)}`)
    .digest("hex");
}

/**
 * The row-cap advice of the operations that read many documents, naming only what THAT operation narrows with:
 * a sentence that tells an aggregate to add a filter would name a key no stage carries. The keys are
 * `AGENT_LANGUAGE_COPY.mongo.adviceKeys`, and `statement-languages.test.ts` holds the two to each other.
 */
const MONGO_ROW_CAP_ADVICE: Readonly<Record<string, (allowed: string) => string>> = Object.freeze({
  find: (allowed: string) =>
    `Ask for at most ${allowed} document${allowed === "1" ? "" : "s"}: narrow the filter, or set "options": {"limit": ${allowed}}, and run it again.`,
  aggregate: (allowed: string) =>
    `Ask for at most ${allowed} document${allowed === "1" ? "" : "s"}: add a $match stage before the $group, or a $limit stage, and run it again.`,
  count: (allowed: string) =>
    `A count answers one row: narrow the filter to the part of the data it is about, and run it again.`,
  distinct: (allowed: string) =>
    `Ask for at most ${allowed} value${allowed === "1" ? "" : "s"}: narrow the filter to a smaller part of the collection, and run it again.`,
});

/** The sentence for a MongoDB read refused past the row budget. Exported for its tests, like the fingerprint. */
export function mongoRowCapAdvice(statement: string, allowed: string): string {
  let operation: string | undefined;
  try {
    const parsed = JSON.parse(statement.trim()) as Record<string, unknown>;
    if (typeof parsed.operation === "string") operation = parsed.operation;
  } catch {
    /* a line that does not parse gets the generic sentence */
  }
  const advice = operation === undefined ? undefined : MONGO_ROW_CAP_ADVICE[operation];
  return advice === undefined
    ? `Ask for at most ${allowed} row${allowed === "1" ? "" : "s"}: narrow the command to less of the collection, and run it again.`
    : advice(allowed);
}

/** A MongoDB command's text as one JSON value, or undefined when it is not JSON. */
function parseMongoCommand(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `mongoInventoryProblem` over the canonical text, which the admission has already read as one JSON object. */
function mongoTextInventoryProblem(text: string, inventory: AgentInventory | null): string | null {
  const command = parseMongoCommand(text);
  return command === undefined ? null : mongoInventoryProblem(command, inventory);
}

/**
 * A MongoDB plan draft's collections against the inventory. A draft is one JSON command whose collections sit in
 * known keys, so its names are readable; a draft that is not JSON is one no reader here can open, which is the
 * not-applicable answer. Matching is on the collection's own name and case, never on the inventory's qualified
 * spelling: `shop.orders` written into a command is a collection that does not exist, which three of ten live drafts
 * did on 2026-10-17 and the editor answered with no rows.
 */
function mongoPlanDraftIdentifiers(text: string, inventory: AgentInventory | null): PlanStatementIdentifiers {
  const command = parseMongoCommand(text);
  if (command === undefined) return { kind: "not-applicable" };
  if (inventory === null) return { kind: "no-inventory" };
  return { kind: "checked", unknownTables: collectionsNotListed(command, inventory) };
}

export const MONGO_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "mongo.query.read",
  canonicalize: canonicalMongoText,
  fingerprint: fingerprintMongo,
  rowCapAdvice: mongoRowCapAdvice,
  admit: admitMongoStatement,
  shapeAdvice:
    "The command's shape falls outside the envelope a bounded read-only inspection may be, which is a decision about the contract rather than about a valid MongoDB read; a differently shaped command may still be admitted.",
  inventoryProblem: mongoTextInventoryProblem,
  planDraftIdentifiers: mongoPlanDraftIdentifiers,
});

/**
 * A MongoDB command read against the inventory the run captured, before anything is sent.
 *
 * Two mistakes a MongoDB read makes are answered by the server with an empty result rather than an error, so a run
 * that makes either reports zero with evidence and is scored as having answered:
 *
 * - **A collection that does not exist.** The inventory names each collection with its database in front
 *   (`shop.orders`), and a command written that way reads a collection called `shop.orders` inside `shop`, which
 *   does not exist. Measured 2026-10-17: three of ten plan-mode drafts named a collection so, and the editor answered
 *   each with no rows; `queryReadOnly` answered `count: 0` for `shop.customers` and for `Customers`.
 * - **A string compared with a date or an ObjectId.** A read result shows both types as plain strings, and a string
 *   never equals either, so `{"created_at": {"$gte": "2026-03-01T00:00:00Z"}}` matched nothing where
 *   `{"$date": "2026-03-01T00:00:00Z"}` matched 578 orders; runs reported "0 orders" and "the event does not exist".
 *
 * Both are decided from the inventory only, and only where the inventory can decide them: a collection is called
 * missing only when the inventory claims to be complete (`truncated` and `unreadContainers` absent), and a field is
 * held to a type only when every sampled document agreed on it (`date` or `objectId`, never `mixed(...)`), and only in
 * the filters that address the collection's own documents: a find, findOne, count or distinct filter, and the `$match`
 * stages a pipeline opens with, before any stage reshapes the documents.
 */
import { addressableObjects } from "../../inventory-objects";
import type { AgentInventory, AgentInventoryObject } from "../../types";
import { quoteIdentifierForPrompt } from "../../untrusted-content";

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The collection's own name, the last segment of its path: a MongoDB collection name may itself hold a dot. */
const leafName = (object: AgentInventoryObject): string => object.path?.at(-1) ?? object.name;

/** Every collection a command reads: its own, and those its pipeline's `$lookup`, `$graphLookup` and `$unionWith` name. */
export function mongoCollectionsNamed(command: unknown): readonly string[] {
  if (!isObject(command)) return [];
  const names: string[] = [];
  if (typeof command.collection === "string") names.push(command.collection);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === "$lookup" || key === "$graphLookup") && isObject(value) && typeof value.from === "string") {
        names.push(value.from);
      }
      if (key === "$unionWith") {
        if (typeof value === "string") names.push(value);
        else if (isObject(value) && typeof value.coll === "string") names.push(value.coll);
      }
      walk(value);
    }
  };
  walk(command.pipeline);
  return [...new Set(names)];
}

/** Whether the inventory claims to hold every collection, which is what lets an absence be read as one. */
const isComplete = (inventory: AgentInventory): boolean =>
  inventory.truncated === undefined && inventory.unreadContainers === undefined;

/**
 * The collections a command names that the inventory does not hold by their own name. Case matters, as it does to
 * MongoDB. Answers nothing when the inventory is incomplete, since a name missing from a partial list may exist.
 */
export function unknownMongoCollections(command: unknown, inventory: AgentInventory): readonly string[] {
  return isComplete(inventory) ? collectionsNotListed(command, inventory) : [];
}

/**
 * The collections a command names that the inventory does not list by their own name, whether or not the inventory
 * is complete: what a plan draft's name check reports, with the same meaning the SQL check's unknown tables have,
 * that the draft may not run as written.
 */
export function collectionsNotListed(command: unknown, inventory: AgentInventory): readonly string[] {
  const known = new Set(addressableObjects(inventory).map(leafName));
  return mongoCollectionsNamed(command).filter((name) => !known.has(name));
}

/** The sentence for one collection name the inventory does not hold, naming the spelling it does hold where there is one. */
function unknownCollectionSentence(name: string, inventory: AgentInventory): string {
  const objects = addressableObjects(inventory);
  const qualified = objects.find((object) => object.name === name);
  if (qualified !== undefined) {
    const leaf = leafName(qualified);
    return `${quoteIdentifierForPrompt(name)} is the inventory's spelling, with the database in front: a command names the collection alone, as in "collection": ${quoteIdentifierForPrompt(leaf)}. Written whole, ${quoteIdentifierForPrompt(name)} is a collection of that full name, which does not exist, and the read would answer nothing.`;
  }
  const lower = name.toLowerCase();
  const sameLetters = objects.find((object) => leafName(object).toLowerCase() === lower);
  if (sameLetters !== undefined) {
    return `There is no collection ${quoteIdentifierForPrompt(name)}; MongoDB names are case-sensitive, and the inventory holds ${quoteIdentifierForPrompt(leafName(sameLetters))}. A read of a collection that does not exist answers nothing rather than an error.`;
  }
  const shown = objects.map(leafName).slice(0, 20);
  return `There is no collection ${quoteIdentifierForPrompt(name)} in this database: a read of a collection that does not exist answers nothing rather than an error. The inventory holds ${shown.map((leaf) => quoteIdentifierForPrompt(leaf)).join(", ")}${objects.length > shown.length ? `, and ${objects.length - shown.length} more` : ""}.`;
}

/** The comparison operators whose operand is a value of the field, and the two whose operand is a list of them. */
const VALUE_OPERATORS: ReadonlySet<string> = new Set(["$eq", "$ne", "$gt", "$gte", "$lt", "$lte"]);
const LIST_OPERATORS: ReadonlySet<string> = new Set(["$in", "$nin", "$all"]);

/** The stages that leave the documents as the collection holds them, so a `$match` after them still filters its fields. */
const SHAPE_KEEPING_STAGES: ReadonlySet<string> = new Set(["$match", "$sort", "$limit", "$skip", "$sample"]);

interface TypedStringComparison {
  readonly field: string;
  readonly type: "date" | "objectId";
  readonly value: string;
}

/** The first comparison in `filter` of a date or ObjectId field with a plain string. */
function typedStringComparison(
  filter: unknown,
  types: ReadonlyMap<string, "date" | "objectId">,
): TypedStringComparison | null {
  if (!isObject(filter)) return null;
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or" || key === "$nor") {
      for (const clause of Array.isArray(value) ? value : []) {
        const found = typedStringComparison(clause, types);
        if (found !== null) return found;
      }
      continue;
    }
    const type = types.get(key);
    if (type === undefined) continue;
    if (typeof value === "string") return { field: key, type, value };
    if (!isObject(value)) continue;
    for (const [operator, operand] of Object.entries(value)) {
      if (VALUE_OPERATORS.has(operator) && typeof operand === "string") return { field: key, type, value: operand };
      if (LIST_OPERATORS.has(operator) && Array.isArray(operand)) {
        const text = operand.find((item): item is string => typeof item === "string");
        if (text !== undefined) return { field: key, type, value: text };
      }
    }
  }
  return null;
}

/** The filters of `command` that address its collection's own documents, in order. */
function documentFilters(command: JsonObject): readonly unknown[] {
  if (command.operation === "aggregate") {
    const filters: unknown[] = [];
    for (const stage of Array.isArray(command.pipeline) ? command.pipeline : []) {
      if (!isObject(stage)) break;
      const [name] = Object.keys(stage);
      if (name === undefined || !SHAPE_KEEPING_STAGES.has(name)) break;
      if (name === "$match") filters.push(stage.$match);
    }
    return filters;
  }
  return [command.filter];
}

/** The fields of `object` every sampled document typed as a date or an ObjectId. */
function typedFields(object: AgentInventoryObject): ReadonlyMap<string, "date" | "objectId"> {
  const types = new Map<string, "date" | "objectId">();
  for (const column of object.columns) {
    if (column.type === "date" || column.type === "objectId") types.set(column.name, column.type);
  }
  return types;
}

const literalFor = (comparison: TypedStringComparison): string =>
  comparison.type === "date"
    ? `{"$date": ${quoteIdentifierForPrompt(comparison.value)}}`
    : `{"$oid": ${quoteIdentifierForPrompt(comparison.value)}}`;

/**
 * Why `command` would read nothing for a reason the inventory already shows, or `null`. The sentence is the model's to
 * act on and ends as the envelope reader's refusals end, so a run can tell it was refused before anything was sent.
 */
export function mongoInventoryProblem(command: unknown, inventory: AgentInventory | null): string | null {
  if (inventory === null || !isObject(command)) return null;
  const unknown = unknownMongoCollections(command, inventory);
  if (unknown.length > 0) return `${unknownCollectionSentence(unknown[0], inventory)} Nothing was sent.`;
  const target = addressableObjects(inventory).find((object) => leafName(object) === command.collection);
  if (target === undefined) return null;
  const types = typedFields(target);
  if (types.size === 0) return null;
  for (const filter of documentFilters(command)) {
    const found = typedStringComparison(filter, types);
    if (found === null) continue;
    const kind = found.type === "date" ? "a date" : "an ObjectId";
    return `${quoteIdentifierForPrompt(found.field)} holds ${kind} in every sampled document, and this command compares it with the string ${quoteIdentifierForPrompt(found.value)}: a string never equals ${kind}, so the read would match nothing. Write the value as ${literalFor(found)}. Nothing was sent.`;
  }
  return null;
}

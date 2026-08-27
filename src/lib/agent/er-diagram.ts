/**
 * The schema's relations, as text a model can read (#330 T3).
 *
 * A run's inventory already lists every table and its columns, and that is a good
 * description of the SHAPE of a database and a poor one of how it is JOINED. The
 * relations are in there — one foreign key at a time, attached to whichever table
 * declared it, and only for columns the per-table cap reached. This renders them as
 * what they are: a graph.
 *
 * Four decisions, and the first two are security ones:
 *
 *  - **Identifiers are quoted in this notation, not merely fenced.** The fence is a
 *    labeling boundary; it says where the server stopped talking. It does not stop a
 *    table literally named `orders -> secrets` from producing a line that reads as a
 *    relation nobody has. So every identifier is delimited and its delimiter escaped,
 *    exactly as SQL does it, and a forged separator ends up visibly inside quotes.
 *    This is why the output is a relation list rather than Mermaid: `||--o{` is far
 *    easier to forge than a quoted pair, and a diagram that draws a relation the
 *    database does not have is worse than no diagram.
 *  - **A pairing this inventory cannot know is not invented.** More than one edge
 *    between the same two tables may be several separate keys, or one composite key
 *    the catalog read returned as the cross product of its sides (#463) — and
 *    nothing here can tell those apart. Rendering them as exact joins would
 *    assert relations the database does not have, which is the same failure the
 *    quoting exists to prevent, arrived at by arithmetic instead of by a hostile name.
 *    So such a group is one line that names the columns and says the pairing is
 *    unknown.
 *  - **A target outside the inventory is marked, never dropped.** A foreign key
 *    pointing at a table this run did not capture is a real edge with a missing
 *    node — the run reached the edge of what it read, which is a fact worth showing.
 *    Dropping it would make the graph look complete.
 *  - **Detail is a level, not a filter on tables.** Every relation appears at every
 *    level; what changes is how much is said about each one. A level that omitted
 *    relations would be a graph that lies by omission at exactly the moment a reader
 *    trusts it most.
 */

import { type AgentInventoryNoun, TABLE_INVENTORY_NOUN } from "./inventory-noun";
import type { AgentContextSnapshot, AgentRunWorkflowType } from "./types";
import { quoteIdentifierForPrompt } from "./untrusted-content";

/** How much is said about each relation. Never how many are shown. */
export type AgentErDetail = "minimal" | "medium" | "full";

/**
 * What each workflow is given.
 *
 * A total record, so a workflow added to the contract has to decide. An assessment
 * reasons about keys and their indexes, so it gets everything; an optimization cares
 * which columns join, so it gets the columns; an investigation mostly needs to know
 * what connects to what. An analysis is `medium` for the optimization's reason and
 * not the assessment's: joining a fact table to the dimension a question groups by is
 * a question about WHICH columns join, while how each key is indexed is what an
 * assessment asks and an analysis never does.
 *
 * `operations` answers `minimal` and never uses it, and since #411 the reason is a
 * packing decision rather than an absence. That workflow DOES capture a schema
 * snapshot now — the same whole one every other workflow captures — and is shown a
 * rendering of it that carries table names and their indexes and nothing else, because
 * an operations objective needs to recognise the objects its readings name and does not
 * need to know how they join. `investigation.ts` never calls `packRelations` for it, so
 * nothing here is ever asked for its detail level. The entry exists because the record
 * is total, and it names the least-saying level rather than inventing a fourth one for
 * a case that does not arise.
 */
const WORKFLOW_DETAIL: Readonly<Record<AgentRunWorkflowType, AgentErDetail>> = Object.freeze({
  investigation: "minimal",
  "query-optimization": "medium",
  "database-assessment": "full",
  operations: "minimal",
  "data-analysis": "medium",
} satisfies Record<AgentRunWorkflowType, AgentErDetail>);

export const erDetailForWorkflow = (workflowType: AgentRunWorkflowType): AgentErDetail => WORKFLOW_DETAIL[workflowType];

/**
 * One identifier, delimited so that nothing inside it can be read as notation.
 *
 * Declared beside the fence in `untrusted-content.ts` rather than here, since #411
 * gave the operations inventory the same need: two renderers quoting by two rules is
 * one rule that can drift, and the drift would be a hostile name that is safe in one
 * block and effective in the other. The reason it is not merely fenced is stated at
 * the top of this file.
 */
const quote = quoteIdentifierForPrompt;

/**
 * The rendered block's ceiling, in CHARACTERS.
 *
 * A count of edges is not a bound on a prompt: sixty ordinary edges can exceed this
 * on their own, and one long identifier can amplify a single line far past it. The
 * inventory beside this block is bounded the same way, on its fenced whole.
 */
export const MAX_ER_CHARS = 2_000;

/**
 * Held back so that adding the last line cannot be what overruns the bound.
 *
 * Measured against the longest notice this function can write — the count, plus
 * whatever advice the caller supplied — rather than fixed at a literal, because the
 * advice is now the caller's sentence and a literal would be a reserve that silently
 * stopped covering the thing it reserves for.
 */
const omissionReserve = (advice: string): number => 60 + advice.length;

interface Relation {
  readonly from: string;
  readonly column: string;
  readonly to: string;
  readonly toColumn: string;
  /** The referenced table is not in this inventory — the edge of what the run read. */
  readonly phantom: boolean;
}

/**
 * SQLite's parser answers this when `REFERENCES parent` names no column, which is
 * legal and means the parent's primary key. It is a sentinel rather than a column
 * name, so it is rendered as the words it stands for instead of being quoted as an
 * identifier that does not exist.
 */
const IMPLICIT_PRIMARY_KEY = "(primary key)";

function relationsOf(snapshot: AgentContextSnapshot): readonly Relation[] {
  const known = new Set(snapshot.tables.map((table) => table.name));
  const relations: Relation[] = [];
  const seen = new Set<string>();

  for (const table of snapshot.tables) {
    for (const key of table.foreignKeys ?? []) {
      // Deduplicated on the whole edge: PostgreSQL's catalog read returns a
      // composite key as the cross product of its sides (#463), so
      // the same pair can arrive more than once.
      const identity = JSON.stringify([table.name, key.columnName, key.referencedTable, key.referencedColumn]);
      if (seen.has(identity)) continue;
      seen.add(identity);
      relations.push({
        from: table.name,
        column: key.columnName,
        to: key.referencedTable,
        toColumn: key.referencedColumn,
        phantom: !known.has(key.referencedTable),
      });
    }
  }

  return relations;
}

/** The columns worth naming when a reader is judging whether a join is cheap. */
function keyColumns(snapshot: AgentContextSnapshot, tableName: string): string {
  const table = snapshot.tables.find((candidate) => candidate.name === tableName);
  if (table === undefined) return "";
  const primary = table.columns.filter((column) => column.isPrimary).map((column) => column.name);
  // The LEADING column of each index: an index leads on one column, and that is the
  // one a lookup on this relation can use.
  const leading = table.indexes.map((index) => index.columns[0]).filter((name): name is string => name !== undefined);
  const parts = [
    primary.length === 0 ? null : `primary key ${primary.map(quote).join(", ")}`,
    leading.length === 0 ? null : `indexed on ${[...new Set(leading)].map(quote).join(", ")}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "no primary key and no index in this inventory" : parts.join("; ");
}

function renderRelation(snapshot: AgentContextSnapshot, relation: Relation, detail: AgentErDetail): string {
  const target =
    relation.toColumn === IMPLICIT_PRIMARY_KEY
      ? `${quote(relation.to)} (primary key)`
      : `${quote(relation.to)}.${quote(relation.toColumn)}`;

  const head =
    detail === "minimal"
      ? `${quote(relation.from)} -> ${quote(relation.to)}`
      : `${quote(relation.from)}.${quote(relation.column)} -> ${target}`;

  const notes = [
    relation.phantom ? "target not in this inventory" : null,
    detail === "full" ? keyColumns(snapshot, relation.from) : null,
  ].filter((note) => note !== null && note.length > 0);

  return notes.length === 0 ? head : `${head}  [${notes.join("; ")}]`;
}

/**
 * Edges between the same pair of tables, rendered as ONE ambiguous line.
 *
 * PostgreSQL's catalog read returns a composite foreign key as the cross product of
 * its sides (#463): `FOREIGN KEY (x, y) REFERENCES parents(a, b)`
 * arrives as four edges, two of which are false. Rendering them as exact joins would
 * have this block assert `x -> b` — a relation the database does not have, which is
 * precisely what the quoting elsewhere in this file exists to prevent. Found by
 * review on #347.
 *
 * The columns are still named, because they are true: what is unknown is the
 * PAIRING, and the line says so rather than choosing one.
 */
function renderAmbiguous(snapshot: AgentContextSnapshot, group: readonly Relation[], detail: AgentErDetail): string {
  const first = group[0] as Relation;
  const columns = [...new Set(group.map((relation) => relation.column))].map(quote).join(", ");
  const targets = [...new Set(group.map((relation) => relation.toColumn))].map(quote).join(", ");
  const head =
    detail === "minimal"
      ? `${quote(first.from)} -> ${quote(first.to)}`
      : `${quote(first.from)} (${columns}) -> ${quote(first.to)} (${targets})`;
  const notes = [
    "several keys or one composite key; this inventory cannot pair the columns",
    first.phantom ? "target not in this inventory" : null,
    // The same note an exact line carries at this level: a level says more about
    // each relation, and a group is still one relation between two tables.
    detail === "full" ? keyColumns(snapshot, first.from) : null,
  ].filter((note) => note !== null && note.length > 0);
  return `${head}  [${notes.join("; ")}]`;
}

/** Edges grouped by the pair of tables they join, in first-seen order. */
function groupByPair(relations: readonly Relation[]): readonly (readonly Relation[])[] {
  const groups = new Map<string, Relation[]>();
  for (const relation of relations) {
    const key = JSON.stringify([relation.from, relation.to]);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [relation]);
    else existing.push(relation);
  }
  return [...groups.values()];
}

/**
 * The relation list, or a sentence about why there is none.
 *
 * The empty case is worth its own words: a reader shown an empty list would not know
 * whether the run failed to look, and the two ways it can be empty are not the same
 * fact.
 *
 * TWO empty sentences since #414, because an empty relations read means two different
 * things and one sentence could only cover one of them. Grounding reached MongoDB,
 * Redis, LibreDB, Druid, ClickHouse and Couchbase, where a foreign key is not a
 * construct to decline: any sentence about what this schema does or does not declare is
 * wrong there, and the reader is invited to wonder about a schema decision nobody made.
 *
 * `engineDeclaresForeignKeys` is `ProviderCapabilities.declaresForeignKeys`, and it is
 * a capability rather than an engine check for the rule `CLAUDE.md` states: engine
 * behaviour is declared by the provider that has it, and `=== 'mongodb'` outside a
 * provider class is how six of these would have been listed here and the seventh
 * forgotten. The flag is optional on the published interface, so this reads `=== false`
 * and an absent value takes the other sentence — the one that claims least, which is
 * the right default for an engine nobody has decided about.
 *
 * The OTHER empty sentence — the one an engine that does declare foreign keys gets —
 * used to hedge between "that may be how the schema is" and "the keys may be enforced
 * by the application", and both of those are readings of an absence that was never
 * established. A role can be narrower than the database it reads: measured live on the
 * seeded dvdrental, 18 foreign keys in `pg_constraint` and 0 rows visible to the
 * `SELECT`-only role this repository's own demo script prescribes, and an investigation
 * answered "there are no declared foreign key constraints between tables in the
 * database", confidently, citing a snapshot that genuinely contained nothing. The read
 * is fixed at its source (`composePostgresRelations` reads `pg_constraint`, which needs
 * only `USAGE`), and that fix does not reach the general case: ANY role can be narrower
 * than the database, so a zero-row read is not evidence of a zero-key schema and this
 * block no longer offers a reading of one. It states the limit of what was read and
 * tells the model not to report the negative — the same rule the inventory's omission
 * notice follows, where silence would be read as absence.
 *
 * So the three cases are distinct and stay distinct: an engine with no such construct
 * (nothing could have been found), a read that returned rows (they are listed), and a
 * read that returned none on an engine that has them (what was not seen, not what does
 * not exist). None of the three is a rewording of another.
 *
 * `noun` is what this engine calls the things the relations run between, from
 * `ProviderLabels` by way of `inventoryNoun`. It matters most in exactly the two
 * sentences above: an engine that declares no foreign keys is usually one whose rows
 * are not tables either, so saying "no table in this inventory" there names something
 * the reader was never shown. It defaults to `TABLE_INVENTORY_NOUN`, so every SQL
 * engine's block is unchanged.
 */
export function renderErDiagram(
  snapshot: AgentContextSnapshot,
  detail: AgentErDetail,
  options: {
    readonly maxChars?: number;
    readonly omissionAdvice?: string;
    readonly engineDeclaresForeignKeys?: boolean;
    readonly noun?: AgentInventoryNoun;
  } = {},
): string {
  const relations = relationsOf(snapshot);
  const noun = options.noun ?? TABLE_INVENTORY_NOUN;
  const header = `Relations between the ${snapshot.tables.length} ${noun.singular}(s) in this inventory, as declared foreign keys.`;
  if (relations.length === 0) {
    if (options.engineDeclaresForeignKeys === false) {
      return `${header}\nNone, and none could be: this engine does not declare foreign keys at all, so there is nothing of that kind here for a reading to have found or missed. Whatever relates these ${noun.plural} to each other is enforced somewhere other than the database, and this run has not seen it.`;
    }
    return `${header}\nNo foreign key was read for any ${noun.singular} in this inventory, and that is not the same as there being none. This reading sees only what the role it connected as is allowed to see, and a role narrower than the database reads an empty graph from a schema that declares many — nothing here can tell that apart from a schema that declares none. So do not report that this database has no foreign keys: report that no relation could be read on this connection, and treat any join you rely on as inferred from names rather than declared.`;
  }

  const groups = groupByPair(relations);
  const lines = groups.map((group) =>
    group.length === 1
      ? renderRelation(snapshot, group[0] as Relation, detail)
      : renderAmbiguous(snapshot, group, detail),
  );

  /*
    Bounded on the RENDERED length, not on a count of edges. Sixty ordinary edges can
    exceed the context bound on their own, and one long identifier can amplify a
    single line far past it — so a cap on edges is not a cap on characters, which is
    what a prompt is bounded in. Found by review on #347.
  */
  const maxChars = options.maxChars ?? MAX_ER_CHARS;
  /*
    What to do about the omitted relations, said only where it can be done.

    This notice ended `call inspect_schema with kind="relations" for them`
    unconditionally until #411, and a PLAN run holds no tools at all — so on a schema
    with more relations than this bound holds, plan mode was being told to call
    something it does not have, which is the #350 failure in the one mode that cannot
    discover its mistake by trying the call. The tool set is the caller's knowledge, so
    the caller supplies the sentence and a caller with no tool to name supplies none.
    The omission itself is never optional: a silently truncated graph is a model that
    believes it has seen how the schema joins.
  */
  const advice = options.omissionAdvice === undefined ? "" : ` ${options.omissionAdvice}`;
  const kept: string[] = [];
  let size = header.length;
  for (const line of lines) {
    // The omission notice is reserved for, so adding the last line cannot be what
    // pushes the block past its bound.
    if (size + line.length + 1 + omissionReserve(advice) > maxChars) break;
    kept.push(line);
    size += line.length + 1;
  }

  const omitted = lines.length - kept.length;
  const tail = omitted === 0 ? "" : `\n${omitted} further relation(s) omitted.${advice}`;
  return `${header}\n${kept.join("\n")}${tail}`;
}

/**
 * Whether the info string on a markdown fence says the block holds a query.
 *
 * Extracted from `src/components/rich-text.tsx` on 2026-08-15, when a SECOND reader of
 * the same fences appeared: `src/lib/agent/plan-statement.ts` reads a plan run's
 * deliverable out of its closing prose on the server, and the rail renders the same
 * text in the browser. While the predicate lived in the browser layer only, the two
 * disagreed about which block is a statement — the reader took the FIRST fenced block
 * whatever its info string, so a run that opened with a ```text illustration recorded
 * the illustration as its deliverable while the rail offered the editor the SQL block
 * below it. One shared answer is what makes the agreement those two modules claim an
 * enforced fact rather than a comment.
 *
 * The fence PATTERN itself stays duplicated in both callers, and deliberately: it is
 * three characters of regex whose reason is recorded in both places, and the server
 * layer does not import the browser layer to get it.
 */

import type { GenericFenceTag } from "@libredb/provider-sdk/manifest";
import { BUNDLED_FENCE_ALIASES } from "@/lib/db/engine-catalog/editor.generated";
import { isDatabaseType } from "@/lib/db/type-id";
import type { DatabaseType } from "@/lib/types";

/*
 * Every engine this product speaks is a fence tag naming it, by its type-id: an engine's id names it through the
 * catalog (`isDatabaseType`, docs/providers/CONTRACT.md, clause M-70), so an engine admitted to the catalog is a fence
 * tag the moment it is, and no list here can leave one out. The other tags that name an engine are the aliases its
 * declaration states, `editor.fenceAliases` (clause M-75). Why an engine has the aliases it has, or none, is said in
 * its provider document's `Execution UI` subsection, beside the fence tags that name it.
 */

/**
 * The fence tags of a query language several engines speak, keyed by the schema's `genericFenceTag` vocabulary, so a
 * tag the schema adds fails the typecheck here until Studio lists it: Studio's own record of the schema's generic tags.
 *
 * `sql` names no engine: mapping it to the connection's would turn a generic tag into a claim the model never made.
 * `cql` names none either, for the same reason, though `cassandra` is the only type-id that runs CQL today; that is a
 * known defect rather than a design (backlog B86).
 */
const GENERIC_FENCE_TAGS: Readonly<Record<GenericFenceTag, true>> = Object.freeze({ sql: true, cql: true });

/**
 * The aliases that name ONE engine, and which one: each engine declaration's `editor.fenceAliases`, read from the
 * generated fence alias record, which `bun run engines:generate` projects from the admitted declarations and which
 * refuses an alias two declarations state or one equal to another engine's id (clause M-75).
 *
 * An entry names the type-id a block's text runs on, which is not always the product the tag spells: `mariadb` names
 * `mysql`, the type-id MariaDB connects through. A tag missing from it costs the user a button and never a wrong one:
 * the copy control is offered on every block regardless.
 */
export const ALIAS_ENGINES: Readonly<Record<string, DatabaseType>> = BUNDLED_FENCE_ALIASES;

/**
 * The other names the same query languages go by, which is what a model actually types: the generic fence tags and
 * every alias that names an engine. An engine's own id is a query tag too, read through the catalog rather than listed
 * here.
 */
export const QUERY_FENCE_ALIASES: ReadonlySet<string> = new Set([
  ...Object.keys(GENERIC_FENCE_TAGS),
  ...Object.keys(ALIAS_ENGINES),
]);

/**
 * The engine a tag NAMES, or `null` when it names none (#396 review).
 *
 * The distinction this draws is the one `isQueryFenceTag` cannot: that predicate asks
 * whether a block holds a query at all, and answers yes for `mysql` on a PostgreSQL
 * connection. A reader that then records the block under the connection's own dialect
 * has relabelled the model's MySQL as PostgreSQL — it says the run drafted something
 * for this database that the run explicitly wrote for another one, which is the
 * false-self-description defect this repository keeps finding.
 *
 * `null` for an untagged fence and for `sql` is not a gap: neither says which engine,
 * so neither can contradict the connection. Only an explicit engine can.
 */
export const fenceTagEngine = (tag: string | undefined): DatabaseType | null => {
  if (tag === undefined) return null;
  if (isDatabaseType(tag)) return tag;
  return Object.hasOwn(ALIAS_ENGINES, tag) ? ALIAS_ENGINES[tag] : null;
};

/**
 * Whether a fence holds something the editor should be offered.
 *
 * Fail-closed on an unrecognised tag, the same posture the auto-execute gate takes about
 * a dialect it has no rule for: the tag is the model saying what the block is, and
 * offering to put a shell command into a SQL editor would be this surface claiming
 * something the model contradicted.
 *
 * An untagged fence counts. Models write one for SQL constantly, and in a document
 * whose entire subject is a database the bare fence is a query far more often than it
 * is anything else — while the cost of being wrong is one click that puts text in an
 * editor, which the user can see and undo.
 *
 * The tag is expected lower-cased; both callers lower-case it as they read the fence.
 */
export const isQueryFenceTag = (tag: string | undefined): boolean =>
  tag === undefined || isDatabaseType(tag) || QUERY_FENCE_ALIASES.has(tag);

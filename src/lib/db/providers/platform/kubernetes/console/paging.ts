/**
 * The grid's page of a kubectl statement: `prepareQuery` appends a paging clause, and `query()` reads it back.
 *
 * Pure, and shipped to the browser with the parser it reads. The clause is the provider's own, never a kubectl flag:
 * one last line `# libredb:page offset=<n> limit=<n>`, which a shell reads as a comment, so the prepared text still
 * reads as the statement the user wrote. Only the list form of a single-type `get` is paged; every other statement
 * goes on untouched with `wasLimited: false`, so the grid never offers a page two the statement cannot serve.
 */
import type { PreparedQuery, QueryPrepareOptions } from "@/lib/db/types";
import { KUBERNETES_MAX_STATEMENT_ROWS, KUBERNETES_PAGE_SIZE } from "../limits";
import { isPageable, type KubectlStatement, parseKubectl } from "./parse";

/** The sentence for a paging line under a statement that cannot page. */
export const PAGING_CLAUSE_SENTENCE =
  "The last line is Studio's own paging line, which applies only to the list form of a single-type get: remove it.";

const CLAUSE = /\n# libredb:page offset=(0|[1-9][0-9]{0,8}) limit=([1-9][0-9]{0,8})$/;

/** The statement and the page its clause names, or the text alone when it carries no clause. */
export function readPagingClause(text: string): {
  readonly statement: string;
  readonly page?: { readonly offset: number; readonly limit: number };
} {
  const match = CLAUSE.exec(text);
  if (match === null) return { statement: text };
  return { statement: text.slice(0, match.index), page: { offset: Number(match[1]), limit: Number(match[2]) } };
}

/**
 * The statement one run reads: the paging clause taken off, the rest parsed, and a clause under a statement that
 * cannot page refused. The editor's gate and the provider both read a text through this, so a line the gate sends is
 * a line the provider runs.
 */
export function readKubectlRun(text: string):
  | {
      readonly ok: true;
      readonly statement: KubectlStatement;
      readonly page?: { readonly offset: number; readonly limit: number };
    }
  | { readonly ok: false; readonly message: string } {
  const { statement: body, page } = readPagingClause(text);
  const parsed = parseKubectl(body);
  if (!parsed.ok) return { ok: false, message: parsed.refusal.message };
  if (page !== undefined && !isPageable(parsed.statement)) return { ok: false, message: PAGING_CLAUSE_SENTENCE };
  return page === undefined
    ? { ok: true, statement: parsed.statement }
    : { ok: true, statement: parsed.statement, page };
}

/** The text with its paging clause. */
export function withPagingClause(text: string, page: { readonly offset: number; readonly limit: number }): string {
  return `${text}\n# libredb:page offset=${page.offset} limit=${page.limit}`;
}

/**
 * The prepared statement: a pageable get gains the clause and `wasLimited: true`, so the route's probe asks for one
 * row more through the same clause; an unlimited run asks for the 5,000 rows a statement may read.
 */
export function prepareKubectlQuery(query: string, options: QueryPrepareOptions = {}): PreparedQuery {
  const limit = options.unlimited === true ? KUBERNETES_MAX_STATEMENT_ROWS : options.limit || KUBERNETES_PAGE_SIZE;
  const offset = options.offset || 0;
  const parsed = parseKubectl(query);
  if (!parsed.ok || !isPageable(parsed.statement)) return { query, wasLimited: false, limit, offset: 0 };
  return { query: withPagingClause(query, { offset, limit }), wasLimited: true, limit, offset };
}

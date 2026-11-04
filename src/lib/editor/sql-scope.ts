/**
 * What a statement's FROM, JOIN, INTO, UPDATE and USING positions name, as seen from one cursor position:
 * the sources whose columns a completion there may offer. A light reader, not a parser: it reads one
 * statement whose comments and strings are already blanked, and gives up on a source it cannot read by
 * calling it opaque rather than guessing.
 */

/** A derived source (a subquery or a CTE): the names its select list yields. */
export interface DerivedSource {
  readonly columns: readonly string[];
  /** Whether a `*` or `t.*` passes its sources' columns through too. */
  readonly star: boolean;
  readonly sources: readonly ScopeSource[];
}

export interface ScopeSource {
  /** Offset of the source in the statement. */
  readonly at: number;
  /** Paren depth of the query the source belongs to: 0 for the statement, more for a subquery. */
  readonly depth: number;
  alias?: string;
  /** A named table's (or CTE's) segments, unquoted. */
  readonly name?: readonly string[];
  readonly derived?: DerivedSource;
  /** A table function or a parenthesised join: its columns are unknown. */
  readonly opaque?: true;
}

export interface StatementScope {
  /** Innermost query's sources first, then each enclosing query's. */
  readonly sources: readonly ScopeSource[];
  /** The statement's CTE names, as written. */
  readonly ctes: readonly string[];
}

const MAX_DEPTH = 32;
const SEG = '`[^`]+`|"(?:[^"]|"")+"|\\[[^\\]]+\\]|[\\w$]+(?:-[\\w$]+)*';
const NAME = `(?:${SEG})(?:\\.(?:${SEG}))*`;
const KEYWORD =
  /^(?:ON|USING|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|OUTER|SET|VALUES|GROUP|ORDER|HAVING|LIMIT|OFFSET|FETCH|UNION|INTERSECT|EXCEPT|WINDOW|QUALIFY|SELECT|FROM|AS|DEFAULT|RETURNING|TABLESAMPLE|FOR|WITH|LATERAL|PIVOT|UNPIVOT|WHEN|THEN|ELSE|END|AND|OR|NOT|FINAL|PREWHERE|SAMPLE|FORCE|USE|IGNORE|PARTITION|APPLY|START|CONNECT|MATCH_RECOGNIZE|IS|NULL|TRUE|FALSE|LIKE|ILIKE|IN|BETWEEN|DISTINCT|BY|ASC|DESC|CASE|COLLATE|ESCAPE|TO)$/i;

function unquote(segment: string): string {
  if (segment.startsWith('"')) return segment.slice(1, -1).replace(/""/g, '"');
  return segment.startsWith("[") ? segment.slice(1, -1) : segment;
}

/** A dotted name's segments. A backticked segment is split at its dots, the BigQuery reading of `` `p.d.t` ``. */
function segments(raw: string): string[] {
  return [...raw.matchAll(new RegExp(SEG, "g"))].flatMap(([s]) =>
    s.startsWith("`") ? s.slice(1, -1).split(".") : [unquote(s)],
  );
}

/** Offset of the `)` closing the `(` at `open`, or the statement's length when it is unclosed. */
function closeOf(sql: string, open: number): number {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return i;
  }
  return sql.length;
}

/** `sql[start, end)` with every nested group's content blanked, so offsets still line up. */
function flat(sql: string, start: number, end: number): string {
  let depth = 0;
  let out = "";
  for (let i = start; i < end; i++) {
    const ch = sql[i];
    if (ch === "(") out += depth++ === 0 ? ch : " ";
    else if (ch === ")") out += (depth = Math.max(0, depth - 1)) === 0 ? ch : " ";
    else out += depth === 0 ? ch : " ";
  }
  return out;
}

/** A PostgreSQL cast that ends an item: `::text`, `::varchar(10)`, `::double precision`, `::int[]`. */
const CAST = /::[\w$]+(?:\s+(?:precision|varying|(?:with|without)\s+time\s+zone))?(?:\s*\([\d\s,]*\))?(?:\[\])*$/i;

/** The names of the column list whose `(` is at `open`; an empty entry (`s(a, `, `c ()`) names nothing. */
function columnList(sql: string, open: number): string[] {
  return sql
    .slice(open + 1, closeOf(sql, open))
    .split(",")
    .flatMap((c) => segments(c.trim()).slice(0, 1));
}

/** The name a select-list item yields: its alias, or a bare column's own name. An expression yields none. */
function itemName(item: string): string | undefined {
  const explicit =
    new RegExp(`\\bAS\\s+(${SEG})$`, "i").exec(item)?.[1] ??
    // A cast keeps its operand's name: `id::text` is `id`.
    new RegExp(`^(?:(?:${SEG})\\.)*(${SEG})$`).exec(item.replace(CAST, ""))?.[1];
  // An implicit alias follows an expression's last token, never an operator word (`a AND b`, `x IS NULL`).
  const implicit = new RegExp(`(${SEG}|\\))\\s+(${SEG})$`).exec(item);
  const name = explicit ?? (implicit && !KEYWORD.test(implicit[1]) ? implicit[2] : undefined);
  if (!name || KEYWORD.test(name) || /^\d/.test(name)) return undefined;
  return segments(name).at(-1);
}

function derive(sql: string, start: number, end: number, outer: Map<string, DerivedSource>, depth: number) {
  const ctes = readCtes(sql, start, end, outer, depth).ctes;
  const text = flat(sql, start, end);
  // A set operation's columns are named by its first branch.
  const branch = text.search(/\b(?:UNION|INTERSECT|EXCEPT)\b/i);
  const stop = branch < 0 ? text.length : branch;
  const first = text.slice(0, stop);
  const select = /\bSELECT\s+(?:DISTINCT\s+ON\s*\(\s*\)\s*|(?:DISTINCT|ALL)\s+)?/i.exec(first);
  const columns: string[] = [];
  let star = false;
  if (select) {
    const from = first.slice(select.index).search(/\bFROM\b/i);
    const list = first.slice(select.index + select[0].length, from < 0 ? undefined : select.index + from);
    for (const raw of list.split(",")) {
      const item = raw.trim();
      if (new RegExp(`^(?:(?:${SEG})\\.)*\\*$`).test(item)) star = true;
      else {
        const name = itemName(item);
        if (name) columns.push(name);
      }
    }
  }
  return { columns, star, sources: sourcesIn(sql, start, start + stop, ctes, depth) };
}

function readItem(
  sql: string,
  text: string,
  base: number,
  pos: number,
  keyword: string,
  ctes: Map<string, DerivedSource>,
  depth: number,
): { source: ScopeSource; end: number } | undefined {
  const prefix = /(?:LATERAL|ONLY|TABLE)\s+/iy;
  prefix.lastIndex = pos;
  if (prefix.test(text)) pos = prefix.lastIndex;
  const at = base + pos;
  let source: ScopeSource;
  let end: number;
  if (text[pos] === "(") {
    const close = closeOf(sql, at);
    // Past MAX_DEPTH a subquery is opaque, which bounds the work on pathological nesting.
    if (depth < MAX_DEPTH && /^\s*(?:SELECT|WITH)\b/i.test(sql.slice(at + 1, close))) {
      source = { at, depth, derived: derive(sql, at + 1, close, ctes, depth + 1) };
    } else if (keyword === "USING") {
      return undefined; // `JOIN b USING (col)`: a column list, no source
    } else source = { at, depth, opaque: true };
    end = close + 1 - base;
  } else {
    const name = new RegExp(NAME, "y");
    name.lastIndex = pos;
    const match = name.exec(text);
    if (!match || KEYWORD.test(match[0])) return undefined;
    end = name.lastIndex;
    const call = /\s*\(/y;
    call.lastIndex = end;
    // After INTO, UPDATE or an object's ON a `(` opens the column list; elsewhere it calls a table function.
    if (keyword !== "INTO" && keyword !== "UPDATE" && keyword !== "ON" && call.test(text)) {
      end = closeOf(sql, base + call.lastIndex - 1) + 1 - base;
      source = { at, depth, opaque: true };
    } else {
      const parts = segments(match[0]);
      const cte = parts.length === 1 ? ctes.get(parts[0].toLowerCase()) : undefined;
      source = { at, depth, name: parts, ...(cte ? { derived: cte } : {}) };
    }
  }
  const alias = new RegExp(`\\s+(?:AS\\s+)?(${SEG})`, "iy");
  alias.lastIndex = end;
  const named = alias.exec(text);
  if (named && !KEYWORD.test(named[1])) {
    source.alias = segments(named[1])[0];
    end = alias.lastIndex;
    // `AS s(a, b)` renames the source's columns, and gives a table function its shape.
    const list = /\s*\(/y;
    list.lastIndex = end;
    if (list.test(text)) {
      const close = closeOf(sql, base + list.lastIndex - 1);
      const columns = columnList(sql, base + list.lastIndex - 1);
      const derived = { columns, star: false, sources: source.derived?.sources ?? [] };
      source = { at, depth, alias: source.alias, ...(source.name ? { name: source.name } : {}), derived };
      end = close + 1 - base;
    }
  }
  return { source, end };
}

/** The sources one query level names, in text order; nested groups belong to their own level. */
function sourcesIn(sql: string, start: number, end: number, ctes: Map<string, DerivedSource>, depth: number) {
  const text = flat(sql, start, end);
  const sources: ScopeSource[] = [];
  let previous: string | undefined;
  for (const match of text.matchAll(
    /(?<![\w$.])(FROM|JOIN|INTO|(?<!\b(?:ON|FOR|KEY)\s+)UPDATE|USING|(?<!\bDISTINCT\s+)ON)\s+/gi,
  )) {
    const keyword = match[1].toUpperCase();
    const before = previous;
    previous = keyword;
    // Only an ON that names an object (`CREATE INDEX i ON t`, `GRANT … ON t`, `… AFTER UPDATE ON t`) is a source.
    if (keyword === "ON" && (depth > 0 || (before !== undefined && before !== "UPDATE"))) continue;
    let pos = match.index + match[0].length;
    for (;;) {
      const item = readItem(sql, text, start, pos, keyword, ctes, depth);
      if (!item) break;
      sources.push(item.source);
      const comma = /\s*,\s*/y;
      comma.lastIndex = item.end;
      if (keyword !== "FROM" || !comma.test(text)) break;
      pos = comma.lastIndex;
    }
  }
  return sources;
}

/**
 * The CTEs one query level defines, added to those of the levels enclosing it. A WITH need not open the
 * statement (`CREATE VIEW v AS WITH`, `INSERT INTO t WITH`, a subquery's own); one that defines nothing
 * (`WITH (NOLOCK)`, `WITH ROLLUP`) is no CTE list.
 */
function readCtes(sql: string, start: number, end: number, outer: ReadonlyMap<string, DerivedSource>, depth: number) {
  const ctes = new Map(outer);
  const names: string[] = [];
  const bodies: number[] = [];
  const text = flat(sql, start, end);
  const definition = new RegExp(`(${SEG})\\s*(?:(\\(\\s*\\))\\s*)?AS\\s+(?:NOT\\s+)?(?:MATERIALIZED\\s+)?\\(`, "iy");
  for (const head of text.matchAll(/\bWITH\s+(?:RECURSIVE\s+)?/gi)) {
    definition.lastIndex = head.index + head[0].length;
    for (let match = definition.exec(text); match; match = definition.exec(text)) {
      const open = start + definition.lastIndex - 1;
      const close = closeOf(sql, open);
      let derived: DerivedSource = derive(sql, open + 1, close, ctes, depth + 1);
      if (match[2]) {
        const list = start + text.indexOf("(", match.index + match[1].length);
        derived = { ...derived, columns: columnList(sql, list), star: false };
      }
      const name = segments(match[1])[0];
      ctes.set(name.toLowerCase(), derived);
      names.push(name);
      bodies.push(open);
      const comma = /\s*,\s*/y;
      comma.lastIndex = close + 1 - start;
      if (!comma.test(text)) break;
      definition.lastIndex = comma.lastIndex;
    }
    if (names.length > 0) break;
  }
  return { ctes, names, bodies };
}

/** The scope at `cursor` in one statement whose comments and strings are blanked. */
export function statementScope(sql: string, cursor: number): StatementScope {
  const opens: number[] = [];
  for (let i = 0; i < Math.min(cursor, sql.length); i++) {
    if (sql[i] === "(") opens.push(i);
    else if (sql[i] === ")") opens.pop();
  }
  // Each level from the statement inwards, with the CTEs it sees: its own and its enclosing levels'.
  const levels: { open: number; end: number; ctes: ReadonlyMap<string, DerivedSource> }[] = [];
  const cteNames: string[] = [];
  const cteBodies = new Set<number>();
  let ctes: ReadonlyMap<string, DerivedSource> = new Map();
  for (let depth = 0; depth <= opens.length; depth++) {
    const open = depth === 0 ? -1 : opens[depth - 1];
    const end = depth === 0 ? sql.length : closeOf(sql, open);
    const read = readCtes(sql, open + 1, end, ctes, depth);
    ctes = read.ctes;
    // One at a time here and below, never as the arguments of one call: a level may name more CTEs and sources than a
    // runtime takes arguments (measured: 700,000 overflowed the stack under Bun 1.4.4, and 130,000 under Node 24.22.1).
    for (const name of read.names) cteNames.push(name);
    for (const body of read.bodies) cteBodies.add(body);
    levels.push({ open, end, ctes });
  }

  const sources: ScopeSource[] = [];
  for (let depth = opens.length; depth >= 0; depth--) {
    const { open, end, ctes: visible } = levels[depth];
    for (const source of sourcesIn(sql, open + 1, end, new Map(visible), depth)) sources.push(source);
    // A CTE body is a query of its own: the statement around it is no enclosing query.
    if (cteBodies.has(open)) break;
  }
  return { sources, ctes: cteNames };
}

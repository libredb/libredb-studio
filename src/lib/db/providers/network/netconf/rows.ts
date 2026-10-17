/**
 * Rows out of a reply (issue #1724, requirement Y-S1).
 *
 * One row per entry of the selected list, key leaves first, leaves as cells, leaf-lists as array
 * cells, nested containers and lists as JSON cells, and every value as text.
 *
 * Text is not a style choice. MEASURED 2026-10-13 on Netopeer2: a `uint64` arrives as
 * 18446744073709551615 and an `int64` as -9223372036854775808, and the npm client
 * `netconf-client` 2.0.8 answered 18446744073709552000 and -9223372036854776000 for the same
 * leaves, because it parsed them as numbers. A value that passes through a JavaScript number is a
 * different value, so nothing here converts one.
 *
 * The reader is the port in `reader-port.ts`, so this file never parses XML. It walks the tree the
 * reader answers.
 */

import type { XmlElement } from "./reader-port";

export interface RowSet {
  readonly columns: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** Set when a cap ended the build, so the grid can say the answer is partial. */
  readonly warning?: string;
}

export interface RowLimits {
  readonly maxRows: number;
  /** Characters one cell may hold before it is cut, with the cut stated in the warning. */
  readonly maxCellChars: number;
}

/**
 * Where the two numbers come from, and where they do not.
 *
 * MEASURED 2026-10-13, against the Netopeer2 fixture: the largest list this provider has read is
 * 5,000 interface entries, which answered 987,957 bytes and 15,000 cells, and the longest single
 * cell in it was 11 characters, `ge-0/0/1000`.
 *
 * So `maxRows` is twice the largest list ever read here, and `maxCellChars` is four thousand times
 * the longest cell ever read here. Both are STILL DEFAULTS: the fixture's values are values we
 * wrote, and the figures a real device answers are UNMEASURED. A device's interface table may hold
 * far more than 5,000 rows, and a single leaf may hold a description, a certificate or a public key
 * that dwarfs 11 characters. These numbers are therefore a bound on what this grid will draw, not a
 * statement about what devices hold, and the first real device should be measured against them
 * rather than the other way round.
 */
export const ROW_LIMITS: RowLimits = Object.freeze({ maxRows: 10_000, maxCellChars: 64 * 1024 });

/** The child elements of `parent` that are entries of the list named `listName`. */
function entriesOf(parent: XmlElement, listName: string): readonly XmlElement[] {
  return parent.children.filter((child) => child.name === listName);
}

function isLeaf(element: XmlElement): boolean {
  return element.children.length === 0;
}

/**
 * Builds one cell.
 *
 * A leaf becomes its text. A repeated leaf becomes a JSON array, because a leaf-list is several
 * elements of the same name and a grid cell is one value. A container or a nested list becomes JSON,
 * so that the shape stays visible rather than being flattened into something that reads like a
 * scalar.
 */
function cellFor(entry: XmlElement, name: string, limits: RowLimits): string {
  const matches = entry.children.filter((child) => child.name === name);
  if (matches.length === 0) return "";
  const value =
    matches.length > 1
      ? JSON.stringify(matches.map((child) => (isLeaf(child) ? (child.text ?? "") : asJson(child))))
      : isLeaf(matches[0] as XmlElement)
        ? ((matches[0] as XmlElement).text ?? "")
        : JSON.stringify(asJson(matches[0] as XmlElement));
  return value.length > limits.maxCellChars ? value.slice(0, limits.maxCellChars) : value;
}

function asJson(element: XmlElement): unknown {
  if (isLeaf(element)) return element.text ?? "";
  const out: Record<string, unknown> = {};
  for (const child of element.children) {
    const existing = out[child.name];
    const value = asJson(child);
    if (existing === undefined) out[child.name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[child.name] = [existing, value];
  }
  return out;
}

/**
 * Builds the rows of one list.
 *
 * `keyNames` comes from the module's own key statement, read by `yangkeys.ts`. Key columns come
 * first, because a row is addressed by them and a reader looks for them first. A list with no key
 * names is still shown, by position, and its entries cannot be opened, which is how RFC 8040
 * section 3.5.3 treats a keyless list.
 */
export function buildRows(
  parent: XmlElement,
  listName: string,
  keyNames: readonly string[],
  limits: RowLimits = ROW_LIMITS,
): RowSet {
  const entries = entriesOf(parent, listName);
  const cut = entries.length > limits.maxRows;
  const taken = cut ? entries.slice(0, limits.maxRows) : entries;

  const seen = new Set<string>(keyNames);
  const columns: string[] = [...keyNames];
  for (const entry of taken) {
    for (const child of entry.children) {
      if (seen.has(child.name)) continue;
      seen.add(child.name);
      columns.push(child.name);
    }
  }

  const rows = taken.map((entry) => {
    const row: Record<string, string> = {};
    for (const column of columns) row[column] = cellFor(entry, column, limits);
    return row;
  });

  const warning = cut
    ? `This list holds more than ${limits.maxRows} entries, so the first ${limits.maxRows} are shown.`
    : undefined;
  return warning === undefined ? { columns, rows } : { columns, rows, warning };
}

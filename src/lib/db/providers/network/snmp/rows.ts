/**
 * How a varbind becomes a cell: the syntax its tag declares, the three exceptions, and the rows of a conceptual table.
 *
 * Shared by the console's `query` and the agent's read (`agent-read.ts`), so the agent renders a value exactly as the
 * editor does: one rendering, never a second one that could show control bytes the console hides.
 */
import type { ResponseVarbind } from "./message";
import type { Varbind } from "./read";
import { buildTable, type Cell, type RowKeyInput } from "./table";
import { isShowableText, renderValue, type ValueSyntax } from "./values";

/**
 * What the wire says a value is.
 *
 * The syntax comes from the tag the AGENT put on the value, not from what the bytes look like.
 * The one exception is OCTET STRING, which SNMP uses for both text and binary and which a MIB
 * would separate through its textual convention. With no MIB loaded there is nothing else to
 * read, so `isShowableText` decides, and it is the only place in this provider where a
 * rendering looks at content rather than at a declaration. A MIB makes this branch dead, which
 * is the right direction for it to go.
 */
export function syntaxFromTag(tag: number, bytes: Uint8Array): ValueSyntax {
  switch (tag) {
    case 0x02:
      return { kind: "integer" };
    case 0x06:
      return { kind: "objectIdentifier" };
    case 0x40:
      return { kind: "ipAddress" };
    case 0x41:
      return { kind: "counter32" };
    case 0x42:
      return { kind: "gauge32" };
    case 0x43:
      return { kind: "timeticks" };
    case 0x44:
      return { kind: "opaque" };
    case 0x46:
      return { kind: "counter64" };
    default:
      return isShowableText(bytes) ? { kind: "text" } : { kind: "octets" };
  }
}

/** RFC 3416 section 4.1: the three exceptions an agent answers with instead of a value. */
export const EXCEPTION_TAGS: Readonly<Record<number, "noSuchObject" | "noSuchInstance" | "endOfMibView">> = {
  0x80: "noSuchObject",
  0x81: "noSuchInstance",
  0x82: "endOfMibView",
};

/** What the walk needs to know about one varbind: where it is, how big, and whether it is a value. */
export function toWalkVarbind(varbind: ResponseVarbind): Varbind {
  return { oid: varbind.oid, status: EXCEPTION_TAGS[varbind.tag], bytes: varbind.value.length };
}

/**
 * The rows of a conceptual table, shaped by `buildTable` rather than here.
 *
 * A table's OIDs are `<table>.<entry>.<column>.<index>`, so the column is the sub-identifier
 * right after the subtree and the index is everything past it. Rows are keyed by that index,
 * which is what makes a short column an ABSENCE in a row rather than a shift of every row
 * below it. That distinction is the whole reason `table.ts` exists, and nothing here repeats
 * its reasoning: the varbinds go in and the shape comes out.
 */
export function tableRows(
  subtree: readonly number[],
  varbinds: readonly ResponseVarbind[],
): Array<Record<string, string>> {
  const cells = new Map<string, Map<string, Cell>>();
  const keys: RowKeyInput[] = [];
  const seenKeys = new Set<string>();
  for (const varbind of varbinds) {
    if (EXCEPTION_TAGS[varbind.tag] !== undefined) continue;
    const rest = varbind.oid.slice(subtree.length);
    if (rest.length < 2) continue;
    const column = `column${rest[0]}`;
    const index = rest.slice(1).join(".");
    if (!seenKeys.has(index)) {
      seenKeys.add(index);
      keys.push({ key: index, index: [{ kind: "text", value: index }], instanceSuffix: index });
    }
    const rendered = renderValue(syntaxFromTag(varbind.tag, varbind.value), varbind.value);
    const forColumn = cells.get(column) ?? new Map<string, Cell>();
    forColumn.set(index, { state: "present", value: rendered.display, raw: varbind.value });
    cells.set(column, forColumn);
  }
  const built = buildTable(
    keys,
    [...cells.entries()].map(([name, map]) => ({ name, cells: map })),
  );
  return built.rows.map((row) => {
    const out: Record<string, string> = { index: row.index.map((part) => String(part.value)).join(".") };
    for (const [name, cell] of row.cells) out[name] = cell.state === "present" ? cell.value : cell.state;
    return out;
  });
}

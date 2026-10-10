import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { KubernetesRequestError, KubernetesResponseTooLargeError } from "@/lib/db/providers/platform/kubernetes/errors";
import { KUBERNETES_MAX_EMPTY_PAGES } from "@/lib/db/providers/platform/kubernetes/limits";
import {
  cellOf,
  type KubeTable,
  parseTable,
  scanTable,
  type TablePageReader,
  tableGrid,
} from "@/lib/db/providers/platform/kubernetes/table";

const POD_TABLE = {
  kind: "Table",
  apiVersion: "meta.k8s.io/v1",
  metadata: { resourceVersion: "812", continue: "next-page" },
  columnDefinitions: [
    { name: "Name", type: "string", format: "name", priority: 0 },
    { name: "Ready", type: "string", format: "", priority: 0 },
    { name: "Status", type: "string", format: "", priority: 0 },
    { name: "Restarts", type: "integer", format: "", priority: 0 },
    { name: "IP", type: "string", format: "", priority: 1 },
    { name: "Ready Gates", type: "boolean", format: "", priority: 1 },
  ],
  rows: [
    { cells: ["web-1", "1/1", "Running", 0, "10.0.0.5", true], object: { metadata: { name: "web-1" } } },
    { cells: ["web-2", "0/1", "CrashLoopBackOff", "6 (3m29s ago)", null, false] },
  ],
};

describe("parseTable", () => {
  test("reads the columns, the rows with their objects, the continue token and the resourceVersion", () => {
    const table = parseTable(POD_TABLE);
    expect(table.columns.map((entry) => [entry.name, entry.type, entry.priority])).toEqual([
      ["Name", "string", 0],
      ["Ready", "string", 0],
      ["Status", "string", 0],
      ["Restarts", "integer", 0],
      ["IP", "string", 1],
      ["Ready Gates", "boolean", 1],
    ]);
    expect(table.rows[0].object).toEqual({ metadata: { name: "web-1" } });
    expect(table.rows[1].object).toBeUndefined();
    expect([table.continueToken, table.resourceVersion]).toEqual(["next-page", "812"]);
    expect(cellOf(table, table.rows[1], "Status")).toBe("CrashLoopBackOff");
    expect(cellOf(table, table.rows[1], "Age")).toBeUndefined();
  });

  test("the last page has no continue token; malformed definitions and rows are read defensively", () => {
    const table = parseTable({
      kind: "Table",
      metadata: { continue: "" },
      columnDefinitions: [{}, "x"],
      rows: [{ cells: "not cells" }, 4],
    });
    expect(table.continueToken).toBeUndefined();
    expect(table.columns).toEqual([
      { name: "", type: "string", format: "", priority: 0 },
      { name: "", type: "string", format: "", priority: 0 },
    ]);
    expect(table.rows).toEqual([{ cells: [] }]);
  });

  test("a plain list is read as Name and Created, the object kept", () => {
    const table = parseTable({
      kind: "WidgetList",
      metadata: { resourceVersion: "9" },
      items: [{ metadata: { name: "w1", creationTimestamp: "2026-10-10T10:00:00Z" } }, { spec: {} }, "x"],
    });
    expect(table.columns.map((entry) => entry.name)).toEqual(["Name", "Created"]);
    expect(table.rows.map((row) => row.cells)).toEqual([
      ["w1", "2026-10-10T10:00:00Z"],
      [null, null],
    ]);
    expect(table.resourceVersion).toBe("9");
  });

  test("an empty Table whose rows are null or absent reads as no rows, its columns and metadata kept", () => {
    for (const rows of [{ rows: null }, {}]) {
      const table = parseTable({
        kind: "Table",
        metadata: { resourceVersion: "41" },
        columnDefinitions: [
          { name: "Name", type: "string", format: "name", priority: 0 },
          { name: "Created At", type: "date", format: "", priority: 0 },
        ],
        ...rows,
      });
      expect(table.columns.map((entry) => entry.name)).toEqual(["Name", "Created At"]);
      expect(table.rows).toEqual([]);
      expect(table.resourceVersion).toBe("41");
    }
  });

  test("an empty list whose items are null reads as no rows", () => {
    const table = parseTable({ kind: "WidgetList", metadata: { resourceVersion: "3" }, items: null });
    expect(table.columns.map((entry) => entry.name)).toEqual(["Name", "Created"]);
    expect(table.rows).toEqual([]);
    expect(table.resourceVersion).toBe("3");
  });

  test("anything else is refused with a sentence", () => {
    for (const body of [
      null,
      "x",
      { kind: "Status" },
      { kind: "Table", rows: [] },
      { kind: "Table", columnDefinitions: [], rows: "x" },
      { kind: "Status", items: "x" },
    ]) {
      expect(() => parseTable(body)).toThrow(
        "The API server answered with neither a Table nor a list, so there is nothing to show.",
      );
    }
  });
});

describe("tableGrid", () => {
  const table = parseTable(POD_TABLE);
  test("shows the priority 0 columns, typed by the column type, cells as the server formatted them", () => {
    const grid = tableGrid(table, table.rows, { wide: false });
    expect(grid.fields).toEqual(["Name", "Ready", "Status", "Restarts"]);
    expect(grid.rows).toEqual([
      { Name: "web-1", Ready: "1/1", Status: "Running", Restarts: 0 },
      { Name: "web-2", Ready: "0/1", Status: "CrashLoopBackOff", Restarts: "6 (3m29s ago)" },
    ]);
    expect(grid.columnTypes).toEqual({ Name: "string", Ready: "string", Status: "string", Restarts: "integer" });
  });

  test("-o wide adds the priority columns; a null cell is null and an object cell is JSON text", () => {
    const grid = tableGrid(
      { columns: [...table.columns, { name: "Extra", type: "string", format: "", priority: 0 }] },
      [{ cells: ["web-1", "1/1", "Running", 0, null, true, { a: 1 }] }],
      { wide: true },
    );
    expect(grid.fields).toEqual(["Name", "Ready", "Status", "Restarts", "IP", "Ready Gates", "Extra"]);
    expect(grid.rows[0]).toEqual({
      Name: "web-1",
      Ready: "1/1",
      Status: "Running",
      Restarts: 0,
      IP: null,
      "Ready Gates": true,
      Extra: '{"a":1}',
    });
  });
});

/** A list of `total` rows served in pages, recording every page asked for. */
function pagedList(
  total: number,
  options: { readonly expireAt?: readonly number[]; readonly tooLargeAbove?: number } = {},
) {
  const asked: { readonly continueToken?: string; readonly limit: number }[] = [];
  const expired = [...(options.expireAt ?? [])];
  const read: TablePageReader = async (page) => {
    asked.push(page);
    if (options.tooLargeAbove !== undefined && page.limit > options.tooLargeAbove)
      throw new KubernetesResponseTooLargeError("too large");
    const start = page.continueToken === undefined ? 0 : Number(page.continueToken);
    if (page.continueToken !== undefined && expired[0] === start) {
      expired.shift();
      throw new KubernetesRequestError("expired", 410, "Expired", false);
    }
    const end = Math.min(total, start + page.limit);
    const rows = Array.from({ length: end - start }, (_unused, index) => ({ cells: [`row-${start + index}`] }));
    const table: KubeTable = {
      columns: [{ name: "Name", type: "string", format: "name", priority: 0 }],
      rows,
      ...(end < total ? { continueToken: String(end) } : {}),
      resourceVersion: "77",
    };
    return table;
  };
  return { read, asked };
}

const names = (rows: readonly { readonly cells: readonly unknown[] }[]) => rows.map((row) => row.cells[0]);

describe("scanTable", () => {
  test("reads one row past a 1,000 cap over pages of 500 and reports more", async () => {
    const list = pagedList(1_500);
    const scan = await scanTable(list.read, { offset: 0, limit: 1_001, pageSize: 500 });
    expect(scan.rows).toHaveLength(1_001);
    expect(scan.more).toBe(true);
    expect(list.asked.map((page) => page.continueToken)).toEqual([undefined, "500", "1000"]);
    expect(list.asked.map((page) => page.limit)).toEqual([500, 500, 1]);
    expect(scan.resourceVersion).toBe("77");
  });

  test("a window of no rows is refused before any page is read", async () => {
    const list = pagedList(3);
    await expect(scanTable(list.read, { offset: 0, limit: 0, pageSize: 500 })).rejects.toThrow(
      "A Table window reads at least one row.",
    );
    expect(list.asked).toEqual([]);
  });

  test("a list shorter than the window ends on its last page with no more", async () => {
    const scan = await scanTable(pagedList(3).read, { offset: 0, limit: 1_001, pageSize: 500 });
    expect([scan.rows.length, scan.more]).toEqual([3, false]);
  });

  test("returns the rows of the window only, across three continue pages", async () => {
    const list = pagedList(2_000);
    const scan = await scanTable(list.read, { offset: 450, limit: 100, pageSize: 200 });
    expect(names(scan.rows)).toEqual(Array.from({ length: 100 }, (_unused, index) => `row-${450 + index}`));
    expect(list.asked).toHaveLength(3);
    expect(scan.more).toBe(true);
  });

  test("a window that ends exactly at the end of the list reports no more", async () => {
    const scan = await scanTable(pagedList(500).read, { offset: 400, limit: 100, pageSize: 500 });
    expect([scan.rows.length, scan.more]).toEqual([100, false]);
  });

  test("a window past the end answers no rows", async () => {
    const scan = await scanTable(pagedList(10).read, { offset: 20, limit: 5, pageSize: 500 });
    expect([scan.rows.length, scan.more]).toEqual([0, false]);
  });

  test("a 410 restarts the walk once from the beginning and succeeds", async () => {
    const list = pagedList(1_200, { expireAt: [500] });
    const scan = await scanTable(list.read, { offset: 0, limit: 1_001, pageSize: 500 });
    expect(scan.rows).toHaveLength(1_001);
    expect(list.asked.map((page) => page.continueToken)).toEqual([undefined, "500", undefined, "500", "1000"]);
  });

  test("a second 410 answers its sentence", async () => {
    const list = pagedList(1_200, { expireAt: [500, 500] });
    await expect(scanTable(list.read, { offset: 0, limit: 1_001, pageSize: 500 })).rejects.toBeInstanceOf(
      KubernetesRequestError,
    );
  });

  test("a page past the byte cap restarts once at half the page size when asked to", async () => {
    const list = pagedList(600, { tooLargeAbove: 300 });
    const scan = await scanTable(list.read, { offset: 0, limit: 600, pageSize: 500, halveOnTooLarge: true });
    expect(scan.rows).toHaveLength(600);
    expect(list.asked.map((page) => page.limit)).toEqual([500, 250, 250, 100]);
  });

  test("a page still past the cap at half size, or of one object, answers a sentence to narrow", async () => {
    const twice = pagedList(600, { tooLargeAbove: 100 });
    await expect(
      scanTable(twice.read, { offset: 0, limit: 600, pageSize: 500, halveOnTooLarge: true }),
    ).rejects.toThrow(
      "A page of 250 objects with their metadata is still larger than 16 MiB; narrow the list with -n, -l or --field-selector.",
    );
    const single = pagedList(5, { tooLargeAbove: 0 });
    await expect(scanTable(single.read, { offset: 0, limit: 5, pageSize: 1, halveOnTooLarge: true })).rejects.toThrow(
      "A page of 1 objects",
    );
  });

  test("without halving, a page past the cap answers its own sentence; any other error passes", async () => {
    const list = pagedList(600, { tooLargeAbove: 100 });
    await expect(scanTable(list.read, { offset: 0, limit: 600, pageSize: 500 })).rejects.toBeInstanceOf(
      KubernetesResponseTooLargeError,
    );
    const failing: TablePageReader = async () => {
      throw new QueryError("boom");
    };
    await expect(scanTable(failing, { offset: 0, limit: 1, pageSize: 1 })).rejects.toThrow("boom");
  });
});

describe("scanTable: a list that does not advance", () => {
  const COLUMNS = [{ name: "Name", type: "string", format: "name", priority: 0 }];

  test("a continue token answered back unchanged is refused at once, not read again", async () => {
    let reads = 0;
    const read: TablePageReader = async () => {
      reads += 1;
      if (reads > 10) throw new Error("read past the guard");
      return { columns: COLUMNS, rows: [], continueToken: "same" };
    };
    await expect(scanTable(read, { offset: 0, limit: 1_001, pageSize: 500 })).rejects.toThrow(
      "The API server answered a list page with the continue token Studio had just sent, so the list does not advance; Studio stops rather than read the same page again.",
    );
    expect(reads).toBe(2);
  });

  test("pages with no rows and a fresh token every time are stopped by a count of empty pages", async () => {
    let reads = 0;
    const read: TablePageReader = async () => {
      reads += 1;
      if (reads > 100) throw new Error("read past the guard");
      return { columns: COLUMNS, rows: [], continueToken: `t${reads}` };
    };
    await expect(scanTable(read, { offset: 0, limit: 1_001, pageSize: 500 })).rejects.toThrow(
      `The API server answered ${KUBERNETES_MAX_EMPTY_PAGES} pages of this list with no objects and a continue token, so the list does not advance; Studio stops rather than read on.`,
    );
    expect(reads).toBe(KUBERNETES_MAX_EMPTY_PAGES);
  });

  test("a few empty pages with a fresh token, as a selector can answer, are read through", async () => {
    let reads = 0;
    const read: TablePageReader = async () => {
      reads += 1;
      if (reads < KUBERNETES_MAX_EMPTY_PAGES) return { columns: COLUMNS, rows: [], continueToken: `t${reads}` };
      return { columns: COLUMNS, rows: [{ cells: ["last"] }] };
    };
    const scan = await scanTable(read, { offset: 0, limit: 5, pageSize: 5 });
    expect(names(scan.rows)).toEqual(["last"]);
    expect(scan.more).toBe(false);
  });
});

import "../../setup-dom";
import "../../helpers/mock-navigation";

import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
import type { TreeRowModel } from "@/components/object-tree/flatten";
import { useTreeNodes } from "@/components/object-tree/use-tree-nodes";
import type { ProviderCapabilities } from "@/lib/db/types";
import type { ColumnSchema, DatabaseConnection } from "@/lib/types";

/**
 * The columns of one open object row (#789), driven the way a person drives them.
 *
 * Three states of the same row are kept apart here and nowhere else, because only a rendered row
 * can show that they LOOK different: a describe in flight spins in the glyph that was pressed, a
 * describe that answered with no column says so where a number would be, and a describe that was
 * refused carries the engine's own sentence. An open row with nothing under it and nothing said
 * would be all three at once, plus a rendering bug.
 *
 * Every case drives the ACTION rather than the render. What a person DOES with a row is a third
 * thing beyond what they see and what the model is told, and this epic already shipped a defect
 * in exactly that gap.
 */

type ObjectModel = Pick<ProviderCapabilities, "containerLevels" | "objectKinds">;

function capabilitiesOf(model: ObjectModel): ProviderCapabilities {
  return { queryLanguage: "sql", ...model } as ProviderCapabilities;
}

/** PostgreSQL-shaped: the relation declares its columns, the routine beside it declares none. */
const oneLevel = capabilitiesOf({
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
    { id: "function", role: "routine", label: "Function", labelPlural: "Functions" },
  ],
});

function connectionOf(): DatabaseConnection {
  return { id: "pg", name: "conn pg", type: "postgres", createdAt: new Date("2026-01-01") };
}

/**
 * `notes` carries an EMPTY type on purpose: `cassandra/objects.ts` maps a UDT field whose position
 * has no entry in `field_types` to `type: types[index] ?? ""`, and an empty span with an empty
 * tooltip in the right-hand slot reads as a rendering bug.
 */
const ordersColumns: ColumnSchema[] = [
  { name: "id", type: "integer", nullable: false, isPrimary: true },
  { name: "total", type: "NUMERIC(10,2)", nullable: true, isPrimary: false },
  { name: "notes", type: "", nullable: true, isPrimary: false },
];

const ordersDetail = { path: ["app", "orders"], columns: ordersColumns, indexes: [], foreignKeys: [] };

interface FetchCall {
  readonly route: string;
  readonly body: Record<string, unknown>;
}

type Handler = (body: Record<string, never>) => unknown;

interface Handlers {
  readonly containers?: Handler;
  readonly counts?: Handler;
  readonly list?: Handler;
  // A property named `describe` in a file that imports bun's `describe`. Legal: this is a member
  // name and never an identifier, and the route's own last path segment is what names it.
  readonly describe?: Handler;
}

const realFetch = globalThis.fetch;

/** Records every object-route call and answers it from `handlers`, by the route's last segment. */
function installFetch(handlers: Handlers): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    const route = text.slice(text.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ route, body });
    const answer = await handlers[route as keyof Handlers]?.(body as Record<string, never>);
    if (answer instanceof Response) return answer;
    if (answer === undefined) return Response.json({ error: `no handler for ${route}` }, { status: 500 });
    return Response.json(answer);
  }) as never;
  return calls;
}

/**
 * The whole fixture: one schema, two tables, one of which the describe handler answers for, and
 * one function.
 *
 * The function is an OBJECT ROW of a kind that declares no columns, and it is here because the
 * control below needs one: a Functions folder that lists nothing leaves that control asserting
 * the FOLDER's own twisty, which every folder has whatever a kind declares.
 */
function routesFor(describeHandler: Handler): FetchCall[] {
  return installFetch({
    containers: () => [{ path: ["app"], name: "app", level: 0, isSessionDefault: true }],
    counts: () => ({ table: { count: 2 }, function: { count: 1 } }),
    list: (body) =>
      String(body.kind) === "table"
        ? [
            { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1234 },
            { path: ["app", "customers"], name: "customers", kind: "table" },
          ]
        : [{ path: ["app", "order_total"], name: "order_total", kind: "function" }],
    describe: describeHandler,
  });
}

/**
 * The SECOND expandable kind, which is what makes the request's own fields observable at all.
 *
 * Every other case in this file expands `app.orders`, a `table`. With one expandable kind and one
 * object in the fixture, every field the tree threads into the describe request can be replaced
 * by a literal and stay green, and four of them were: the request's `kind`, the request's `path`,
 * the embedded adapter's `kind` and the kind segment of a column row's id each survived all
 * twelve test files that render a row, 604 tests.
 *
 * Cassandra-shaped, because that is the measured failure rather than an invented one. A UDT row
 * expands through the same describe route, and `describeObject` sends the kind `type` to
 * `system_schema.types`; a request that says `table` for it falls through to the table-columns
 * CQL, reads zero rows and raises "No Cassandra table named address in shipping", which the row
 * then draws as the engine's own refusal. Three of that provider's kinds declare columns and only
 * one of them is `table`, which is the whole reason the declaration is per kind.
 */
const cassandra = capabilitiesOf({
  containerLevels: [{ id: "schema", label: "Keyspace", labelPlural: "Keyspaces" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables", hasColumns: true },
    { id: "type", role: "config", label: "Type", labelPlural: "Types", hasColumns: true },
  ],
});

function cassandraConnection(): DatabaseConnection {
  return { id: "cass", name: "conn cassandra", type: "cassandra", createdAt: new Date("2026-01-01") };
}

/** One keyspace, one table, and the user-defined type the case below opens. */
function keyspaceRoutes(): FetchCall[] {
  return installFetch({
    containers: () => [{ path: ["shipping"], name: "shipping", level: 0, isSessionDefault: true }],
    counts: () => ({ table: { count: 1 }, type: { count: 1 } }),
    list: (body) =>
      String(body.kind) === "type"
        ? [{ path: ["shipping", "address"], name: "address", kind: "type" }]
        : [{ path: ["shipping", "events"], name: "events", kind: "table" }],
    describe: () => ({
      path: ["shipping", "address"],
      columns: [
        { name: "street", type: "text", nullable: true, isPrimary: false },
        { name: "zip", type: "int", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    }),
  });
}

function row(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

function describeCalls(calls: readonly FetchCall[]): FetchCall[] {
  return calls.filter((call) => call.route === "describe");
}

/** Renders the tree and opens the Tables folder, which is everything before the gesture. */
async function openTables(refreshToken = 0): Promise<ReturnType<typeof render>> {
  const view = render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} refreshToken={refreshToken} />);
  await screen.findByRole("treeitem", { name: /Tables/ });
  await within(row(/Tables/)).findByTestId("tree-row-badge");
  await userEvent.click(row(/Tables/));
  await screen.findByText("orders");
  return view;
}

/** Presses the twisty of a row, which is the only pointer target that opens an object. */
async function pressTwisty(name: string | RegExp): Promise<void> {
  await userEvent.click(within(row(name)).getByTestId("tree-row-twisty"));
}

function columnRows(): HTMLElement[] {
  return screen.getAllByRole("treeitem").filter((item) => item.getAttribute("aria-level") === "4");
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("expanding an object row reads its columns", () => {
  test("the twisty posts one describe for that row and draws a leaf per column", async () => {
    const calls = routesFor(() => ordersDetail);
    await openTables();

    // The affordance is on the row the kind declares columns for, and the `expanded` state the
    // pattern announces comes with it.
    expect(row(/orders/).getAttribute("aria-expanded")).toBe("false");
    await pressTwisty(/orders/);
    await screen.findByText("total");

    expect(describeCalls(calls)).toHaveLength(1);
    expect(describeCalls(calls)[0].body).toMatchObject({ path: ["app", "orders"], kind: "table" });
    expect(row(/orders/).getAttribute("aria-expanded")).toBe("true");
    expect(columnRows().map((item) => within(item).getByTestId("tree-row-label").textContent)).toEqual([
      "id",
      "total",
      "notes",
    ]);
    // A column is one level below its object, and its aria position describes the COLUMN group
    // rather than the window: three of three, never three of the rows on screen.
    expect(columnRows().map((item) => item.getAttribute("aria-posinset"))).toEqual(["1", "2", "3"]);
    expect(columnRows().every((item) => item.getAttribute("aria-setsize") === "3")).toBe(true);
    // The twisty is a real button inside the treeitem, and a control inside a treeitem folds its
    // own name into the row's unless the row names itself by reference. This is that check: the
    // row's name must not have grown by "Collapse orders".
    expect(screen.getByRole("treeitem", { name: "orders 1,234" })).toBe(row(/orders/));
  });

  test("the request carries the row's OWN kind and path, and so does every column id", async () => {
    // A `type` in the keyspace `shipping`: not one segment of it is what the `table` fixture
    // above would answer, so a literal in any of the places this pair is threaded through shows
    // up in one of the two assertions below. The body is what the route parses, and `data-row-id`
    // is the id the focus effect, React's list key and `rowOf` all match a column row on.
    const calls = keyspaceRoutes();
    render(<ObjectTree connection={cassandraConnection()} capabilities={cassandra} />);
    await screen.findByRole("treeitem", { name: /Types/ });
    await within(row(/Types/)).findByTestId("tree-row-badge");
    await userEvent.click(row(/Types/));
    await screen.findByText("address");
    await pressTwisty(/address/);
    await screen.findByText("street");

    expect(describeCalls(calls)).toHaveLength(1);
    expect(describeCalls(calls)[0].body).toMatchObject({ path: ["shipping", "address"], kind: "type" });
    expect(columnRows().map((item) => item.getAttribute("data-row-id"))).toEqual([
      "column%3Ashipping/address/type/street",
      "column%3Ashipping/address/type/zip",
    ]);
  });

  test("a second expansion of the same row posts nothing", async () => {
    const calls = routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");

    await pressTwisty(/orders/);
    await waitFor(() => expect(row(/orders/).getAttribute("aria-expanded")).toBe("false"));
    await pressTwisty(/orders/);
    await screen.findByText("total");

    expect(describeCalls(calls)).toHaveLength(1);
  });

  test("a kind that declares no columns is offered no twisty at all", async () => {
    // The control for every case above: the same tree, the same pointer, an OBJECT of a kind that
    // declared nothing. It has to be an object row and not the folder over it, which is what this
    // case asserted while the Functions folder listed nothing: a folder carries a twisty whatever
    // the kind declares, so a change that gave every object row one left it green.
    const calls = routesFor(() => ordersDetail);
    await openTables();
    await userEvent.click(row(/Functions/));

    const routine = await screen.findByRole("treeitem", { name: /order_total/ });
    expect(row(/Functions/).getAttribute("aria-expanded")).toBe("true");
    expect(within(routine).queryAllByTestId("tree-row-twisty")).toHaveLength(0);
    expect(routine.hasAttribute("aria-expanded")).toBe(false);
    // The control's own control, on the same screen: the kind that DID declare columns has one.
    expect(within(row(/customers/)).queryByTestId("tree-row-twisty")).not.toBeNull();
    // And the gesture, not only the render: activating the row reads nothing either, so the
    // affordance is absent rather than merely undrawn.
    await userEvent.click(routine);
    expect(describeCalls(calls)).toHaveLength(0);
  });

  test("the chevron points down when the row is open and right when it is closed", async () => {
    // The glyph is what a SIGHTED reader reads, and nothing else in this suite looks at it:
    // `aria-expanded` and the button's own label carry the state for everyone else, so swapping
    // the two chevrons survived every assertion here until this test existed. Measured by
    // mutation: reversing them left 153 tests green.
    routesFor(() => ordersDetail);
    await openTables();

    const glyphOf = (name: RegExp): string =>
      within(row(name)).getByTestId("tree-row-twisty").querySelector("svg")?.getAttribute("class") ?? "";
    expect(glyphOf(/orders/)).toContain("lucide-chevron-right");

    await pressTwisty(/orders/);
    await screen.findByText("total");
    expect(glyphOf(/orders/)).toContain("lucide-chevron-down");
  });

  test("a LEAF draws no chevron at all, which is what says it cannot be opened", async () => {
    // The other half of the same blind spot: a leaf that grew a chevron would promise a gesture
    // that does nothing, and no assertion in this suite would have noticed. A column row is the
    // leaf this change introduces, so it is the one driven here.
    routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");

    const column = row(/^total/);
    expect(column.querySelectorAll("svg[class*='lucide-chevron']")).toHaveLength(0);
    // The control, on the same screen: the row it hangs under does draw one.
    expect(row(/orders 1,234/).querySelectorAll("svg[class*='lucide-chevron']").length).toBeGreaterThan(0);
  });

  test("the press leaves focus on the row, so the arrow keys still work", async () => {
    // `tabIndex={-1}` keeps the button out of the tab order, and a pointer press still focuses it
    // in most browsers. `toggleRow` calls `focusRow`, whose effect focuses the row element by
    // `data-row-id`, and that repair is asserted rather than assumed.
    routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");

    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/orders/table"));
  });
});

describe("a column row draws the column and nothing of its parent", () => {
  test("the declared type is truncated at the first paren, and the whole of it reaches the name", async () => {
    // `title` never reaches the accessible name of a row that names itself with
    // `aria-labelledby`: it is the last-resort name source and is dropped the moment a name
    // exists. Without the sr-only twin a screen reader would hear "NUMERIC" for `NUMERIC(10,2)`.
    routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");

    const total = row("total NUMERIC(10,2)");
    const type = within(total).getByTestId("tree-row-column-type");
    expect(type.getAttribute("title")).toBe("NUMERIC(10,2)");
    expect(type.querySelector("[aria-hidden='true']")?.textContent).toBe("NUMERIC");
    expect(type.textContent).toContain("NUMERIC(10,2)");
  });

  test("a column whose type the engine did not give renders no type slot", async () => {
    routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("notes");

    const notes = row("notes");
    expect(within(notes).queryByTestId("tree-row-column-type")).toBeNull();
    expect(within(notes).queryByTestId("tree-row-primary")).toBeNull();
  });

  test("the primary key is marked, and the mark is a word rather than only a glyph", async () => {
    routesFor(() => ordersDetail);
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("id");

    const id = row("id Primary key integer");
    expect(within(id).getByTestId("tree-row-primary").textContent).toBe("Primary key");
    // The glyph is `aria-hidden`, like every icon in this row: the fact reaches the name through
    // the text twin, which is the same shape the status slot uses.
    expect(within(id).queryByTestId("tree-row-column-type")?.getAttribute("title")).toBe("integer");
    expect(within(row("total NUMERIC(10,2)")).queryByTestId("tree-row-primary")).toBeNull();
  });

  test("a column row is offered no menu, carries no status and carries no row count", async () => {
    routesFor(() => ordersDetail);
    render(
      <ObjectTree
        connection={connectionOf()}
        capabilities={oneLevel}
        actions={{ onGenerateSelect: () => {}, onProfileObject: () => {} }}
      />,
    );
    await screen.findByRole("treeitem", { name: /Tables/ });
    await within(row(/Tables/)).findByTestId("tree-row-badge");
    await userEvent.click(row(/Tables/));
    await screen.findByText("orders");
    await pressTwisty(/orders/);
    await screen.findByText("total");

    // The parent has a menu, which is what makes the column's absence a statement: the column is
    // not an object, so `objectFor` misses and `rowActions` refuses.
    expect(within(row(/orders 1,234/)).getByTestId("tree-row-menu-trigger")).toBeTruthy();
    for (const column of columnRows()) {
      expect(within(column).queryByTestId("tree-row-menu-trigger")).toBeNull();
      expect(column.hasAttribute("aria-haspopup")).toBe(false);
      expect(within(column).queryByTestId("tree-row-count")).toBeNull();
      expect(within(column).queryByTestId("tree-row-status")).toBeNull();
      expect(column.hasAttribute("aria-expanded")).toBe(false);
    }
  });

  test("a column row misses the object index even when it carries its parent's address", async () => {
    // The miss is by CONSTRUCTION today, because a column row carries no kind id and its path
    // names the column. It is asserted rather than left to that arithmetic: `ObjectKindSpec.id`
    // is an OPEN string, and without the arm a row that ever did address itself like its parent
    // would draw the table's status icon and its row count on every column.
    routesFor(() => ordersDetail);
    const { result } = renderHook(() => useTreeNodes(connectionOf(), oneLevel));
    await waitFor(() => expect(result.current.rows.some((r) => r.kind === "folder")).toBe(true));
    act(() => result.current.toggle("app/table"));
    await waitFor(() => expect(result.current.rows.some((r) => r.kind === "object")).toBe(true));

    const parentAddress: TreeRowModel = {
      id: "column%3Aapp/orders/table/total",
      kind: "column",
      label: "total",
      depth: 3,
      setSize: 1,
      posInSet: 1,
      path: ["app", "orders"],
      kindId: "table",
      column: { name: "total", type: "NUMERIC(10,2)", nullable: true, isPrimary: false },
    };
    expect(result.current.objectFor(parentAddress)).toBeUndefined();
    // The control: the same address on an OBJECT row resolves, so the miss above is the row kind
    // and not an empty index.
    expect(result.current.objectFor({ ...parentAddress, kind: "object" })?.name).toBe("orders");
  });
});

describe("the three states of a describe", () => {
  test("a read in flight spins in the glyph that was pressed, and only there", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    routesFor(() => pending);
    await openTables();
    await pressTwisty(/orders/);

    const orders = row(/orders/);
    await waitFor(() => expect(orders.getAttribute("aria-busy")).toBe("true"));
    const twisty = within(orders).getByTestId("tree-row-twisty");
    expect(twisty.querySelector(".animate-spin")).not.toBeNull();
    // One read, one spinner: the row must not also draw the mid-row one beside the label.
    expect(orders.querySelectorAll(".animate-spin")).toHaveLength(1);

    await act(async () => {
      release(ordersDetail);
      await Promise.resolve();
    });
    await screen.findByText("total");
    expect(row(/orders 1,234/).hasAttribute("aria-busy")).toBe(false);
  });

  test("a read that answered with no column says so, where the row count would be", async () => {
    // Four engines answer an object dropped between the listing and the expand this way, and a
    // Couchbase INFER the reader has no SELECT grant for answers the same. Silence would make
    // those, the unread row and a rendering bug one screen.
    routesFor(() => ({ path: ["app", "orders"], columns: [], indexes: [], foreignKeys: [] }));
    await openTables();
    await pressTwisty(/orders/);

    const orders = await screen.findByRole("treeitem", { name: "orders No columns reported" });
    expect(within(orders).getByTestId("tree-row-unavailable").textContent).toBe("No columns reported");
    expect(orders.getAttribute("aria-expanded")).toBe("true");
    expect(orders.hasAttribute("aria-busy")).toBe(false);
    // The estimate stands down for the sentence: a number nobody asked about beside a sentence
    // cut to four characters is worse than the number being absent for one render.
    expect(within(orders).queryByTestId("tree-row-count")).toBeNull();
    expect(columnRows()).toHaveLength(0);
  });

  test("a refused read carries the engine's own sentence, and re-opening asks again", async () => {
    let attempt = 0;
    const calls = routesFor(() => {
      attempt += 1;
      return attempt === 1
        ? Response.json({ error: "permission denied for table orders" }, { status: 403 })
        : ordersDetail;
    });
    await openTables();
    await pressTwisty(/orders/);

    const failed = await screen.findByRole("treeitem", { name: "orders permission denied for table orders" });
    expect(within(failed).getByTestId("tree-row-failure").textContent).toBe("permission denied for table orders");
    expect(within(failed).queryByTestId("tree-row-count")).toBeNull();
    expect(columnRows()).toHaveLength(0);

    // Collapse and re-expand is the retry gesture: one timeout must not make a table unreadable
    // for the life of the connection.
    await pressTwisty(/orders/);
    await waitFor(() => expect(row(/orders/).getAttribute("aria-expanded")).toBe("false"));
    await pressTwisty(/orders/);
    await screen.findByText("total");
    expect(describeCalls(calls)).toHaveLength(2);
  });

  test("the twisty names the gesture it performs, and the name flips with the row", async () => {
    // The label is the only thing that tells a keyboard or screen-reader user which way this press
    // goes: the button carries no `aria-expanded` on purpose, because the treeitem already does and
    // announcing the state twice is noise. Nothing asserted the label until now, so
    // `aria-label={`Toggle ${row.label}`}` survived every test in this file.
    routesFor(() => ordersDetail);
    await openTables();

    const twistyName = (): string =>
      within(row(/orders/))
        .getByTestId("tree-row-twisty")
        .getAttribute("aria-label") ?? "";
    expect(twistyName()).toBe("Expand orders");

    await pressTwisty(/orders/);
    await screen.findByText("total");
    expect(twistyName()).toBe("Collapse orders");
  });

  test("a FOLDER keeps its failure while closed, which is the half the object gate must not take", async () => {
    // The control for the gate one test below. `failureFor` returns nothing for a CLOSED OBJECT,
    // and the narrowness of that is load-bearing: a folder's read is about the folder itself and
    // has always been offered whether or not the row is open, so widening the gate to every row
    // kind would silently drop a listing failure the reader can still act on. Dropping
    // `row.kind === "object" &&` from the gate leaves this file green without this case.
    installFetch({
      containers: () => [{ path: ["app"], name: "app", level: 0, isSessionDefault: true }],
      counts: () => ({ table: { count: 2 }, function: { count: 1 } }),
      list: () => Response.json({ error: "relation listing refused" }, { status: 403 }),
      describe: () => ordersDetail,
    });
    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} />);
    await userEvent.click(await screen.findByRole("treeitem", { name: /Tables/ }));
    const openFolder = await screen.findByRole("treeitem", { name: /Tables .*relation listing refused/ });
    expect(within(openFolder).getByTestId("tree-row-failure").textContent).toBe("relation listing refused");

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-expanded")).toBe("false"));
    expect(within(row(/Tables/)).getByTestId("tree-row-failure").textContent).toBe("relation listing refused");
  });

  test("a CLOSED object says nothing about a read that failed while it was open", async () => {
    // The walk already holds this rule for the sibling slot: `unavailable` is derived from the
    // detail and the detail is only read while the row is open, so a closed object never says
    // "No columns reported". The failure slot reached the render by another path, `failureFor`,
    // which answered for any object row whose `expanded` is merely DEFINED, and `false` is
    // defined. A collapsed table then kept a sentence about contents nobody can see, in the
    // `ml-auto` space its row count wants, for the life of the connection.
    routesFor(() => Response.json({ error: "permission denied for table orders" }, { status: 403 }));
    await openTables();
    await pressTwisty(/orders/);
    await screen.findByRole("treeitem", { name: "orders permission denied for table orders" });

    await pressTwisty(/orders/);
    await waitFor(() => expect(row(/orders/).getAttribute("aria-expanded")).toBe("false"));
    // The name is the assertion, and it carries both halves: the sentence is gone, and the row
    // count it had displaced is back. A row still holding the refusal matches neither.
    const closed = screen.getByRole("treeitem", { name: "orders 1,234" });
    expect(within(closed).queryByTestId("tree-row-failure")).toBeNull();
    expect(within(closed).getByTestId("tree-row-count").textContent).toBe("1.2K");
  });

  test("a body of the wrong shape is reported, and the tree stays mounted", async () => {
    // `column.name` reaches `pathKey`, which calls `replaceAll` on it, so a non-string throws
    // INSIDE the walk and unmounts the tree with every panel that could have reported it.
    routesFor(() => ({ path: ["app", "orders"], columns: [{ name: "id", type: 7 }] }));
    await openTables();
    await pressTwisty(/orders/);

    const orders = await screen.findByRole("treeitem", {
      name: "orders The describe reading answered with a body this tree cannot render",
    });
    expect(within(orders).getByTestId("tree-row-failure")).toBeTruthy();
    expect(screen.getByTestId("object-tree")).toBeTruthy();
    expect(screen.getByText("customers")).toBeTruthy();
  });

  test("a body whose column NAME is not a string is reported, and the tree stays mounted", async () => {
    // The sibling of the case above, on the OTHER conjunct of the same guard, and the dangerous
    // half: `column.type` is only `.split("(")` inside a row, while `column.name` reaches
    // `pathKey`'s `replaceAll` INSIDE the walk, so a number there throws where nothing can catch
    // it for a row. Measured with the name conjunct removed: this case reports "An error occurred
    // in the <ObjectTree> component" and the failure cascades into the next test in the file.
    routesFor(() => ({ path: ["app", "orders"], columns: [{ name: 7, type: "integer" }] }));
    await openTables();
    await pressTwisty(/orders/);

    const orders = await screen.findByRole("treeitem", {
      name: "orders The describe reading answered with a body this tree cannot render",
    });
    expect(within(orders).getByTestId("tree-row-failure")).toBeTruthy();
    expect(screen.getByTestId("object-tree")).toBeTruthy();
    expect(screen.getByText("customers")).toBeTruthy();
  });
});

describe("a catalog change re-reads the columns that are on screen", () => {
  test("an OPEN object's columns are re-read exactly once", async () => {
    const calls = routesFor(() => ordersDetail);
    const { rerender } = await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");
    expect(describeCalls(calls)).toHaveLength(1);

    rerender(<ObjectTree connection={connectionOf()} capabilities={oneLevel} refreshToken={1} />);
    await waitFor(() => expect(describeCalls(calls)).toHaveLength(2));
    // And no more: `run` keys its in-flight set by connection and slot, so two renders in one
    // frame issue one describe.
    await waitFor(() => expect(screen.getByText("total")).toBeTruthy());
    expect(describeCalls(calls)).toHaveLength(2);
  });

  test("a COLLAPSED object's columns are dropped, so re-opening reads the new ones", async () => {
    // The one place in `refresh` that empties a slot rather than issuing over it. A reader who
    // collapses `orders`, runs `ALTER TABLE app.orders ADD COLUMN note text` and re-expands would
    // otherwise see the old columns with no spinner, no failure and nothing able to evict them.
    let attempt = 0;
    const calls = routesFor(() => {
      attempt += 1;
      return attempt === 1
        ? ordersDetail
        : {
            ...ordersDetail,
            columns: [...ordersColumns, { name: "note", type: "text", nullable: true, isPrimary: false }],
          };
    });
    const { rerender } = await openTables();
    await pressTwisty(/orders/);
    await screen.findByText("total");
    await pressTwisty(/orders/);
    await waitFor(() => expect(row(/orders/).getAttribute("aria-expanded")).toBe("false"));

    rerender(<ObjectTree connection={connectionOf()} capabilities={oneLevel} refreshToken={1} />);
    // Nothing is re-read for a row nobody can see, which is the other half of the rule.
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    expect(describeCalls(calls)).toHaveLength(1);

    await pressTwisty(/orders/);
    expect(await screen.findByText("note")).toBeTruthy();
    expect(describeCalls(calls)).toHaveLength(2);
  });
});

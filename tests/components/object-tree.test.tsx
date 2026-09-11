import "../setup-dom";
import "../helpers/mock-navigation";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
import { treeWindow } from "@/components/object-tree/ObjectTree";
import { useTreeNodes } from "@/components/object-tree/use-tree-nodes";
import { ApiErrorCode } from "@/lib/api/error-codes";
import type { DatabaseObject, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The object tree, its hook and its row (#789).
 *
 * The three absence states are the point of this surface and are asserted as three different
 * outcomes: an undeclared kind draws NO folder, `{ count: 0 }` draws a folder with a zero badge,
 * and `{ unavailable }` draws the engine's own sentence on a row that cannot be opened. A fourth
 * state sits above them: sixteen of seventeen engines answer 501 today, and that has to read as
 * "this engine is not wired up yet" rather than as an empty database.
 */

// Only the object-model half of the capabilities is declared. `Pick` binds these two field names
// to the real type, so renaming either one in `ProviderCapabilities` fails this file rather than
// leaving every fixture silently describing nothing.
type ObjectModel = Pick<ProviderCapabilities, "containerLevels" | "objectKinds">;

function capabilitiesOf(model: ObjectModel): ProviderCapabilities {
  return { queryLanguage: "sql", ...model } as ProviderCapabilities;
}

/**
 * A connection the server has never heard of, which is what the tree posts in full.
 * `useTreeNodes` keys its cache on `connection.id`, so the id is still the identity every
 * assertion in this file uses; the object is rebuilt per render deliberately, because a
 * caller re-deriving it from a list is what the sidebar actually does.
 */
function connectionOf(id: string): DatabaseConnection {
  return { id, name: `conn ${id}`, type: "postgres", createdAt: new Date("2026-01-01") };
}

const oneLevel = capabilitiesOf({
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  ],
});

const noContainers = capabilitiesOf({
  containerLevels: [],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
});

const twoLevels = capabilitiesOf({
  containerLevels: [
    { id: "catalog", label: "Catalog", labelPlural: "Catalogs" },
    { id: "schema", label: "Schema", labelPlural: "Schemas" },
  ],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
});

interface FetchCall {
  readonly route: string;
  readonly body: Record<string, unknown>;
}

type Handler = (body: Record<string, never>) => unknown;

interface Handlers {
  readonly containers?: Handler;
  readonly counts?: Handler;
  readonly list?: Handler;
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
    // Awaited, so a handler may hand back a promise the test releases later.
    const answer = await handlers[route as keyof Handlers]?.(body as Record<string, never>);
    if (answer instanceof Response) return answer;
    if (answer === undefined) return Response.json({ error: `no handler for ${route}` }, { status: 500 });
    return Response.json(answer);
  }) as never;
  return calls;
}

/** The 501 sixteen of seventeen engines answer today. */
function unimplemented(method: string): Response {
  return Response.json(
    {
      error: `The mysql provider does not implement ${method} yet (#789). That is a gap in the provider, not an empty database.`,
      code: ApiErrorCode.OBJECT_SURFACE_UNIMPLEMENTED,
      statusCode: 501,
    },
    { status: 501 },
  );
}

const appSchema = [{ path: ["app"], name: "app", level: 0 }];

function routesFor(objects: Record<string, DatabaseObject[]>, counts: Record<string, unknown> = {}): Handlers {
  return {
    containers: () => appSchema,
    counts: () => counts,
    list: (body) => objects[String(body.kind)] ?? [],
  };
}

function row(name: string | RegExp): HTMLElement {
  return screen.getByRole("treeitem", { name });
}

async function expandApp(): Promise<void> {
  await userEvent.click(await screen.findByRole("treeitem", { name: /app/ }));
  await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("ObjectTree", () => {
  beforeEach(() => {
    installFetch(
      routesFor(
        { view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] },
        { table: { count: 2 }, view: { count: 4 } },
      ),
    );
  });

  test("renders one container row and no object rows before anything is expanded", async () => {
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    expect(await screen.findByRole("treeitem", { name: /app/ })).toBeTruthy();
    expect(screen.queryByText("order_summary")).toBeNull();
  });

  test("every row carries its aria position, which virtualisation would otherwise lose", async () => {
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    const container = await screen.findByRole("treeitem", { name: /app/ });
    expect(container.getAttribute("aria-level")).toBe("1");
    expect(container.getAttribute("aria-setsize")).toBe("1");
    expect(container.getAttribute("aria-posinset")).toBe("1");
  });

  test("expanding a container draws one folder per declared kind, including the empty one", async () => {
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();
    expect(row(/Views/)).toBeTruthy();
  });

  test("a folder is only fetched when it is opened", async () => {
    const calls = installFetch(
      routesFor(
        { view: [{ path: ["app", "order_summary"], name: "order_summary", kind: "view" }] },
        { table: { count: 2 }, view: { count: 4 } },
      ),
    );
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();
    expect(calls.filter((call) => call.route === "list")).toHaveLength(0);

    await userEvent.click(row(/Views/));
    await waitFor(() => expect(screen.getByText("order_summary")).toBeTruthy());
    expect(calls.filter((call) => call.route === "list").map((call) => call.body.kind)).toEqual(["view"]);
  });

  test("keyboard navigation follows the tree pattern", async () => {
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    const container = await screen.findByRole("treeitem", { name: /app/ });
    container.focus();
    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(container.getAttribute("aria-expanded")).toBe("true"));
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(container.getAttribute("aria-expanded")).toBe("false"));
  });
});

describe("ObjectTree aria positions", () => {
  test("a sibling group of two reports a set size of two and distinct positions", async () => {
    installFetch({
      containers: () => [
        { path: ["app"], name: "app", level: 0 },
        { path: ["sales"], name: "sales", level: 0 },
      ],
      counts: () => ({}),
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    const app = await screen.findByRole("treeitem", { name: /app/ });
    const sales = row(/sales/);

    expect([app.getAttribute("aria-setsize"), app.getAttribute("aria-posinset")]).toEqual(["2", "1"]);
    expect([sales.getAttribute("aria-setsize"), sales.getAttribute("aria-posinset")]).toEqual(["2", "2"]);
  });

  test("the tab stop is not a selection: nothing is selected until the reader picks a row", async () => {
    installFetch(routesFor({}, { table: { count: 0 }, view: { count: 0 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    const app = await screen.findByRole("treeitem", { name: /app/ });

    // Reachable by keyboard from the first paint, and announced as chosen by nobody.
    expect(app.getAttribute("tabindex")).toBe("0");
    expect(app.getAttribute("aria-selected")).toBe("false");

    await expandApp();
    expect(row(/app/).getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getAllByRole("treeitem").filter((item) => item.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
  });

  test("a folder reports its level and its position among the declared kinds", async () => {
    installFetch(routesFor({}, { table: { count: 1 }, view: { count: 0 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    expect(row(/Tables/).getAttribute("aria-level")).toBe("2");
    expect([row(/Tables/).getAttribute("aria-posinset"), row(/Tables/).getAttribute("aria-setsize")]).toEqual([
      "1",
      "2",
    ]);
    expect([row(/Views/).getAttribute("aria-posinset"), row(/Views/).getAttribute("aria-setsize")]).toEqual(["2", "2"]);
  });
});

describe("ObjectTree absence states", () => {
  test("a kind the engine never declared draws no folder", async () => {
    installFetch(routesFor({}, { table: { count: 1 }, view: { count: 0 }, sequence: { count: 9 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    expect(screen.queryByRole("treeitem", { name: /Sequence/ })).toBeNull();
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  test("a declared kind holding nothing draws a folder with a zero badge", async () => {
    installFetch(routesFor({}, { table: { count: 1 }, view: { count: 0 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    expect(within(row(/Views/)).getByTestId("tree-row-badge").textContent).toBe("0");
    expect(row(/Views/).getAttribute("aria-expanded")).toBe("false");
  });

  test("a refused count draws the engine's own sentence and a row that cannot be opened", async () => {
    const calls = installFetch(
      routesFor({}, { table: { count: 1 }, view: { unavailable: "permission denied for schema app" } }),
    );
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    const views = row(/Views/);
    expect(within(views).getByTestId("tree-row-unavailable").textContent).toBe("permission denied for schema app");
    expect(within(views).queryByTestId("tree-row-badge")).toBeNull();
    expect(views.hasAttribute("aria-expanded")).toBe(false);

    await userEvent.click(views);
    expect(calls.filter((call) => call.route === "list")).toHaveLength(0);
  });

  test("a bounded count draws a FLOOR the reader can see, and an exact one beside it does not", async () => {
    // All four facts have to be distinguishable in the rendered row, and this test renders
    // three of them at once against the fourth: `0` (holds none), the refusal sentence, an
    // exact `1,204`, and `1,204+` for the same number counted from a bounded read. The mark
    // is in the badge TEXT rather than in a colour or a title alone, because the text is
    // what a screen reader announces and what a person scanning a column sees (#789).
    installFetch(
      routesFor(
        {},
        {
          table: { count: 1204, sampledFrom: "the first 1,000 keys of one SCAN walk" },
          view: { count: 1204 },
        },
      ),
    );
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    const sampled = within(row(/Tables/)).getByTestId("tree-row-badge");
    const exact = within(row(/Views/)).getByTestId("tree-row-badge");
    expect(sampled.textContent).toBe("1,204+");
    expect(sampled.getAttribute("title")).toBe("At least 1,204: counted from the first 1,000 keys of one SCAN walk");
    expect(exact.textContent).toBe("1,204");
    // No title on the exact one: hovering is itself the difference, so a generic title here
    // would take that signal away from the reader who went looking for it.
    expect(exact.hasAttribute("title")).toBe(false);
    // And a floor is not a refusal: the folder still opens.
    expect(row(/Tables/).getAttribute("aria-expanded")).toBe("false");
  });

  test("a badge is the engine's count and never the length of the loaded list", async () => {
    installFetch(
      routesFor(
        { table: [{ path: ["app", "orders"], name: "orders", kind: "table" }] },
        { table: { count: 43512 }, view: { count: 0 } },
      ),
    );
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());

    expect(within(row(/Tables/)).getByTestId("tree-row-badge").textContent).toBe("43,512");
  });
});

describe("ObjectTree engine gaps", () => {
  test("a 501 reads as an unmigrated engine, names the engine's sentence and offers no retry", async () => {
    const calls = installFetch({ containers: () => unimplemented("listContainers") });
    render(<ObjectTree connection={connectionOf("my")} capabilities={oneLevel} />);

    const panel = await screen.findByTestId("tree-unimplemented");
    expect(panel.textContent).toContain("does not implement listContainers yet");
    expect(screen.queryByTestId("tree-retry")).toBeNull();
    expect(screen.queryByTestId("tree-empty")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("an engine that answers nothing reads as empty, which is not the same panel", async () => {
    installFetch({ containers: () => [] });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    expect(await screen.findByTestId("tree-empty")).toBeTruthy();
    expect(screen.queryByTestId("tree-unimplemented")).toBeNull();
  });

  test("any other failure shows the engine's message and a retry that reads again", async () => {
    let attempt = 0;
    const calls = installFetch({
      containers: () => {
        attempt += 1;
        return attempt === 1 ? Response.json({ error: "connection refused" }, { status: 500 }) : appSchema;
      },
      counts: () => ({}),
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    const failure = await screen.findByTestId("tree-failure");
    expect(failure.textContent).toContain("connection refused");

    await userEvent.click(screen.getByTestId("tree-retry"));
    expect(await screen.findByRole("treeitem", { name: /app/ })).toBeTruthy();
    expect(calls.filter((call) => call.route === "containers")).toHaveLength(2);
  });

  test("a body of the wrong shape is reported, not rendered", async () => {
    // The shape the render DEREFERENCES is checked: a wrong one used to throw inside `flattenTree`
    // during the render and take the whole tree down instead of reaching this panel.
    installFetch({ containers: () => ({}) });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    expect((await screen.findByTestId("tree-failure")).textContent).toContain("containers");
  });

  test("a container list holding a null entry is reported, not rendered", async () => {
    installFetch({ containers: () => [null] });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    expect(await screen.findByTestId("tree-failure")).toBeTruthy();
  });

  test("counts answered as a list, or holding a bare number, is reported, not rendered", async () => {
    installFetch({ containers: () => appSchema, counts: () => ({ table: 2 }) });
    const { unmount } = render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await userEvent.click(await screen.findByRole("treeitem", { name: /app/ }));
    await waitFor(() => expect(within(row(/app/)).getByTestId("tree-row-failure")).toBeTruthy());
    unmount();

    installFetch({ counts: () => [] });
    render(<ObjectTree connection={connectionOf("lite")} capabilities={noContainers} />);
    expect((await screen.findByTestId("tree-failure")).textContent).toContain("counts");
  });

  test("a body with no error field still reports the status the route answered", async () => {
    installFetch({ containers: () => new Response("", { status: 502 }) });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    expect((await screen.findByTestId("tree-failure")).textContent).toContain("502");
  });

  test("a 501 on ONE read marks that row as unmigrated rather than as a failure", async () => {
    // The state every provider task passes through: `listContainers` and `countObjects` are
    // implemented and `listObjects` is not yet.
    installFetch({
      containers: () => appSchema,
      counts: () => ({ table: { count: 2 }, view: { count: 0 } }),
      list: () => unimplemented("listObjects"),
    });
    render(<ObjectTree connection={connectionOf("my")} capabilities={oneLevel} />);
    await expandApp();

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(within(row(/Tables/)).getByTestId("tree-row-unimplemented")).toBeTruthy());
    expect(within(row(/Tables/)).getByTestId("tree-row-unimplemented").textContent).toContain(
      "does not implement listObjects yet",
    );
    expect(within(row(/Tables/)).queryByTestId("tree-row-failure")).toBeNull();
  });

  test("a folder read that fails shows on the folder, and reopening it reads again", async () => {
    let attempt = 0;
    const calls = installFetch({
      containers: () => appSchema,
      counts: () => ({ table: { count: 1 }, view: { count: 0 } }),
      list: () => {
        attempt += 1;
        return attempt === 1
          ? Response.json({ error: "relation lock timeout" }, { status: 500 })
          : [{ path: ["app", "orders"], name: "orders", kind: "table" }];
      },
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(within(row(/Tables/)).getByTestId("tree-row-failure")).toBeTruthy());
    expect(within(row(/Tables/)).getByTestId("tree-row-failure").textContent).toContain("relation lock timeout");

    await userEvent.click(row(/Tables/));
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
    expect(calls.filter((call) => call.route === "list")).toHaveLength(2);
  });
});

describe("ObjectTree container shapes", () => {
  test("an engine with no container level draws the kind folders at the root and lists no containers", async () => {
    const calls = installFetch({
      counts: () => ({ table: { count: 3 } }),
      list: () => [{ path: ["events"], name: "events", kind: "table" }],
    });
    render(<ObjectTree connection={connectionOf("lite")} capabilities={noContainers} />);

    const tables = await screen.findByRole("treeitem", { name: /Tables/ });
    expect(tables.getAttribute("aria-level")).toBe("1");
    expect(within(tables).getByTestId("tree-row-badge").textContent).toBe("3");
    expect(calls.map((call) => call.route)).toEqual(["counts"]);
    expect(calls[0]?.body.container).toEqual([]);
  });

  test("a two-level engine nests its schemas under the catalog and only the schema holds folders", async () => {
    const calls = installFetch({
      containers: (body) =>
        body.parent === undefined
          ? [{ path: ["prod"], name: "prod", level: 0 }]
          : [{ path: ["prod", "app"], name: "app", level: 1 }],
      counts: () => ({ table: { count: 7 } }),
    });
    render(<ObjectTree connection={connectionOf("trino")} capabilities={twoLevels} />);

    const prod = await screen.findByRole("treeitem", { name: /prod/ });
    await userEvent.click(prod);

    const app = await screen.findByRole("treeitem", { name: /app/ });
    expect(app.getAttribute("aria-level")).toBe("2");
    expect(screen.queryByRole("treeitem", { name: /Tables/ })).toBeNull();

    await userEvent.click(app);
    const tables = await screen.findByRole("treeitem", { name: /Tables/ });
    expect(tables.getAttribute("aria-level")).toBe("3");
    expect(within(tables).getByTestId("tree-row-badge").textContent).toBe("7");
    expect(calls.map((call) => `${call.route}:${JSON.stringify(call.body.parent ?? call.body.container)}`)).toEqual([
      "containers:undefined",
      'containers:["prod"]',
      'counts:["prod","app"]',
    ]);
  });

  /**
   * U23, end to end. The row id, the expansion-set member and the counts cache key are three
   * readers of one rule, and a container named `a/b` is where they can disagree. Nothing is
   * clicked here on purpose: the engine names this container as the session's own, so the
   * cache opens it by an id it builds from the path before any row exists, and the walk then
   * has to produce that same id. A second spelling of the rule in the cache leaves the
   * container closed; a second spelling in the counts key leaves the folder unbadged.
   */
  test("a container whose name holds the id separator still opens and badges its folders", async () => {
    installFetch({
      containers: () => [{ path: ["a/b"], name: "a/b", level: 0, isSessionDefault: true }],
      counts: (body) =>
        JSON.stringify(body.container) === '["a/b"]' ? { table: { count: 5 }, view: { count: 0 } } : {},
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    const tables = await screen.findByRole("treeitem", { name: /Tables/ });
    expect(within(tables).getByTestId("tree-row-badge").textContent).toBe("5");
    expect(screen.getByRole("treeitem", { name: /a\/b/ }).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ObjectTree object rows", () => {
  const withObjects = () =>
    installFetch(
      routesFor(
        {
          table: [
            { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1234, status: "VALID" },
            { path: ["app", "order_total(integer)"], name: "order_total", kind: "table" },
          ],
        },
        { table: { count: 2 }, view: { count: 0 } },
      ),
    );

  async function openTables(onObjectClick?: (object: DatabaseObject) => void): Promise<void> {
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} onObjectClick={onObjectClick} />);
    await expandApp();
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.getByText("orders")).toBeTruthy());
  }

  test("an object row is a leaf, labelled by its name rather than by its path segment", async () => {
    withObjects();
    await openTables();

    const overload = row(/order_total/);
    expect(overload.hasAttribute("aria-expanded")).toBe(false);
    expect(overload.getAttribute("aria-level")).toBe("3");
    expect(within(overload).getByTestId("tree-row-label").textContent).toBe("order_total");
  });

  test("an object row shows the status and the row count the engine reported, and nothing where it did not", async () => {
    withObjects();
    await openTables();

    expect(within(row(/orders/)).getByTestId("tree-row-status").textContent).toBe("VALID");
    expect(within(row(/orders/)).getByTestId("tree-row-count").textContent).toBe("1,234");
    expect(within(row(/order_total/)).queryByTestId("tree-row-status")).toBeNull();
    expect(within(row(/order_total/)).queryByTestId("tree-row-count")).toBeNull();
  });

  test("clicking an object hands the caller the object, path and kind included", async () => {
    const clicked: DatabaseObject[] = [];
    withObjects();
    await openTables((object) => clicked.push(object));

    await userEvent.click(row(/orders/));
    expect(clicked).toEqual([
      { path: ["app", "orders"], name: "orders", kind: "table", rowCount: 1234, status: "VALID" },
    ]);
  });

  test("Enter on an object row activates it, and on a folder row it opens the folder", async () => {
    const clicked: DatabaseObject[] = [];
    withObjects();
    await openTables((object) => clicked.push(object));

    row(/orders/).focus();
    await userEvent.click(row(/orders/));
    clicked.length = 0;
    await userEvent.keyboard("{Enter}");
    expect(clicked).toHaveLength(1);

    row(/Views/).focus();
    await userEvent.click(row(/Views/));
    await waitFor(() => expect(row(/Views/).getAttribute("aria-expanded")).toBe("true"));
    await userEvent.keyboard(" ");
    await waitFor(() => expect(row(/Views/).getAttribute("aria-expanded")).toBe("false"));
  });
});

describe("ObjectTree loading states", () => {
  test("a folder read in flight is busy, and an empty answer is loaded rather than busy", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    installFetch({
      containers: () => appSchema,
      counts: () => ({ table: { count: 0 }, view: { count: 0 } }),
      list: () => pending,
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-busy")).toBe("true"));

    await act(async () => {
      release([]);
      await pending;
    });
    await waitFor(() => expect(row(/Tables/).hasAttribute("aria-busy")).toBe(false));
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
  });

  test("a read already in flight is not issued again when the rows change under it", async () => {
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const calls = installFetch({
      containers: () => appSchema,
      counts: () => ({ table: { count: 1 }, view: { count: 1 } }),
      list: (body) => (String(body.kind) === "table" ? pending : [{ path: ["app", "v"], name: "v", kind: "view" }]),
    });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();

    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-busy")).toBe("true"));

    // Opening a second folder changes the cache, and with it the derived read list, while the
    // first read is still outstanding. Only the in-flight guard keeps that from asking twice.
    await userEvent.click(row(/Views/));
    await waitFor(() => expect(screen.getByText("v")).toBeTruthy());
    expect(calls.filter((call) => call.route === "list" && call.body.kind === "table")).toHaveLength(1);

    await act(async () => {
      release([]);
      await pending;
    });
  });

  test("the first read shows a loading panel and no empty panel", async () => {
    installFetch({ containers: () => new Promise(() => {}) });
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);

    expect(screen.getByTestId("tree-loading")).toBeTruthy();
    expect(screen.queryByTestId("tree-empty")).toBeNull();
  });
});

describe("ObjectTree keyboard", () => {
  async function threeRows(): Promise<void> {
    installFetch(routesFor({}, { table: { count: 0 }, view: { count: 0 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();
  }

  function focused(): string {
    return document.activeElement?.getAttribute("data-row-id") ?? "none";
  }

  test("Down and Up walk the visible rows and carry the single roving tabindex with them", async () => {
    await threeRows();
    row(/app/).focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe("app/table");
    expect(screen.getAllByRole("treeitem").filter((item) => item.getAttribute("tabindex") === "0")).toHaveLength(1);
    expect(row(/Tables/).getAttribute("tabindex")).toBe("0");

    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe("app/view");
    await userEvent.keyboard("{ArrowDown}");
    expect(focused()).toBe("app/view");

    await userEvent.keyboard("{ArrowUp}");
    expect(focused()).toBe("app/table");
    await userEvent.keyboard("{ArrowUp}{ArrowUp}");
    expect(focused()).toBe("app");
  });

  test("Home and End jump to the first and the last visible row", async () => {
    await threeRows();
    row(/app/).focus();

    await userEvent.keyboard("{End}");
    expect(focused()).toBe("app/view");
    await userEvent.keyboard("{Home}");
    expect(focused()).toBe("app");
  });

  test("Right moves into an open row, opens a closed one, and does nothing on an open row holding nothing", async () => {
    await threeRows();
    row(/app/).focus();

    // `app` was opened by the click in `threeRows`, so the first Right descends into it.
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("app/table");

    await userEvent.keyboard("{ArrowRight}");
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-expanded")).toBe("true"));
    expect(focused()).toBe("app/table");

    // The engine answered that this folder holds nothing, so there is no first child to move to.
    await userEvent.keyboard("{ArrowRight}");
    expect(focused()).toBe("app/table");
  });

  test("Left collapses an open row and otherwise moves to the parent", async () => {
    await threeRows();
    row(/Tables/).focus();
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-expanded")).toBe("true"));

    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(row(/Tables/).getAttribute("aria-expanded")).toBe("false"));
    expect(focused()).toBe("app/table");

    await userEvent.keyboard("{ArrowLeft}");
    expect(focused()).toBe("app");
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(row(/app/).getAttribute("aria-expanded")).toBe("false"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(focused()).toBe("app");
  });

  test("Left from a row whose sibling sits above it still moves to the parent", async () => {
    // The parent search must skip a SIBLING at the same depth. With `Tables` above it, `Views` is
    // the only row in this fixture that can tell "the nearest row shallower than me" from "the
    // row above me", and a single-child group could not.
    await threeRows();
    row(/app/).focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(focused()).toBe("app/view");

    await userEvent.keyboard("{ArrowLeft}");
    expect(focused()).toBe("app");
  });

  test("focus landing on a row is not re-aimed at the active row", async () => {
    // Anything that reveals a row will focus it directly: Task 7's "show me the table this
    // statement is about", and Phase 2's reveal. The container's focus handler must not treat that
    // as focus on itself and pull focus back to whatever was active.
    await threeRows();
    row(/Views/).focus();
    // happy-dom's programmatic `focus()` does not emit the bubbling `focusin` a browser emits, and
    // that is the event the container's handler sees, so the test emits it: without the
    // target-is-me guard, this is what would pull focus off `Views` and back onto `app`.
    fireEvent.focusIn(row(/Views/));

    expect(focused()).toBe("app/view");
    expect(row(/app/).getAttribute("aria-selected")).toBe("true");
  });

  test("a key the pattern does not use is left to the browser", async () => {
    await threeRows();
    row(/app/).focus();
    await userEvent.keyboard("a");
    expect(focused()).toBe("app");
    expect(row(/app/).getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ObjectTree windowing", () => {
  const manyObjects = Array.from({ length: 300 }, (_, index) => ({
    path: ["app", `t_${String(index).padStart(3, "0")}`],
    name: `t_${String(index).padStart(3, "0")}`,
    kind: "table",
  }));

  async function bigTree(): Promise<HTMLElement> {
    installFetch(routesFor({ table: manyObjects }, { table: { count: 300 }, view: { count: 0 } }));
    render(<ObjectTree connection={connectionOf("pg")} capabilities={oneLevel} />);
    await expandApp();
    await userEvent.click(row(/Tables/));
    await waitFor(() => expect(screen.getByText("t_000")).toBeTruthy());
    return screen.getByTestId("object-tree");
  }

  test("only a window of a large tree is mounted, and each mounted row keeps the model's position", async () => {
    await bigTree();

    const items = screen.getAllByRole("treeitem");
    expect(items.length).toBeLessThan(60);
    expect(screen.queryByText("t_299")).toBeNull();

    // The set size is the sibling group's, not the mounted count: 300 objects, mounted 60 or fewer.
    const fifth = row(/t_004/);
    expect(fifth.getAttribute("aria-setsize")).toBe("300");
    expect(fifth.getAttribute("aria-posinset")).toBe("5");
    expect(fifth.getAttribute("aria-level")).toBe("3");
  });

  test("scrolling a measured viewport mounts the rows at that offset and drops the ones above", async () => {
    const tree = await bigTree();
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 112 });

    fireEvent.scroll(tree, { target: { scrollTop: 28 * 100 } });

    await waitFor(() => expect(screen.getByText("t_098")).toBeTruthy());
    expect(screen.queryByText("t_000")).toBeNull();
    expect(row(/t_098/).getAttribute("aria-posinset")).toBe("99");
    expect(screen.getAllByRole("treeitem").length).toBeLessThan(20);
  });

  test("the tree is still reachable by keyboard once the active row has scrolled out of the window", async () => {
    const tree = await bigTree();
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 112 });
    fireEvent.scroll(tree, { target: { scrollTop: 28 * 100 } });
    await waitFor(() => expect(screen.getByText("t_098")).toBeTruthy());

    // `app/table` is the active row and it is no longer mounted, so nothing inside the subtree can
    // hold the tab stop. The container has to take it, or the tree cannot be entered without a mouse.
    expect(screen.queryByRole("treeitem", { name: /Tables/ })).toBeNull();
    expect(tree.getAttribute("tabindex")).toBe("0");

    tree.focus();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/table"));
    expect(tree.getAttribute("tabindex")).toBe("-1");

    // And the arrow keys work from there, which is the point of getting focus back in.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/t_000/table");
  });

  test("the container takes the tab stop when the active row sits BELOW the window as well", async () => {
    const tree = await bigTree();
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 112 });
    fireEvent.scroll(tree, { target: { scrollTop: 0 } });
    row(/app/).focus();

    await userEvent.keyboard("{End}");
    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/view"));

    // Back to the top, so the active row is now past the END of the window rather than before its
    // start. One bound answers both, and only this direction can tell the two apart.
    fireEvent.scroll(tree, { target: { scrollTop: 0 } });
    await waitFor(() => expect(screen.getByText("t_000")).toBeTruthy());
    expect(screen.queryByRole("treeitem", { name: /Views/ })).toBeNull();
    expect(tree.getAttribute("tabindex")).toBe("0");
  });

  test("End mounts and focuses the last row even though it was outside the window", async () => {
    const tree = await bigTree();
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 112 });
    fireEvent.scroll(tree, { target: { scrollTop: 0 } });
    expect(screen.queryByText("t_299")).toBeNull();
    row(/app/).focus();

    await userEvent.keyboard("{End}");

    // Row 303 of 303 is the Views folder, and the 300 objects above it come with it.
    await waitFor(() => expect(document.activeElement?.getAttribute("data-row-id")).toBe("app/view"));
    expect(screen.getByText("t_299")).toBeTruthy();
    expect(row(/t_299/).getAttribute("aria-posinset")).toBe("300");
  });
});

describe("treeWindow", () => {
  // 28px rows, 4 of overscan each side. Exported and tested here rather than only through the
  // component, because the clamp is arithmetic with three edges and the component can only reach
  // two of them.
  test("an unscrolled tree starts at the top and mounts a viewport plus the overscan", () => {
    expect(treeWindow(1000, 0, 280, -1)).toEqual([0, 18]);
  });

  test("a scroll moves the window by whole rows, keeping the overscan above", () => {
    expect(treeWindow(1000, 28 * 50, 280, -1)).toEqual([46, 64]);
  });

  test("a tree shorter than the viewport mounts all of it and never starts below zero", () => {
    expect(treeWindow(5, 0, 280, -1)).toEqual([0, 5]);
    expect(treeWindow(5, 28 * 4, 280, -1)).toEqual([0, 5]);
  });

  test("the window never runs past the end", () => {
    expect(treeWindow(20, 28 * 100, 280, -1)).toEqual([2, 20]);
  });

  test("a focused row above the window pulls the window up to it, and one below pulls it down", () => {
    expect(treeWindow(1000, 28 * 50, 280, 10)).toEqual([10, 28]);
    expect(treeWindow(1000, 28 * 50, 280, 900)).toEqual([883, 901]);
  });

  test("a focused row already inside the window leaves it where the scroll put it", () => {
    expect(treeWindow(1000, 28 * 50, 280, 50)).toEqual([46, 64]);
  });
});

describe("useTreeNodes", () => {
  function renderTree(connectionId = "pg") {
    return renderHook(({ id }: { id: string }) => useTreeNodes(connectionOf(id), oneLevel), {
      initialProps: { id: connectionId },
    });
  }

  test("absent and empty are different states: an empty answer stops the read, absence does not", async () => {
    installFetch(routesFor({ table: [] }, { table: { count: 0 }, view: { count: 0 } }));
    const { result } = renderTree();

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));

    act(() => result.current.toggle("app/table"));
    await waitFor(() => expect(result.current.isBusy(result.current.rows[1] as never)).toBe(false));
    expect(result.current.rows).toHaveLength(3);
  });

  test("invalidateContainer drops the counts and the loaded objects of that container and reads them again", async () => {
    let generation = 0;
    const calls = installFetch({
      containers: () => appSchema,
      counts: () => ({ table: { count: generation }, view: { count: 0 } }),
      list: () => [{ path: ["app", `t${generation}`], name: `t${generation}`, kind: "table" }],
    });
    const { result } = renderTree();

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    act(() => result.current.toggle("app/table"));
    await waitFor(() => expect(result.current.rows.map((r) => r.label)).toContain("t0"));

    generation = 1;
    act(() => result.current.invalidateContainer(["app"]));
    await waitFor(() => expect(result.current.rows.map((r) => r.label)).toContain("t1"));
    expect(result.current.rows.find((r) => r.kindId === "table" && r.kind === "folder")?.badge).toBe("1");
    expect(calls.filter((call) => call.route === "counts")).toHaveLength(2);
    expect(calls.filter((call) => call.route === "list")).toHaveLength(2);
  });

  test("invalidating a container nobody opened leaves the other container's cache alone", async () => {
    installFetch({
      containers: () => [
        { path: ["app"], name: "app", level: 0 },
        { path: ["sales"], name: "sales", level: 0 },
      ],
      counts: () => ({ table: { count: 5 }, view: { count: 0 } }),
      list: () => [{ path: ["app", "orders"], name: "orders", kind: "table" }],
    });
    const { result } = renderTree();

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(4));
    act(() => result.current.toggle("app/table"));
    await waitFor(() => expect(result.current.rows.map((r) => r.label)).toContain("orders"));

    act(() => result.current.invalidateContainer(["sales"]));
    expect(result.current.rows.map((r) => r.label)).toContain("orders");
  });

  test("changing the connection throws the whole cache away rather than showing the last one's tree", async () => {
    installFetch({
      containers: (body) =>
        (body as { connection?: { id: string } }).connection?.id === "pg"
          ? appSchema
          : [{ path: ["other"], name: "other", level: 0 }],
      counts: () => ({}),
    });
    const view = renderTree();

    await waitFor(() => expect(view.result.current.rows.map((r) => r.label)).toEqual(["app"]));
    view.rerender({ id: "second" });
    await waitFor(() => expect(view.result.current.rows.map((r) => r.label)).toEqual(["other"]));
  });

  test("one read is issued per key however many renders ask for it", async () => {
    const calls = installFetch(routesFor({}, { table: { count: 1 }, view: { count: 0 } }));
    const { result, rerender } = renderTree();

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    rerender({ id: "pg" });
    rerender({ id: "pg" });
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    rerender({ id: "pg" });

    expect(calls.filter((call) => call.route === "containers")).toHaveLength(1);
    expect(calls.filter((call) => call.route === "counts")).toHaveLength(1);
  });

  test("loadContainers reads the root again and keeps what is already open", async () => {
    let names = ["app"];
    const calls = installFetch({
      containers: () => names.map((name) => ({ path: [name], name, level: 0 })),
      counts: () => ({ table: { count: 1 }, view: { count: 0 } }),
    });
    const { result } = renderTree();

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));

    names = ["app", "sales"];
    act(() => result.current.loadContainers());
    await waitFor(() => expect(result.current.rows.map((r) => r.label)).toContain("sales"));
    expect(result.current.rows.map((r) => r.label)).toEqual(["app", "Tables", "Views", "sales"]);
    expect(calls.filter((call) => call.route === "containers")).toHaveLength(2);
  });

  // The payload shape itself, both arms, is pinned in
  // `tests/components/object-tree/first-paint.test.tsx`: this connection is one the
  // server has never heard of, so it travels whole.
  test("every request carries the connection the tree was asked for", async () => {
    const calls = installFetch(routesFor({}, { table: { count: 0 }, view: { count: 0 } }));
    const { result } = renderTree("browser-only");

    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.toggle("app"));
    await waitFor(() => expect(result.current.rows).toHaveLength(3));

    expect(calls.every((call) => (call.body.connection as { id: string }).id === "browser-only")).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

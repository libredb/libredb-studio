import "../../setup-dom";
import "../../helpers/mock-navigation";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectTree } from "@/components/object-tree";
import { useTreeNodes } from "@/components/object-tree/use-tree-nodes";
import type { Container, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * What opening a connection reads, and what deferring it does not read (#789, #765).
 *
 * Two product decisions are pinned here and nowhere else.
 *
 * Decision A: first paint issues exactly TWO catalog reads on an engine that names its
 * session container - the container list, and the kind counts for that one container,
 * which is expanded. No object names and no columns. The container is resolved from the
 * ENGINE, through `Container.isSessionDefault`, so an engine that publishes no such fact
 * reads ONCE and opens nothing. PostgreSQL is that engine on purpose
 * (`src/lib/db/types.ts` records why: a `search_path` names several schemas and none of
 * them owns the session), which is why the two-read fixture below is Oracle-shaped and
 * the one-read fixture is PostgreSQL-shaped. Guessing `public` here would be exactly the
 * per-engine knowledge in a consumer that this epic exists to remove.
 *
 * Decision C: `DatabaseConnection.skipObjectScan` reads NOTHING. The panel offers a load
 * action instead, and the editor is untouched.
 *
 * Every assertion counts requests BY PATH, in order, so it fails at one read and at
 * three rather than only at zero, and every zero is paired with a control that makes the
 * same counter see the reads.
 */

type ObjectModel = Pick<ProviderCapabilities, "containerLevels" | "objectKinds">;

function capabilitiesOf(model: ObjectModel): ProviderCapabilities {
  return { queryLanguage: "sql", ...model } as ProviderCapabilities;
}

const oneLevel = capabilitiesOf({
  containerLevels: [{ id: "schema", label: "Schema", labelPlural: "Schemas" }],
  objectKinds: [
    { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
    { id: "view", role: "relation", label: "View", labelPlural: "Views" },
  ],
});

const twoLevels = capabilitiesOf({
  containerLevels: [
    { id: "catalog", label: "Database", labelPlural: "Databases" },
    { id: "schema", label: "Schema", labelPlural: "Schemas" },
  ],
  objectKinds: [{ id: "table", role: "relation", label: "Table", labelPlural: "Tables" }],
});

function connectionOf(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "conn-1",
    name: "Reporting",
    type: "oracle",
    host: "localhost",
    port: 1521,
    user: "app",
    password: "secret",
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

interface Call {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;

/** Records every request by PATHNAME, in order, and answers the object routes. */
function installFetch(answers: Record<string, unknown>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = mock(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url), "http://localhost:3000").pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ path, body });
    const answer = answers[path];
    if (answer === undefined) return Response.json({ error: `no answer for ${path}` }, { status: 500 });
    return Response.json(typeof answer === "function" ? (answer as (b: unknown) => unknown)(body) : answer);
  }) as never;
  return calls;
}

/** Only the catalog. The health pulse and the managed-seed list read no catalog. */
function catalogPaths(calls: readonly Call[]): string[] {
  return calls.map((call) => call.path).filter((path) => path.startsWith("/api/db/objects"));
}

/** Oracle's shape: the connecting user's own owner is the session default. */
const ownerContainers: Container[] = [
  { path: ["APP"], name: "APP", level: 0, isSessionDefault: true },
  { path: ["REPORTING"], name: "REPORTING", level: 0, isSessionDefault: false },
];

/** PostgreSQL's shape: schemas, and the engine names no session container. */
const schemaContainers: Container[] = [
  { path: ["app"], name: "app", level: 0 },
  { path: ["public"], name: "public", level: 0 },
];

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("opening a connection", () => {
  test("issues exactly two catalog reads: the containers, then the counts of the active one", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 }, view: { count: 0 } },
    });

    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} />);

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());

    expect(catalogPaths(calls)).toEqual(["/api/db/objects/containers", "/api/db/objects/counts"]);
    // The counts are read for the container the ENGINE named, not for the first one
    // alphabetically and not for every container in the list.
    expect(calls[1].body.container).toEqual(["APP"]);
  });

  test("the session-default container is the one that opens, and the others stay closed", async () => {
    installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 }, view: { count: 0 } },
    });

    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} />);

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());

    expect(screen.getByRole("treeitem", { name: /APP/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: /REPORTING/ }).getAttribute("aria-expanded")).toBe("false");
  });

  test("an engine that names no session container reads ONCE and opens nothing", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": schemaContainers,
      "/api/db/objects/counts": { table: { count: 9 } },
    });

    render(<ObjectTree connection={connectionOf({ type: "postgres" })} capabilities={oneLevel} />);

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /public/ })).toBeTruthy());

    expect(catalogPaths(calls)).toEqual(["/api/db/objects/containers"]);
    expect(screen.getByRole("treeitem", { name: /public/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("treeitem", { name: /Tables/ })).toBeNull();
  });

  /**
   * The generalisation of decision A on a two-level engine, which is the shape Task 11
   * onwards lands: the counts of the active container cannot be reached without listing
   * the level between, so first paint is three reads and not two. The alternative,
   * stopping at the catalog, would leave the tree closed on an engine that DOES name its
   * session schema.
   */
  test("a two-level engine descends to the session default at each level", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": (body: unknown) =>
        (body as { parent?: string[] }).parent === undefined
          ? [
              { path: ["shop"], name: "shop", level: 0, isSessionDefault: true },
              { path: ["master"], name: "master", level: 0, isSessionDefault: false },
            ]
          : [{ path: ["shop", "dbo"], name: "dbo", level: 1, isSessionDefault: true }],
      "/api/db/objects/counts": { table: { count: 7 } },
    });

    render(<ObjectTree connection={connectionOf({ type: "mssql" })} capabilities={twoLevels} />);

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());

    expect(catalogPaths(calls)).toEqual([
      "/api/db/objects/containers",
      "/api/db/objects/containers",
      "/api/db/objects/counts",
    ]);
    expect(calls[1].body.parent).toEqual(["shop"]);
    expect(calls[2].body.container).toEqual(["shop", "dbo"]);
  });

  test("a browser-only connection is posted as the whole connection, a seed as its id", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": schemaContainers,
      "/api/db/objects/counts": {},
    });

    const { unmount } = render(<ObjectTree connection={connectionOf({ type: "postgres" })} capabilities={oneLevel} />);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /public/ })).toBeTruthy());
    // The whole object, because the server has never heard of this connection. Posting
    // the id alone is what made the tree readable for seed connections only.
    expect((calls[0].body.connection as DatabaseConnection).id).toBe("conn-1");
    expect(calls[0].body.connectionId).toBeUndefined();
    unmount();

    const seeded = installFetch({
      "/api/db/objects/containers": schemaContainers,
      "/api/db/objects/counts": {},
    });
    render(
      <ObjectTree
        connection={connectionOf({ id: "seed:pg", managed: true, seedId: "pg", type: "postgres" })}
        capabilities={oneLevel}
      />,
    );
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /public/ })).toBeTruthy());
    expect(seeded[0].body.connectionId).toBe("seed:pg");
    expect(seeded[0].body.connection).toBeUndefined();
  });
});

describe("the no-scan escape hatch", () => {
  test("a deferred tree reads no catalog at all", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 } },
    });

    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} deferred />);

    expect(await screen.findByTestId("tree-deferred")).toBeTruthy();
    // Not the spinner: nothing is loading, because nothing was asked for.
    expect(screen.queryByTestId("tree-loading")).toBeNull();
    expect(catalogPaths(calls)).toEqual([]);
  });

  /**
   * The control for the assertion above, and the reason it is not vacuous: the same
   * component, the same fixture and the same counter, with `deferred` the only
   * difference, makes two reads.
   */
  test("control: the same tree without the flag reads twice", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 } },
    });

    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} />);

    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());
    expect(catalogPaths(calls)).toEqual(["/api/db/objects/containers", "/api/db/objects/counts"]);
    expect(screen.queryByTestId("tree-deferred")).toBeNull();
  });

  test("the panel names the connection it is holding back", async () => {
    installFetch({});

    render(<ObjectTree connection={connectionOf({ name: "Prod Oracle" })} capabilities={oneLevel} deferred />);

    expect((await screen.findByTestId("tree-deferred")).textContent).toContain("Prod Oracle");
  });

  test("the load action is offered, and reads the catalog the connection deferred", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 } },
    });
    const onLoad = mock(() => {});

    const { rerender } = render(
      <ObjectTree connection={connectionOf()} capabilities={oneLevel} deferred onLoad={onLoad} />,
    );

    await userEvent.click(await screen.findByTestId("tree-load"));
    expect(onLoad).toHaveBeenCalledTimes(1);
    // Still nothing read: the connection owns the answer, so the press asks its owner
    // rather than reading behind its back.
    expect(catalogPaths(calls)).toEqual([]);

    // What the owner does with it, which is the state the reader then sees.
    rerender(<ObjectTree connection={connectionOf()} capabilities={oneLevel} onLoad={onLoad} />);
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /Tables/ })).toBeTruthy());
    expect(catalogPaths(calls)).toEqual(["/api/db/objects/containers", "/api/db/objects/counts"]);
  });

  /**
   * The hook's own answer, which the panel above hides: `ObjectTree` checks `deferred`
   * before it checks anything else, so nothing in a rendered tree can distinguish
   * "deferred" from "loading". A consumer calling the hook directly can, and it is a
   * published export, so the state it reports has to be the truth: nothing was asked
   * for, so nothing is loading and nothing failed.
   */
  test("the hook reports a deferred tree as neither loading nor failed", async () => {
    const calls = installFetch({
      "/api/db/objects/containers": ownerContainers,
      "/api/db/objects/counts": { table: { count: 2 } },
    });

    const { result, rerender } = renderHook(
      ({ deferred }: { deferred: boolean }) => useTreeNodes(connectionOf(), oneLevel, deferred),
      { initialProps: { deferred: true } },
    );

    expect(result.current.rootLoading).toBe(false);
    expect(result.current.rootFailure).toBeUndefined();
    expect(result.current.rows).toEqual([]);
    expect(catalogPaths(calls)).toEqual([]);

    // The control, on the same hook instance: releasing it starts the read and the
    // loading state the assertion above denies.
    rerender({ deferred: false });
    expect(result.current.rootLoading).toBe(true);
    await waitFor(() => expect(result.current.rows.length).toBeGreaterThan(1));
    expect(catalogPaths(calls)).toEqual(["/api/db/objects/containers", "/api/db/objects/counts"]);
  });

  test("no load action is drawn where nothing can perform the load", async () => {
    installFetch({});

    render(<ObjectTree connection={connectionOf()} capabilities={oneLevel} deferred />);

    expect(await screen.findByTestId("tree-deferred")).toBeTruthy();
    expect(screen.queryByTestId("tree-load")).toBeNull();
  });
});

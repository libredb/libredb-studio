import "../../setup-dom";
import "../../helpers/mock-sonner";
import "../../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../../helpers/mock-fetch";

import { KeyBrowser, type KeyPatternRequest } from "@/components/key-browser";
import { KEY_ROW_HEIGHT } from "@/components/key-browser/tree";
import { HELD_KEY_LIMIT, SCAN_ALL_MAX_KEYS } from "@/components/key-browser/use-key-scan";
import type { ContainerLevelSpec, KeyScanCapability, KeyScanPage } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The panel: a sampled walk drawn as the tree its names imply.
 *
 * IT LOADS ITS FIRST PAGE ITSELF, so every test here waits for that page before asserting — and the
 * first one asserts the WAIT, because a panel that rendered nothing until somebody found a button
 * would pass every other test in this file while looking broken to everyone.
 */

const CONNECTION: DatabaseConnection = {
  id: "redis-1",
  name: "Local Redis",
  type: "redis",
  host: "127.0.0.1",
  port: 6380,
  createdAt: new Date(0),
};

const CAPABILITY = { defaultCount: 500, maxCount: 1000 };

/** Redis's own word for its one container level, and the databases it answered for itself. */
const LEVEL: ContainerLevelSpec = { id: "schema", label: "Database", labelPlural: "Databases" };
const DATABASES = [
  { path: ["0"], name: "0", level: 0, isSessionDefault: true },
  { path: ["1"], name: "1", level: 0, isSessionDefault: false },
];

/** A page, in the shape the route answers with. An absent type map is a page that described none. */
function page(keys: string[], cursor: string, total = 31, types: Record<string, string> = {}): MockFetchResponse {
  return { json: { keys, cursor, total, types } };
}

/** The walk and the container list together, which is what a Redis panel reads. */
function redisRoutes(scan: MockFetchResponse | ((req: Request) => MockFetchResponse | Promise<MockFetchResponse>)) {
  return { "/api/db/keys/scan": scan, "/api/db/objects/containers": { json: DATABASES } };
}

/** The cursor the request carried. The helper hands a real `Request`, so its body is read once. */
async function cursorOf(req: Request): Promise<string> {
  const body = (await req.json().catch(() => ({}))) as { cursor?: string };
  return body.cursor ?? "0";
}

/**
 * The connection as it crosses the wire.
 *
 * `createdAt` is a `Date` in memory and a string once `JSON.stringify` has been through it, so an
 * expectation built from the live object can never equal the body that was actually sent.
 */
const WIRE_CONNECTION = JSON.parse(JSON.stringify(CONNECTION)) as Record<string, unknown>;

/** Every body the WALK was sent, in order: the container list is a different read, filtered out here. */
function walksOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .map((call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>)
    .filter((body) => "cursor" in body);
}

function renderBrowser(capability = CAPABILITY, onOpenKey?: (key: string, type: string | null) => void) {
  return render(<KeyBrowser connection={CONNECTION} capability={capability} onOpenKey={onOpenKey} />);
}

/** The panel on an engine that declares a level to choose from, which is what Redis is. */
function renderLevel(request?: KeyPatternRequest, level: ContainerLevelSpec = LEVEL) {
  return render(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} databaseLevel={level} request={request} />);
}

/** The progress line's text, which is the one number the panel promises to keep honest. */
function progress(): string {
  return screen.getByTestId("key-browser-progress").textContent ?? "";
}

/** The rows currently drawn, in order, as `label@depth`. */
function rows(): string[] {
  return screen.queryAllByRole("treeitem").map((row) => {
    const label = row.querySelector("span.truncate")?.textContent ?? "";
    const depth = (Number.parseInt(row.style.paddingLeft, 10) - 8) / 12;
    return `${label}@${depth}`;
  });
}

/** Each row's type cell, by row label. A row with no type cell reads as the empty string. */
function typesByRow(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of screen.queryAllByRole("treeitem")) {
    const label = row.querySelector("span.truncate")?.textContent ?? "";
    out[label] = row.querySelector('[data-testid="key-browser-type"]')?.textContent ?? "";
  }
  return out;
}

describe("KeyBrowser", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("loads its first page without being asked", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    renderBrowser();

    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(1);
    });
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    // A leaf under one folder is indented by the project's own `8 + depth * 12`, so a key lines up
    // with a table two levels down elsewhere in the product. It is drawn only once its folder is
    // opened, which is the state every level below the top starts in.
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "app:env@1"]);
    expect(progress()).toBe("Scanned 1/31");
  });

  test("shows a spinner rather than an empty-state claim while the first page is in flight", async () => {
    // The gate is built first and its opener assigned inside the executor: an assignment inside a
    // callback is one TypeScript cannot see, so `release` would narrow to `null` and stop compiling.
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { container } = renderBrowser();

    // "This database holds no keys" is a CLAIM ABOUT THE SERVER, and making it before the server has
    // answered is the one thing an empty state must not do.
    expect(screen.getByTestId("key-browser-empty")).toBeDefined();
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.queryByText("This database holds no keys the walk has seen")).toBeNull();

    release();
    await waitFor(() => {
      expect(screen.queryByTestId("key-browser-empty")).toBeNull();
    });
  });

  test("says the database holds nothing once a spent walk found nothing", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page([], "0", 0) });
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByText("This database holds no keys the walk has seen")).toBeDefined();
    });
    expect(progress()).toBe("Scanned 0/0");
  });

  test("opens and closes a folder without asking the server for anything", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl", "app:env"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    const before = fetchMock.mock.calls.length;

    // The keys are already here, so a twisty is a local rearrangement — which is the whole reason a
    // sampled walk can answer a click instantly.
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1", "app:env@1"]);
    expect(fetchMock.mock.calls.length).toBe(before);

    // Each level opens on its own: opening `app` did not open `cache`, and nothing re-fetched.
    fireEvent.click(screen.getByText("cache:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1", "app:cache:ttl@2", "app:env@1"]);
    expect(fetchMock.mock.calls.length).toBe(before);

    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0"]);
  });

  test("opens a folder from the keyboard as well as the pointer", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });

    fireEvent.keyDown(screen.getByText("app:*"), { key: "Enter" });
    expect(rows()).toEqual(["app:*@0", "app:env@1"]);

    fireEvent.keyDown(screen.getByText("app:*"), { key: " " });
    expect(rows()).toEqual(["app:*@0"]);

    // Any other key is not a toggle, so the row stays as it is rather than folding on a stray press.
    fireEvent.keyDown(screen.getByText("app:*"), { key: "Tab" });
    expect(rows()).toEqual(["app:*@0"]);
  });

  test("filters the keys it holds and opens the folders that lead to a match", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl", "user:1001:name", "healthcheck"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0", "user:*@0", "healthcheck@0"]);
    });

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "1001" } });

    // The match is two levels down. Left collapsed it would look like no match at all, which is the
    // one answer a filter must never give.
    expect(rows()).toEqual(["user:*@0", "1001:*@1", "user:1001:name@2"]);

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "nothing-here" } });
    expect(screen.getByText("No key matches the filter")).toBeDefined();
  });

  test("finds a key by the path in its own name, not only by one of its segments", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": page(["queue:jobs:failed:2026:09:23:abc", "queue:other"], "0", 2),
    });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["queue:*@0"]);
    });

    // A term with a `:` in it names a PATH, and no single segment can contain one: a segment-only
    // test answered "no match" for the most specific input there is. Every folder on the way down is
    // drawn and open, and the leaf is the key itself.
    fireEvent.change(screen.getByLabelText("Filter the keys found"), {
      target: { value: "queue:jobs:failed:2026:09:23" },
    });
    expect(rows()).toEqual([
      "queue:*@0",
      "jobs:*@1",
      "failed:*@2",
      "2026:*@3",
      "09:*@4",
      "23:*@5",
      "queue:jobs:failed:2026:09:23:abc@6",
    ]);

    // And a middle fragment works too, which is what a reader has when they know a number.
    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "09:23" } });
    expect(rows()).toContain("queue:jobs:failed:2026:09:23:abc@6");

    // The box says what it matches, because it takes two kinds of answer and the reader cannot tell
    // which one it wants.
    expect(screen.getByLabelText("Filter the keys found").getAttribute("title")).toContain("full name");
  });

  test("restarts the walk when the pattern changes", async () => {
    const seen: string[] = [];
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.json()) as { pattern?: string };
        seen.push(body.pattern ?? "");
        return body.pattern === undefined ? page(["app:env"], "0") : page(["app:cache:ttl"], "0");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.change(screen.getByLabelText("Match pattern"), { target: { value: "app:cache:*" } });

    // A new pattern is a new walk: the old keys are not answers to it, so the tree is rebuilt from
    // the new walk's own first page rather than appended to. Opening the folder is what proves the
    // rebuild — `env` came from the abandoned walk and must be gone.
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
    fireEvent.click(screen.getByText("app:*"));
    expect(rows()).toEqual(["app:*@0", "cache:*@1"]);
    expect(seen).toEqual(["", "app:cache:*"]);
  });

  test("shows the route's own sentence when a page fails, and no tree", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": { status: 500, json: { error: "NOPERM no scan for you" } } });
    renderBrowser();

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-error").textContent).toContain("NOPERM no scan for you");
    });
    // No empty state beside the failure: the two are different facts, and drawing both would claim
    // the database holds nothing about a read that never happened.
    expect(screen.queryByTestId("key-browser-empty")).toBeNull();
  });

  test("offers Stop while Scan all runs and reports what ended the walk", async () => {
    /*
     * A batch as wide as the cap, so ONE page reaches it. The cap is counted in KEYS, and a
     * capability declaring a ten-thousand-key batch is what makes that reachable in one round trip
     * rather than twenty. This test is about the panel rendering the outcome; the walk itself is
     * `use-key-scan`'s own suite, at 500 a page.
     */
    const wide = { defaultCount: SCAN_ALL_MAX_KEYS, maxCount: SCAN_ALL_MAX_KEYS };
    // HANDED and HELD are counted differently, and the fixture shows both: `scanned` counts every key
    // the walk was given, repeats included, while the tree holds DISTINCT keys. A page of ten thousand
    // unique keys would fill the panel's own held budget at the same moment as this gesture's budget
    // and the two bounds could never be observed apart — so one thousand of them repeat, the walk is
    // still handed ten thousand, and only the gesture's sentence is under test.
    const unique = SCAN_ALL_MAX_KEYS - 1_000;
    const keys = Array.from({ length: SCAN_ALL_MAX_KEYS }, (_, index) => `bulk:${index % unique}`);
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        call += 1;
        // The FIRST page answers at once, so the panel settles with a walk still open; the second is
        // held so `Scan all` can be observed mid-flight.
        if (call > 1) await gate;
        return page(keys, `${call}00000`);
      },
    });
    renderBrowser(wide);
    await waitFor(() => {
      // Raw digits: the pair is a ratio to be read at a glance rather than a figure whose magnitude
      // is being checked, so thousands separators would be noise in the one line that carries the
      // walk's progress.
      expect(progress()).toBe("Scanned 10000/31");
    });

    fireEvent.click(screen.getByText("Scan all"));
    // The same control becomes Stop rather than a second Scan all nobody can tell apart from the
    // first.
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeDefined();
    });

    release();
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-stopped").textContent).toContain("Stopped after 10,000 keys");
    });
    expect(screen.getByText("Scan all")).toBeDefined();
  });

  test("Scan more takes one more page and stops offering itself at the end of the walk", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["app:env"], "1") : page(["user:1001:name"], "0");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.click(screen.getByText("Scan more"));
    await waitFor(() => {
      expect(progress()).toBe("Scanned 2/31");
    });
    expect(rows()).toEqual(["app:*@0", "user:*@0"]);

    // A spent cursor is the only end-of-walk signal there is, and a button that stayed enabled would
    // re-walk a key space it has already seen.
    await waitFor(() => {
      expect((screen.getByText("Scan more") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("Stop ends the loop and leaves the walk resumable", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        call += 1;
        const cursor = await cursorOf(req);
        if (call === 1) return page(["a"], "1");
        // The page `Scan all` is waiting on, held so Stop can land while it is in flight.
        if (call === 2) {
          await gate;
          return page(["b"], "2");
        }
        return page([`c-${cursor}`], "3");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(progress()).toBe("Scanned 1/31");
    });

    fireEvent.click(screen.getByText("Scan all"));
    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeDefined();
    });
    fireEvent.click(screen.getByText("Stop"));
    release();

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-stopped").textContent).toContain("Stopped.");
    });
    // The page already in flight lands and is counted: it is not a request that can be recalled.
    expect(progress()).toBe("Scanned 2/31");

    // Stop ends the LOOP and not the walk, so the cursor it left is still a position to carry on
    // from — which is what makes a bounded `Scan all` useful rather than a dead end.
    fireEvent.click(screen.getByText("Scan more"));
    await waitFor(() => {
      expect(progress()).toBe("Scanned 3/31");
    });
    // Three keys with no separator are three leaves at the top level, each its own segment.
    expect(rows()).toEqual(["a@0", "b@0", "c-2@0"]);
  });

  test("shows each key's type beside its name, and nothing for a key no page described", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": page(["app:env", "session:abc", "app:secret"], "0", 3, {
        "app:env": "string",
        "session:abc": "hash",
      }),
    });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0", "session:*@0"]);
    });
    fireEvent.click(screen.getByText("app:*"));

    // A FOLDER CARRIES NO TYPE — it has no value — and its child count sits in the same right-hand
    // column, which is what keeps one edge answering "what is this row" for every row. `app:secret`
    // was in the batch and NOT in the page's type map, and the empty cell is the honest drawing of a
    // key the server did not describe: a guess would be a claim about the value that nobody made.
    expect(typesByRow()).toEqual({
      "app:*": "",
      "app:env": "string",
      "app:secret": "",
      "session:*": "",
    });
  });

  /**
   * Activating a key, which is what turns the panel from a list into a way in.
   *
   * THE TYPE IS ALREADY HERE, so none of these tests expects a request: the page described its keys
   * when it brought them, and that is what makes an activation free.
   */
  describe("activating a key", () => {
    test("hands over the key and the type the page described", async () => {
      const opened: Array<[string, string | null]> = [];
      mockGlobalFetch({
        "/api/db/keys/scan": page(["app:env", "app:secret"], "0", 2, { "app:env": "string" }),
      });
      renderBrowser(CAPABILITY, (key, type) => opened.push([key, type]));
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.click(screen.getByText("app:env"));
      expect(opened).toEqual([["app:env", "string"]]);

      fireEvent.click(screen.getByText("app:secret"));
      // A key no page described is handed over as `null` rather than guessed at: what to do about a
      // key nobody described is the shell's decision, and a type invented here would be this panel's.
      expect(opened[1]).toEqual(["app:secret", null]);
    });

    test("hands over the database the walk is reading, so the read runs where the key is", async () => {
      const opened: Array<[string, string | null, number | null]> = [];
      mockGlobalFetch(redisRoutes(page(["app:env"], "0", 2, { "app:env": "string" })));
      render(
        <KeyBrowser
          connection={CONNECTION}
          capability={CAPABILITY}
          databaseLevel={LEVEL}
          onOpenKey={(key, type, database) => opened.push([key, type, database])}
        />,
      );
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.click(screen.getByText("app:env"));
      // The session's own database hands over NOTHING to override: absent means the engine's own on
      // both sides of the wire, which is what keeps an ordinary activation the call it always was.
      expect(opened).toEqual([["app:env", "string", null]]);

      // A database the reader chose travels WITH the key, because Redis has no database-qualified key
      // syntax: the generated `GET <key>` cannot name the database its key belongs to, so the tab has
      // to be told which one it was opened against.
      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Database"));
      await user.click(await screen.findByRole("option", { name: "1" }));
      // The folder stays open across the restart — expansion is state of THIS panel, not of the walk —
      // so the leaf is drawn again as soon as the new database's page answers.
      await waitFor(() => {
        expect(rows()).toEqual(["1@0", "app:*@1", "app:env@2"]);
      });
      fireEvent.click(screen.getByText("app:env"));

      expect(opened.at(-1)).toEqual(["app:env", "string", 1]);
    });

    test("opens a row that is BOTH a key and a prefix, and keeps its twisty for the children", async () => {
      const opened: Array<[string, string | null]> = [];
      mockGlobalFetch({
        "/api/db/keys/scan": page(["user:42", "user:42:profile"], "0", 2, {
          "user:42": "string",
          "user:42:profile": "hash",
        }),
      });
      renderBrowser(CAPABILITY, (key, type) => opened.push([key, type]));
      await waitFor(() => {
        expect(rows()).toEqual(["user:*@0"]);
      });
      fireEvent.click(screen.getByText("user:*"));

      // `user:42` is a key of this database AND the prefix of `user:42:profile`. The row says the KEY's
      // name, because that is what activating it addresses, and carries BOTH numbers: what it is worth
      // reading as, and how much sits under it.
      expect(rows()).toEqual(["user:*@0", "user:42@1"]);
      const rowFor = (label: string): HTMLElement =>
        screen
          .queryAllByRole("treeitem")
          .find((element) => element.querySelector("span.truncate")?.textContent === label) as HTMLElement;
      expect(within(rowFor("user:42")).getByTestId("key-browser-type").textContent).toBe("string");
      expect(within(rowFor("user:42")).getByTestId("key-browser-folder-count").textContent).toBe("2");
      expect(rowFor("user:42").getAttribute("title")).toContain("is a key of this database and a prefix");

      // THE TWISTY IS THE FOLDER, and it must not also open the key: one press cannot mean "read this
      // value" and "open these children" at once. It opens the child the row could not reach before.
      fireEvent.click(within(rowFor("user:42")).getByTestId("key-browser-twisty"));
      expect(opened).toEqual([]);
      expect(rows()).toEqual(["user:*@0", "user:42@1", "user:42:profile@2"]);

      // THE ROW IS THE KEY, folded or not: what the twisty hides is the children, never the value.
      fireEvent.click(within(rowFor("user:42")).getByTestId("key-browser-twisty"));
      expect(rows()).toEqual(["user:*@0", "user:42@1"]);
      fireEvent.click(screen.getByText("user:42"));
      expect(opened).toEqual([["user:42", "string"]]);

      // And the keyboard reaches the same two things, because the row and the twisty are separate
      // controls: Enter on the row opens the key.
      fireEvent.keyDown(screen.getByText("user:42"), { key: "Enter" });
      expect(opened).toHaveLength(2);
    });

    test("opens a folder instead of activating it", async () => {
      const opened: Array<[string, string | null]> = [];
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1, { "app:env": "string" }) });
      renderBrowser(CAPABILITY, (key, type) => opened.push([key, type]));
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });

      fireEvent.click(screen.getByText("app:*"));

      // A prefix has no value, so there is nothing to read and the press tells nobody: a reader who
      // clicks a folder means "open it".
      expect(opened).toEqual([]);
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);
    });

    test("activates from the keyboard as well as the pointer", async () => {
      const opened: Array<[string, string | null]> = [];
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1, { "app:env": "string" }) });
      renderBrowser(CAPABILITY, (key, type) => opened.push([key, type]));
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.keyDown(screen.getByText("app:env"), { key: "Enter" });
      fireEvent.keyDown(screen.getByText("app:env"), { key: " " });
      expect(opened).toEqual([
        ["app:env", "string"],
        ["app:env", "string"],
      ]);

      // Any other key is not an activation, so a stray press does not open a tab.
      fireEvent.keyDown(screen.getByText("app:env"), { key: "Tab" });
      expect(opened).toHaveLength(2);
    });

    test("a held key activates once, and its repeats are still swallowed", async () => {
      // Every auto-repeat of a held Enter or Space arrives as another keydown, so without the
      // guard one long press opened a tab per repeat.
      const opened: Array<[string, string | null]> = [];
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1, { "app:env": "string" }) });
      renderBrowser(CAPABILITY, (key, type) => opened.push([key, type]));
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      expect(fireEvent.keyDown(screen.getByText("app:env"), { key: " " })).toBe(false);
      // `false` is a keydown whose default was prevented, so a repeat never scrolls the list.
      expect(fireEvent.keyDown(screen.getByText("app:env"), { key: " ", repeat: true })).toBe(false);
      expect(fireEvent.keyDown(screen.getByText("app:env"), { key: "Enter", repeat: true })).toBe(false);
      expect(opened).toEqual([["app:env", "string"]]);
    });

    test("is not actionable when nobody is listening", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["app:env"], "0", 1, { "app:env": "string" }),
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      // A row that looks actionable and does nothing is worse than one that plainly is not, so the
      // click is a no-op — nothing opens, nothing is fetched, and the tree does not move.
      fireEvent.click(screen.getByText("app:env"));
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);
      expect(fetchMock.mock.calls.length).toBe(1);
    });
  });

  /**
   * The prefix-scoped walk, which is the only thing that can answer "is there more under here" about
   * a prefix the global sample missed. Its row is a SIBLING of the children it follows, one level
   * deeper than the folder it belongs to.
   */
  describe("Load more", () => {
    test("offers itself under an open folder and asks about that prefix", async () => {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "9") });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      // Nothing to continue while the folder is closed: the row would be an offer with nothing above
      // it.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();

      fireEvent.click(screen.getByText("app:*"));
      const more = screen.getByTestId("key-browser-load-more");
      expect(more.textContent).toContain("Click to load more");

      fireEvent.click(more);

      await waitFor(() => {
        expect(fetchMock.mock.calls.length).toBe(2);
      });
      const body = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as Record<string, unknown>;
      // The pattern is built from the prefix, and the cursor starts at `"0"` because this row's own
      // walk is what moves it from there.
      expect(body).toMatchObject({ pattern: "app:*", cursor: "0" });
    });

    test("stops offering itself for a prefix whose own walk came back spent", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:env"], "9") : page(["app:only"], "0");
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.click(screen.getByTestId("key-browser-load-more"));
      await waitFor(() => {
        expect(rows()).toContain("app:only@1");
      });
      // Cursor `"0"` is the one thing that PROVES there is nothing more under the prefix, so the row
      // goes rather than staying as an offer that can only come back empty.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
    });

    test("stops offering itself everywhere once the database walk is spent", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1) });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      // A spent cursor at the DATABASE level means the sample IS the key space, so every prefix in it
      // is complete: a "there may be more" row would be a claim the walk already disproved.
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
    });

    test("keeps the tree when a scoped page fails, and says so", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:env"], "9", 31) : { status: 500, json: { error: "NOPERM no scan" } };
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      fireEvent.click(screen.getByTestId("key-browser-load-more"));

      await waitFor(() => {
        expect(screen.getByTestId("key-browser-error").textContent).toContain("NOPERM no scan");
      });
      // The rows the server really gave are still answers, so a page that could not be taken does not
      // take them away.
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);
      expect(screen.queryByTestId("key-browser-empty")).toBeNull();
    });

    test("does not offer itself while a filter is on", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "9") });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      expect(screen.getByTestId("key-browser-load-more")).toBeDefined();

      // A filtered view is a view of WHAT IS HELD, and a row that pulled more keys into it would make
      // what a reader sees depend on clicks the filter's term does not explain.
      fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "env" } });
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
      expect(rows()).toEqual(["app:*@0", "app:env@1"]);

      fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "" } });
      expect(screen.getByTestId("key-browser-load-more")).toBeDefined();
    });

    test("says what a press did, and counts the keys under the prefix", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          // The global page holds two keys and a live cursor; the scoped page answers with a key the
          // tree already has, which is the answer that used to look like a dead button.
          return call === 1 ? page(["app:env", "app:cache:ttl"], "9", 2) : page(["app:env"], "5", 2);
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      // Before the press: the number of keys this prefix holds, which is what the press is measured
      // against, in the same right-hand column every other row keeps its number in.
      expect(screen.getByTestId("key-browser-load-more-count").textContent).toBe("2 keys");
      expect(screen.getByTestId("key-browser-load-more").textContent).toContain("Click to load more");

      fireEvent.click(screen.getByTestId("key-browser-load-more"));

      await waitFor(() => {
        expect(screen.getByTestId("key-browser-load-more").textContent).toContain("nothing new in that page");
      });
      // Nothing new is a true answer and it is NOT the same as never asked: absent means one thing and
      // a page that added nothing means another, and the two must not read alike.
      expect(screen.getByTestId("key-browser-load-more-count").textContent).toBe("2 keys");
    });

    test("reports the keys a press added", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:env"], "9", 2) : page(["app:cache:ttl", "app:env"], "5", 2);
        },
      });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));

      fireEvent.click(screen.getByTestId("key-browser-load-more"));

      // One of the two keys in the page was new, and the count is what the tree now holds.
      await waitFor(() => {
        expect(screen.getByTestId("key-browser-load-more").textContent).toContain("+1 new");
      });
      expect(screen.getByTestId("key-browser-load-more-count").textContent).toBe("2 keys");
    });

    test("counts the KEYS under a prefix, and keeps the row count on the tooltip", async () => {
      // `app` can be opened to two rows and holds three keys, and the badge is the NUMBER OF KEYS:
      // that is the number which moves as pages arrive, and the one a reader in front of a folder is
      // asking about. The row count is the other half of the fact, and it is on the tooltip.
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:a:1", "app:a:2", "app:b"], "0", 3) });
      renderBrowser();
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      fireEvent.click(screen.getByText("app:*"));
      expect(rows()).toEqual(["app:*@0", "a:*@1", "app:b@1"]);

      const appRow = screen
        .queryAllByRole("treeitem")
        .find((row) => row.querySelector("span.truncate")?.textContent === "app:*");
      const badge = appRow?.querySelector('[data-testid="key-browser-folder-count"]');
      expect(badge?.textContent).toBe("3");
      // The number that is NOT the badge is still reachable, because it answers a different question
      // and hiding it altogether would make a folder look like it opens on nothing.
      expect(badge?.getAttribute("title")).toContain("3 keys loaded under this prefix so far, in 2 rows");
    });
  });

  /**
   * The database the keys are in, which is the one thing above a key that really exists.
   *
   * The walk names it, the engine lists it, and the tree hangs under it — so a reader can tell WHICH
   * numbered database a prefix belongs to, and can reach the other fifteen rather than only ever
   * seeing the one the session happened to be in.
   */
  test("says the counts are one node's when the server is clustered, and stays silent otherwise", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["app:env"], cursor: "0", total: 333_249, types: {}, clustered: true } },
      "/api/db/objects/containers": { json: DATABASES },
    });
    renderLevel();

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-clustered")).toBeDefined();
    });
    // VISIBLE, because the count is what the panel divides by everywhere: a reader who has to hover to
    // learn that two thirds of the key space is missing from the denominator is a reader who will not
    // learn it (#1094). The two tooltips agree with the sentence.
    expect(screen.getByTestId("key-browser-clustered").textContent).toContain("one node at a time");
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toContain("this NODE holds");
    expect(screen.getByTestId("key-browser-database-total").getAttribute("title")).toContain("THIS NODE counts");
  });

  test("draws no node warning for a server that answered that it is not clustered", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["app:env"], cursor: "0", total: 31, types: {}, clustered: false } },
      "/api/db/objects/containers": { json: DATABASES },
    });
    renderLevel();

    await waitFor(() => {
      expect(rows()).toEqual(["0@0", "app:*@1"]);
    });
    // FALSE is an ordinary answer and absent is a reply that could not be read: neither claims a
    // cluster, so neither draws the sentence.
    expect(screen.queryByTestId("key-browser-clustered")).toBeNull();
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(
      "out of every key this database holds",
    );
  });

  describe("the database the walk is in", () => {
    test("draws it as the tree's root, and walks the session's own until somebody chooses", async () => {
      const fetchMock = mockGlobalFetch(redisRoutes(page(["app:env"], "0", 1531)));
      renderLevel();

      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      // The database row carries the SERVER's own count — `DBSIZE`, which travels with every page —
      // rather than the sample's, so the one number above the tree is the size of the key space.
      expect(screen.getByTestId("key-browser-database-total").textContent).toBe("1,531");
      expect(screen.getByTestId("key-browser-database").getAttribute("title")).toBe("Database 0");
      expect(screen.getByTestId("key-browser-database").getAttribute("aria-expanded")).toBe("true");

      // The session's own database is what the engine already answers with, so NOTHING is sent for
      // it: a request carrying it would ask for what the engine defaulted to, and the walk would
      // restart the moment this list arrived.
      expect(walksOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", count: 500 }]);
      // The picker shows the database the walk is READING, which before any choice is the one the
      // engine named as the session's own.
      expect(screen.getByLabelText("Database").textContent).toBe("0");
    });

    test("restarts the walk in the database the reader chose", async () => {
      const fetchMock = mockGlobalFetch(redisRoutes(page(["app:env"], "0", 1531)));
      renderLevel();
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });

      // The project's own `Select` rather than a native one: its popup is the themed surface every
      // other picker in the product opens, where a native `<option>` list is painted by the browser.
      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Database"));
      await user.click(await screen.findByRole("option", { name: "1" }));

      await waitFor(() => {
        expect(walksOf(fetchMock).filter((body) => body.database === 1)).toHaveLength(1);
      });
      // A different database is a different key space: the walk starts at cursor `"0"` again rather
      // than carrying the other database's position into it, and the tree is rebuilt from its pages.
      expect(walksOf(fetchMock).at(-1)).toMatchObject({ database: 1, cursor: "0" });
      await waitFor(() => {
        expect(rows()).toEqual(["1@0", "app:*@1"]);
      });
      expect(screen.getByLabelText("Database").textContent).toBe("1");
    });

    test("offers the session's own database as a choice, and going back to it sends no number", async () => {
      const fetchMock = mockGlobalFetch(redisRoutes(page(["app:env"], "0", 1531)));
      renderLevel();
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });

      const user = userEvent.setup();
      await user.click(screen.getByLabelText("Database"));
      await user.click(await screen.findByRole("option", { name: "1" }));
      await waitFor(() => {
        expect(walksOf(fetchMock).at(-1)).toMatchObject({ database: 1 });
      });

      await user.click(screen.getByLabelText("Database"));
      await user.click(await screen.findByRole("option", { name: "session" }));

      // Back to the engine's own answer: the field goes back to being ABSENT rather than becoming a
      // number this panel picked, which is the difference between "the session's" and "database 0".
      await waitFor(() => {
        expect(walksOf(fetchMock).at(-1)).not.toHaveProperty("database");
      });
      expect(screen.getByLabelText("Database").textContent).toBe("0");
    });

    test("collapses the database row without asking the server for anything", async () => {
      const fetchMock = mockGlobalFetch(redisRoutes(page(["app:env"], "0", 1531)));
      renderLevel();
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      const before = fetchMock.mock.calls.length;

      fireEvent.click(screen.getByTestId("key-browser-database"));
      expect(rows()).toEqual(["0@0"]);
      expect(screen.getByTestId("key-browser-database").getAttribute("aria-expanded")).toBe("false");

      // The keys are already held, so folding the root is a local rearrangement like any other row's.
      fireEvent.keyDown(screen.getByTestId("key-browser-database"), { key: "Enter" });
      expect(rows()).toEqual(["0@0", "app:*@1"]);
      expect(fetchMock.mock.calls.length).toBe(before);
    });

    test("a held key toggles the database row once, and its repeats are swallowed", async () => {
      mockGlobalFetch(redisRoutes(page(["app:env"], "0", 1531)));
      renderLevel();
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      const database = () => screen.getByTestId("key-browser-database");

      // The press itself toggles: the control.
      expect(fireEvent.keyDown(database(), { key: "Enter" })).toBe(false);
      expect(database().getAttribute("aria-expanded")).toBe("false");
      // Each auto-repeat is another keydown, prevented all the same, and none toggles the row back.
      // Checked after each one, because two unguarded toggles would land back where they began.
      expect(fireEvent.keyDown(database(), { key: "Enter", repeat: true })).toBe(false);
      expect(database().getAttribute("aria-expanded")).toBe("false");
      expect(fireEvent.keyDown(database(), { key: " ", repeat: true })).toBe(false);
      expect(database().getAttribute("aria-expanded")).toBe("false");
      expect(rows()).toEqual(["0@0"]);
    });

    test("says so and keeps walking when the database list cannot be read", async () => {
      mockGlobalFetch({
        "/api/db/keys/scan": page(["app:env"], "0", 31),
        "/api/db/objects/containers": { status: 403, json: { error: "NOPERM no config for you" } },
      });
      renderLevel();

      await waitFor(() => {
        expect(screen.getByTestId("key-browser-databases-error").textContent).toContain("NOPERM no config for you");
      });
      // The list is a convenience and the walk is the feature: the panel keeps the keys it read, and
      // the choice stands down rather than offering databases nobody listed.
      expect(rows()).toEqual(["app:*@0"]);
      expect((screen.getByLabelText("Database") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByTestId("key-browser-database")).toBeNull();
    });

    test("leaves a container it cannot address to the engine", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["app:env"], "0", 31),
        "/api/db/objects/containers": { json: [{ path: ["main"], name: "main", level: 0, isSessionDefault: true }] },
      });
      renderLevel();

      // `main` is not a number, so the walk's `database` field cannot name it: nothing is sent and the
      // engine answers with the session's database, which is the one the panel says it is reading.
      await waitFor(() => {
        expect(screen.getByTestId("key-browser-database")).toBeDefined();
      });
      expect(screen.getByTestId("key-browser-database").querySelector("span.truncate")?.textContent).toBe("main");
      expect(screen.getByLabelText("Database").textContent).toBe("main");
      expect(walksOf(fetchMock).filter((body) => "database" in body)).toEqual([]);
    });

    test("walks as a whole on an engine with no level to choose from", async () => {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 31) });
      render(
        <KeyBrowser
          connection={CONNECTION}
          capability={CAPABILITY}
          databaseLevel={undefined}
          request={{ pattern: "app:*" }}
        />,
      );

      // No level declared means no container list to read and no root row to draw: the walk is the
      // whole key space, which is what this panel was before there was anything to choose.
      await waitFor(() => {
        expect(rows()).toEqual(["app:*@0"]);
      });
      expect(screen.queryByLabelText("Database")).toBeNull();
      expect(screen.queryByTestId("key-browser-database")).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(1);
    });
  });

  /**
   * Refresh, which is the panel asking its own question again.
   *
   * A key space changes under a sample, so re-reading it is an ordinary thing to want rather than a
   * recovery from a failure — and it is the only way to see a key somebody else wrote.
   */
  describe("refresh", () => {
    test("takes the first page again when the reader asks", async () => {
      const fetchMock = mockGlobalFetch(redisRoutes(page(["app:env"], "0", 31)));
      renderLevel();
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      const before = walksOf(fetchMock).length;

      fireEvent.click(screen.getByTestId("key-browser-refresh"));

      await waitFor(() => {
        expect(walksOf(fetchMock).length).toBe(before + 1);
      });
      // Cursor `"0"`: this is the same question asked again, not a continuation of the last walk.
      expect(walksOf(fetchMock).at(-1)).toMatchObject({ cursor: "0", count: 500 });
    });

    test("drops the page that was in the air rather than mixing it into the new walk", async () => {
      // A no-op default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
      // type `never`.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let call = 0;
      mockGlobalFetch(
        redisRoutes(async () => {
          call += 1;
          if (call === 1) {
            await gate;
            return page(["stale:key"], "5", 31);
          }
          return page(["fresh:key"], "0", 31);
        }),
      );
      renderLevel();

      // The first page is in the air when the reader refreshes. Its answer belongs to a walk that no
      // longer exists, and mixing it in is how a sample comes to hold two databases' keys.
      fireEvent.click(screen.getByTestId("key-browser-refresh"));
      release();

      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "fresh:*@1"]);
      });
      expect(progress()).toBe("Scanned 1/31");
    });
  });

  /**
   * A pattern the object tree's row menu asked for, which is how a `user:*` row reaches the surface
   * built to walk it.
   */
  describe("a pattern the shell asked for", () => {
    test("starts the walk on the pattern it was handed, glob and all", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["app:cache:ttl"], "0", 31),
        "/api/db/objects/containers": { json: DATABASES },
      });
      renderLevel({ pattern: "app:*" });

      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });
      expect((screen.getByLabelText("Match pattern") as HTMLInputElement).value).toBe("app:*");
      // The name is the pattern AS IT STANDS: a key prefix already carries its `*`, and a caller that
      // appended another would address a different set of keys.
      expect(walksOf(fetchMock)[0]).toMatchObject({ pattern: "app:*" });
    });

    test("selects the database the request named, and does not walk the wrong one first", async () => {
      // The container list is HELD so the wait is observable: a panel that started its walk before the
      // list answered would take a page of the session's database and throw it away, which is the
      // flash of one database's keys under another database's name.
      // A no-op default rather than `| null`: the executor below replaces it before anything waits.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["app:env"], "0", 2),
        "/api/db/objects/containers": async () => {
          await gate;
          return { json: DATABASES };
        },
      });
      renderLevel({ pattern: "app:*", database: "1" });

      expect(walksOf(fetchMock)).toEqual([]);

      release();
      // Waited on the TREE rather than on the request count: the request is issued a moment before its
      // page is absorbed, and a count says nothing about whether the walk landed.
      await waitFor(() => {
        expect(rows()).toEqual(["1@0", "app:*@1"]);
      });
      // ONE page, and it is the database the row named: a row under `Database 1` walks database 1, not
      // whichever one the panel happened to be in.
      expect(walksOf(fetchMock)).toHaveLength(1);
      expect(walksOf(fetchMock)[0]).toMatchObject({ pattern: "app:*", cursor: "0", database: 1 });
      expect(screen.getByLabelText("Database").textContent).toBe("1");
    });

    test("applies a new request to a panel already walking, and drops the stale filter", async () => {
      const seen: string[] = [];
      mockGlobalFetch({
        "/api/db/keys/scan": async (req) => {
          const body = (await req.json()) as { pattern?: string };
          seen.push(body.pattern ?? "");
          return body.pattern === undefined
            ? page(["app:env", "user:1001:name"], "0", 2)
            : page(["session:abc"], "0", 2);
        },
        "/api/db/objects/containers": { json: DATABASES },
      });
      const { rerender } = render(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} databaseLevel={LEVEL} />);
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1", "user:*@1"]);
      });
      fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "app" } });
      // With a filter on, every surviving folder is open, so the match two levels down is drawn.
      expect(rows()).toEqual(["0@0", "app:*@1", "app:env@2"]);

      rerender(
        <KeyBrowser
          connection={CONNECTION}
          capability={CAPABILITY}
          databaseLevel={LEVEL}
          request={{ pattern: "session:*" }}
        />,
      );

      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "session:*@1"]);
      });
      // The filter belonged to the keys that were on screen: left on, it would hide the answer to the
      // request that was just made.
      expect((screen.getByLabelText("Filter the keys found") as HTMLInputElement).value).toBe("");
      expect(seen).toEqual(["", "session:*"]);
    });

    test("does not re-impose a request the panel has already applied", async () => {
      const request: KeyPatternRequest = { pattern: "app:*" };
      const seen: string[] = [];
      mockGlobalFetch({
        "/api/db/keys/scan": async (req) => {
          const body = (await req.json()) as { pattern?: string };
          seen.push(body.pattern ?? "");
          return body.pattern === "user:*" ? page(["user:1001:name"], "0", 2) : page(["app:env"], "0", 2);
        },
        "/api/db/objects/containers": { json: DATABASES },
      });
      const { rerender } = render(
        <KeyBrowser connection={CONNECTION} capability={CAPABILITY} databaseLevel={LEVEL} request={request} />,
      );
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "app:*@1"]);
      });

      // The reader takes the wheel: the pattern is theirs from the moment they type in it.
      fireEvent.change(screen.getByLabelText("Match pattern"), { target: { value: "user:*" } });
      await waitFor(() => {
        expect(rows()).toEqual(["0@0", "user:*@1"]);
      });

      // The SAME request object again is not a new one, so nothing is re-applied: identity is the
      // question, and this one has already been answered.
      rerender(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} databaseLevel={LEVEL} request={request} />);
      expect((screen.getByLabelText("Match pattern") as HTMLInputElement).value).toBe("user:*");
      expect(seen).toEqual(["app:*", "user:*"]);
    });

    test("says Matched rather than Scanned once a pattern narrows what the walk is handed", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0", 1531) });
      const { rerender } = render(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} />);
      await waitFor(() => {
        expect(progress()).toBe("Scanned 1/1531");
      });

      // `scanned` counts what the walk was HANDED and `total` is every key in the database, so with a
      // pattern the pair is not a fraction of a walk: 137 of 1531 matching keys is a finished walk,
      // and the word has to say so rather than invite a reader to wait for it.
      rerender(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} request={{ pattern: "app:*" }} />);
      await waitFor(() => {
        expect(progress()).toBe("Matched 1 of 1531");
      });
      expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toContain(
        "every key this database holds",
      );

      // And a request that clears the pattern goes back to a plain walk of the whole key space.
      rerender(<KeyBrowser connection={CONNECTION} capability={CAPABILITY} request={{ pattern: "" }} />);
      await waitFor(() => {
        expect(progress()).toBe("Scanned 1/1531");
      });
    });
  });
  /**
   * The panel's OWN bound, which is the one `Scan all`'s per-gesture budget is not.
   *
   * `SCAN_ALL_MAX_KEYS` bounds one press; this bounds everything the tree holds across every press of
   * every control. The two are the same number on purpose - one budget, stated once - but they end
   * different walks, and only this one can make an OFFER impossible rather than merely expensive.
   */
  describe("the held-key limit", () => {
    test("says the tree is full and stops offering walks it could not use", async () => {
      // 10,001 keys over THREE sub-folders: the limit is reached, and opening the prefix leaves three
      // rows rather than ten thousand, so the assertion below is about the offer and not the render.
      mockGlobalFetch({
        "/api/db/keys/scan": page(
          Array.from({ length: HELD_KEY_LIMIT + 1 }, (_, index) => `bulk:${index % 3}:${index}`),
          "7",
          12_000,
        ),
      });
      renderBrowser();

      await waitFor(() => {
        expect(screen.getByTestId("key-browser-held")).toBeDefined();
      });
      expect(screen.getByTestId("key-browser-held").textContent).toContain("10,000");

      // The numerator counts what the server HANDED over, and it was handed 10,001 - but the panel
      // declares ten thousand its budget two lines below, so the fraction stops at the budget rather
      // than printing a number above the limit it just stated. The tree holds exactly ten thousand,
      // and the fraction is printed raw rather than with the tree's thousands separators.
      expect(progress()).toBe("Scanned 10000/12000");

      // The two controls that take pages do not offer one...
      expect((screen.getByText("Scan more") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByText("Scan all") as HTMLButtonElement).disabled).toBe(true);

      // ...and a prefix's own row does not either: a scoped page would be filtered, deduplicated and
      // dropped, so an offer that cannot deliver is worse than none. The cursor is still live, which
      // is what makes this the held bound rather than the walk being spent.
      fireEvent.click(screen.getByText("bulk:*"));
      expect(rows()).toEqual(["bulk:*@0", "0:*@1", "1:*@1", "2:*@1"]);
      expect(screen.queryByTestId("key-browser-load-more")).toBeNull();
    });
  });
  /**
   * The window doing its job, and the one row it must not lose.
   *
   * jsdom lays nothing out, so an unmeasured box measures 0 — and the panel's rule for that case is
   * "mount everything you have" rather than a guess. Faking the measurement is therefore how the
   * window's arithmetic is reached at all, and it is what the panel does on every real scroll.
   */
  test("mounts only what the box can show, and keeps a focused row when the window moves", async () => {
    let pageTwo = 0;
    const first = Array.from({ length: 40 }, (_, index) => `k${index}`);
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        pageTwo += 1;
        return pageTwo === 1 ? page(first, "9") : page(["k40", "k41", "k42"], "0");
      },
    });
    renderBrowser();
    await waitFor(() => {
      expect(rows().length).toBe(40);
    });

    const tree = screen.getByRole("tree");
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 240 });
    // Scrolled past the end on purpose: the window clamps rather than asking for rows that do not
    // exist, so the slice is the last eighteen rather than an empty one.
    Object.defineProperty(tree, "scrollTop", { configurable: true, value: KEY_ROW_HEIGHT * first.length });
    fireEvent.scroll(tree);

    expect(rows().length).toBe(18);
    expect(rows()[0]).toBe(`k${first.length - 18}@0`);

    // Focus the first row that IS mounted — k22, panel index 22 — and give the row that focus
    // protects a reason to move: `Scan more` grows the list, which moves the window's start from 22
    // to 36 and would unmount the row the reader is standing on.
    fireEvent.focus(screen.queryAllByRole("treeitem")[0]);
    fireEvent.click(screen.getByText("Scan more"));
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(0);
    });

    // A focused row is in the window whatever the list did, because focus cannot move to a node that
    // is not in the DOM. Without the pin, this assertion is the one that fails.
    expect(rows().map((row) => row.split("@")[0])).toContain("k22");

    // And the pin does NOT fight the scrollbar: scrolling is the reader's own instruction, so the
    // window follows it again and the focused row may leave — the object tree's own rule.
    Object.defineProperty(tree, "scrollTop", { configurable: true, value: 0 });
    fireEvent.scroll(tree);
    expect(rows().map((row) => row.split("@")[0])).not.toContain("k22");
  });

  test("keeps the tree mounted when a row near the top takes focus", async () => {
    // THE REPORTED BUG, driven the way the reader drives it: a measured box, no scrolling, and a click
    // on a row near the top. The window's overscan subtraction went negative up there, and a negative
    // start is not an early window — `slice(-4, 14)` counts from the END, so the panel drew nothing at
    // all below the filter box, database row included, until a click on the picker (which focuses no
    // row) took the other branch. The row is focused rather than clicked because focus is the state
    // that matters here, and a click on a treeitem focuses it too.
    mockGlobalFetch(
      redisRoutes(
        page(
          Array.from({ length: 40 }, (_, index) => `k${index}`),
          "0",
          40,
        ),
      ),
    );
    renderLevel();
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(1);
    });

    const tree = screen.getByRole("tree");
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 240 });
    // Measuring is the scroll handler's job and the scroll it reports is zero, which is the position
    // this bug lived in.
    fireEvent.scroll(tree);
    fireEvent.focus(screen.queryAllByRole("treeitem")[1]);

    // Eighteen rows is what the box holds, and the database row is the first of them: the tree is
    // still there, at the same place, rather than emptied by the arithmetic.
    expect(rows().length).toBe(18);
    expect(rows()[0]).toBe("0@0");
    expect(screen.getByTestId("key-browser-database")).toBeDefined();
  });
});

/**
 * The panel in a declared shape (spec 3.4, 4.6): an engine that walks a byte-ordered key space under
 * `/`, reads a literal prefix, counts the walk's own range and leaves out a key it cannot name. The
 * Redis tests above declare no shape and are the other half of the rule: every text here is derived
 * from the declaration, and a `glob` one answers today's strings byte for byte.
 */
describe("a panel in a declared shape", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  const ETCD_SCAN: KeyScanCapability = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "walk",
  };
  const REASON = "a key that is not UTF-8 text has no name a row could carry; a typed get shows it in base64.";

  /**
   * An etcd-shaped route: every key under the prefix the body names, in one page, with the walk's own
   * count as its total. Every body it was sent is kept, so a test can read the prefix it asked for.
   */
  function prefixRoute(keys: readonly string[], extra: Partial<KeyScanPage> = {}) {
    const seen: Array<Record<string, unknown>> = [];
    const handler = async (req: Request): Promise<MockFetchResponse> => {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push(body);
      const prefix = typeof body.pattern === "string" ? body.pattern : "";
      const under = keys.filter((key) => key.startsWith(prefix));
      return { json: { keys: under, cursor: "0", total: under.length, types: {}, ...extra } };
    };
    return { handler, seen };
  }

  /** Open every folder the panel draws, one twisty at a time, the way a reader would. */
  function openEveryFolder(): void {
    // Bounded, so a twisty that did not open fails this test instead of spinning it.
    for (let pass = 0; pass < 100; pass += 1) {
      const closed = screen
        .queryAllByTestId("key-browser-twisty")
        .find((twisty) => twisty.getAttribute("aria-label")?.startsWith("Expand "));
      if (closed === undefined) return;
      fireEvent.click(closed);
    }
    throw new Error("a folder of the key tree did not open");
  }

  /** The row whose label is exactly `label`, or undefined. */
  function rowLabelled(label: string): HTMLElement | undefined {
    return screen.queryAllByRole("treeitem").find((row) => row.querySelector("span.truncate")?.textContent === label);
  }

  test("draws a key that starts with the separator under the / root row, beside a key that has none", async () => {
    const route = prefixRoute(["/apisix/routes/1", "/feature-flag", "k3s/x", "plain"]);
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderBrowser(ETCD_SCAN);

    await waitFor(() => {
      expect(rows()).toEqual(["/*@0", "k3s/*@0", "plain@0"]);
    });
    const root = rowLabelled("/*") as HTMLElement;
    // The root row is named, titled and announced: none of the three is the empty string.
    expect(root.getAttribute("title")).toBe("/*");
    expect(within(root).getByTestId("key-browser-twisty").getAttribute("aria-label")).toBe("Expand /");
    // No container level is declared, so the panel reads no container list and draws no database row.
    expect(fetchMock.mock.calls.every((call) => String(call[0]).includes("/api/db/keys/scan"))).toBe(true);

    fireEvent.click(screen.getByText("/*"));
    expect(rows()).toEqual(["/*@0", "apisix/*@1", "/feature-flag@1", "k3s/*@0", "plain@0"]);
  });

  test("Review Focus 1: every straining key is drawn, named and handed over as its stored string", async () => {
    const keys = [
      "/a//b",
      "/app/",
      "/app/cfg",
      "/",
      "/sp ace/k",
      "/q'uo\"te/k",
      "/nl\nx/k",
      "/#h/k",
      "/$d/k",
      "/-lead/k",
      "-top",
      "plain",
    ];
    const opened: string[] = [];
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(keys, { skipped: { count: 1, reason: REASON } }).handler });
    renderBrowser(ETCD_SCAN, (key) => opened.push(key));
    await waitFor(() => {
      expect(rows()).toContain("/*@0");
    });

    openEveryFolder();

    // No row is nameless, untitled or announced with an empty name, and none carries a replacement
    // character: the key no path can carry was left out by the page and is only counted.
    for (const row of screen.queryAllByRole("treeitem")) {
      const label = row.querySelector("span.truncate")?.textContent ?? "";
      expect(label).not.toBe("");
      expect(row.getAttribute("title") ?? "").not.toBe("");
      expect(`${label}${row.getAttribute("title")}`).not.toContain("�");
    }
    for (const twisty of screen.queryAllByTestId("key-browser-twisty")) {
      expect(twisty.getAttribute("aria-label")).toMatch(/^Collapse [\s\S]+$/);
    }
    expect(screen.getByTestId("key-browser-skipped").textContent).toBe(`1 key left out of this walk: ${REASON}`);

    // Every key is one row labelled with its full name, and activating it hands over exactly that name.
    for (const key of keys) {
      const row = rowLabelled(key);
      expect({ key, drawn: row !== undefined }).toEqual({ key, drawn: true });
      fireEvent.click(row as HTMLElement);
    }
    expect(opened).toEqual(keys);
  });

  test("walks the prefix a reader types, with its trailing star dropped, and nothing past it", async () => {
    const route = prefixRoute(["/app/a", "/app/b", "/apple/x"]);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    fireEvent.change(screen.getByLabelText("Key prefix"), { target: { value: "/app/*" } });

    await waitFor(() => {
      expect(progress()).toBe("Scanned 2/2");
    });
    expect(route.seen.map((body) => body.pattern ?? "")).toEqual(["", "/app/"]);
    // The scope sentence names the prefix the walk read, not the text in the box.
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(
      "out of the keys under /app/ this connection may read",
    );
    fireEvent.click(screen.getByText("/*"));
    fireEvent.click(screen.getByText("app/*"));
    // `/apple/x` begins with `/app` and not with `/app/`: a prefix that lost its separator would have
    // walked it, and the box keeps the separator for exactly that reason.
    expect(rows()).toEqual(["/*@0", "app/*@1", "/app/a@2", "/app/b@2"]);
  });

  test("says Scanned against the walk's own count whatever the prefix, and names what the connection may read", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/app/a", "/app/b", "/cfg/x"]).handler });
    const { rerender } = render(<KeyBrowser connection={CONNECTION} capability={ETCD_SCAN} />);
    await waitFor(() => {
      expect(progress()).toBe("Scanned 3/3");
    });
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(
      "out of every key this connection may read",
    );

    // A prefix is a position in an ordered range and not a filtered pass, so the word stays and the
    // pair stays a fraction: the scope sentence is what moves.
    rerender(<KeyBrowser connection={CONNECTION} capability={ETCD_SCAN} request={{ pattern: "/app/" }} />);
    await waitFor(() => {
      expect(progress()).toBe("Scanned 2/2");
    });
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(
      "out of the keys under /app/ this connection may read",
    );
  });

  const UNCOUNTED_SCAN: KeyScanCapability = { ...ETCD_SCAN, totalScope: "none" };
  const NO_TOTAL = "keys read so far: this engine publishes no key count, so no total is shown";

  test("says Scanned with no total, and why, on an engine that publishes no key count", async () => {
    // The provider answers 0 under "none", and the panel does not read it.
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/app/a", "/app/b", "/cfg/x"], { total: 0 }).handler });
    const { rerender } = render(<KeyBrowser connection={CONNECTION} capability={UNCOUNTED_SCAN} />);
    await waitFor(() => {
      expect(progress()).toBe("Scanned 3");
    });
    expect(progress()).not.toContain("/");
    expect(progress()).not.toContain(" of ");
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(NO_TOTAL);

    // A prefix keeps the word and still draws no denominator.
    rerender(<KeyBrowser connection={CONNECTION} capability={UNCOUNTED_SCAN} request={{ pattern: "/app/" }} />);
    await waitFor(() => {
      expect(progress()).toBe("Scanned 2");
    });
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(NO_TOTAL);
  });

  test("draws no count on the database row of an engine that publishes none", async () => {
    // No shipped engine declares both a database level and "none"; the row's cell is still held to the scope.
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["app:env"], cursor: "0", total: 0, types: {} } },
      "/api/db/objects/containers": { json: DATABASES },
    });
    render(
      <KeyBrowser
        connection={CONNECTION}
        capability={{ defaultCount: 500, maxCount: 1000, totalScope: "none" }}
        databaseLevel={LEVEL}
      />,
    );
    await waitFor(() => {
      expect(rows()).toEqual(["0@0", "app:*@1"]);
    });
    expect(screen.getByTestId("key-browser-database-total").textContent).toBe("");
    expect(progress()).toBe("Scanned 1");
  });

  test("words the box, its hint and the filter in the declared shape", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/app/a"]).handler });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    const box = screen.getByLabelText("Key prefix");
    expect(box.getAttribute("placeholder")).toBe("Key prefix, e.g. /app/config/");
    // A `*` typed into the box is data, and its hint says so.
    expect(box.getAttribute("title")).toContain("A * is part of the prefix");
    expect(screen.queryByLabelText("Match pattern")).toBeNull();
    expect(screen.getByLabelText("Filter the keys found").getAttribute("title")).toContain("`/`-separated segments");
  });

  test("keeps Redis's words when the declaration names no shape", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });

    const box = screen.getByLabelText("Match pattern");
    expect(box.getAttribute("placeholder")).toBe("Match pattern, e.g. app:cache:*");
    // No hint on a glob box, as before the shape existed.
    expect(box.getAttribute("title")).toBeNull();
    expect(screen.getByLabelText("Filter the keys found").getAttribute("title")).toBe(
      "Narrows the keys already loaded, without asking the server. Matches any part of a key's full name, or one of its `:`-separated segments.",
    );
  });

  test("keeps Redis's Load more title when the declaration names no shape", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page(["app:env", "app:x"], "7") });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });

    fireEvent.click(screen.getByText("app:*"));

    // Byte for byte the title the panel drew before the shape existed: a `SCAN` page is a batch of
    // buckets, and the prefix wording says the walk reads one ordered range, which is false here.
    expect(screen.getAllByTestId("key-browser-load-more")[0].getAttribute("title")).toBe(
      "Ask the server for one more page under this prefix. It answers a batch of buckets rather than a listing, so a page can hold only keys already loaded.",
    );
  });

  test("finds a full key, a prefix and a key with no leading separator in the filter", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/apisix/routes/1", "/apisix/plugins", "k3s/x"]).handler });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0", "k3s/*@0"]);
    });

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "/apisix/routes/1" } });
    expect(rows()).toEqual(["/*@0", "apisix/*@1", "routes/*@2", "/apisix/routes/1@3"]);

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "/apisix/" } });
    expect(rows()).toEqual(["/*@0", "apisix/*@1", "routes/*@2", "/apisix/routes/1@3", "/apisix/plugins@2"]);

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: "k3s/x" } });
    expect(rows()).toEqual(["k3s/*@0", "k3s/x@1"]);
  });

  test("says what a prefix's Load more reads", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": { json: { keys: ["/app/a"], cursor: "k:L2FwcC9h:3:9", total: 9, types: {} } },
    });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    fireEvent.click(screen.getByText("/*"));

    expect(screen.getAllByTestId("key-browser-load-more")[0].getAttribute("title")).toContain(
      "the next page of the keys under this prefix",
    );
  });

  test("asks the Load more under a folder named by a star for that folder's own range", async () => {
    // The walk's first page does not end it, so an open folder offers Load more; the scoped page does.
    const seen: Array<Record<string, unknown>> = [];
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.json()) as Record<string, unknown>;
        seen.push(body);
        return body.pattern === undefined
          ? { json: { keys: ["/a/*/x", "/a/b/1"], cursor: "k:L2EvYi8x:3:9", total: 9, types: {} } }
          : { json: { keys: ["/a/*/y"], cursor: "0", total: 2, types: {} } };
      },
    });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });
    fireEvent.click(screen.getByText("/*"));
    fireEvent.click(screen.getByText("a/*"));
    fireEvent.click(screen.getByText("*/*"));
    expect(rows()).toEqual(["/*@0", "a/*@1", "*/*@2", "/a/*/x@3", "b/*@2"]);

    // The first Load more row in the tree is the one under `*/*`, the deepest open folder.
    fireEvent.click(screen.getAllByTestId("key-browser-load-more")[0]);

    await waitFor(() => {
      expect(rows()).toContain("/a/*/y@3");
    });
    // Under a prefix declaration a `*` in a key is a byte: the press reads `/a/*/`, the folder's own
    // range, and not `/a/`, the range of the folder above it.
    expect(seen.at(-1)).toMatchObject({ pattern: "/a/*/", cursor: "0" });
  });

  test("names the prefix in the held-limit sentence", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": {
        json: {
          keys: Array.from({ length: HELD_KEY_LIMIT + 1 }, (_, index) => `/bulk/${index % 3}/${index}`),
          cursor: "k:L2J1bGs:4:12000",
          total: 12_000,
          types: {},
        },
      },
    });
    renderBrowser(ETCD_SCAN);

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-held").textContent).toContain(
        "Narrow the prefix to walk a smaller key space.",
      );
    });
  });

  test("keeps Redis's held-limit sentence when the declaration names no shape", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": page(
        Array.from({ length: HELD_KEY_LIMIT + 1 }, (_, index) => `bulk:${index % 3}:${index}`),
        "7",
        12_000,
      ),
    });
    renderBrowser();

    // Byte for byte the sentence the panel drew before the shape existed.
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-held").textContent).toBe(
        "Holding 10,000 keys, which is this panel's limit. Narrow the pattern to walk a smaller key space.",
      );
    });
  });

  test("counts the keys the walk left out in one line, with the count's thousands marked", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": prefixRoute(["/app/a"], { skipped: { count: 1234, reason: REASON } }).handler,
    });
    renderBrowser(ETCD_SCAN);

    await waitFor(() => {
      expect(screen.getByTestId("key-browser-skipped").textContent).toBe(`1,234 keys left out of this walk: ${REASON}`);
    });
  });

  test("reads a row's type by the key's full name in the declared separator", async () => {
    // etcd describes no types, but the panel's contract is the engine's: a page's type map is keyed by
    // the key's full name, and a row looks its own up by the same join its activation hands over.
    mockGlobalFetch({
      "/api/db/keys/scan": prefixRoute(["/app/cfg", "/app/x/y"], { types: { "/app/cfg": "text", "/app/x/y": "json" } })
        .handler,
    });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    fireEvent.click(screen.getByText("/*"));
    fireEvent.click(screen.getByText("app/*"));
    fireEvent.click(screen.getByText("x/*"));

    expect(typesByRow()).toEqual({ "/*": "", "app/*": "", "x/*": "", "/app/x/y": "json", "/app/cfg": "text" });
  });

  test("titles a row that is both a key and a prefix in the declared separator", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/app", "/app/cfg"]).handler });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    fireEvent.click(screen.getByText("/*"));

    // `/app` is a key and the prefix of `/app/cfg`. The row is labelled with the key's full name, and
    // its title says the prefix beside it with the declared folder mark, `/*`, never Redis's `:*`.
    expect(rows()).toEqual(["/*@0", "/app@1"]);
    expect(rowLabelled("/app")?.getAttribute("title")).toBe("/app is a key of this database and a prefix: /app/*");
  });

  test("draws no skipped line for a walk whose pages left nothing out", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": prefixRoute(["/app/a"]).handler });
    renderBrowser(ETCD_SCAN);
    await waitFor(() => {
      expect(rows()).toEqual(["/*@0"]);
    });

    expect(screen.queryByTestId("key-browser-skipped")).toBeNull();
  });

  test("gives Redis's own root row a name its twisty announces, and finds a key by its leading colon", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": page([":foo", "bar"], "0", 2) });
    renderBrowser();
    await waitFor(() => {
      expect(rows()).toEqual([":*@0", "bar@0"]);
    });
    const root = rowLabelled(":*") as HTMLElement;
    expect(root.getAttribute("title")).toBe(":*");
    expect(within(root).getByTestId("key-browser-twisty").getAttribute("aria-label")).toBe("Expand :");

    fireEvent.change(screen.getByLabelText("Filter the keys found"), { target: { value: ":foo" } });
    expect(rows()).toEqual([":*@0", ":foo@1"]);
  });
});

/**
 * The panel of an engine that lists its key space ONE LEVEL AT A TIME (Keys panel levels, spec 3.6): the
 * server names each level's folders, a folder is listed on the reader's first expand, and every level,
 * the panel's own included, pages with its own row and its own cursor.
 */
describe("a panel listed one level at a time", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  const LEVEL_SCAN: KeyScanCapability = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "none",
    levels: { rootKind: "bucket" },
  };

  /** `a/` holds 5,000 keys in fifty subfolders; `z/` sorts after all of them and must be drawn at once. */
  const SPACE = [...Array.from({ length: 5_000 }, (_, index) => `a/${index % 50}/${index}.csv`), "top.txt", "z/readme"];

  /**
   * An in-memory key space that answers a LEVEL body as an object store does: the keys directly under
   * the pattern and the folder prefixes one `/` deeper, merged in byte order, `pageSize` entries a page
   * (never more than the body's `count`), with cursor `"i:<n>"` or `"0"`. A body without `level` is
   * answered as the etcd-shaped double above answers it. Every body is kept, in order.
   */
  function levelRoute(keys: readonly string[], pageSize: number) {
    const seen: Array<Record<string, unknown>> = [];
    const handler = async (req: Request): Promise<MockFetchResponse> => {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push(body);
      const prefix = typeof body.pattern === "string" ? body.pattern : "";
      const under = keys.filter((key) => key.startsWith(prefix));
      if (body.level !== true) return { json: { keys: under, cursor: "0", total: under.length, types: {} } };
      const entries = new Map<string, "key" | "prefix">();
      for (const key of under) {
        const cut = key.indexOf("/", prefix.length);
        if (cut < 0) entries.set(key, "key");
        else entries.set(key.slice(0, cut + 1), "prefix");
      }
      const sorted = [...entries.keys()].sort();
      const from = typeof body.cursor === "string" && body.cursor.startsWith("i:") ? Number(body.cursor.slice(2)) : 0;
      const slice = sorted.slice(from, from + Math.min(pageSize, Number(body.count)));
      const end = from + slice.length;
      return {
        json: {
          keys: slice.filter((name) => entries.get(name) === "key"),
          prefixes: slice.filter((name) => entries.get(name) === "prefix"),
          cursor: end >= sorted.length ? "0" : `i:${end}`,
          total: 0,
          types: {},
        },
      };
    };
    return { handler, seen };
  }

  function renderLevels(request?: KeyPatternRequest, onOpenKey?: (key: string, type: string | null) => void) {
    return render(
      <KeyBrowser connection={CONNECTION} capability={LEVEL_SCAN} request={request} onOpenKey={onOpenKey} />,
    );
  }

  /** The row labelled `label`, at `depth` when one is named; a missing row fails the test by name. */
  function rowLabelled(label: string, depth?: number): HTMLElement {
    const row = screen.queryAllByRole("treeitem").find((candidate) => {
      const text = candidate.querySelector("span.truncate")?.textContent;
      const at = (Number.parseInt(candidate.style.paddingLeft, 10) - 8) / 12;
      return text === label && (depth === undefined || at === depth);
    });
    if (row === undefined) throw new Error(`no row labelled ${JSON.stringify(label)}`);
    return row;
  }

  const twisty = (label: string): HTMLElement => within(rowLabelled(label)).getByTestId("key-browser-twisty");
  const badgeCell = (label: string): HTMLElement => within(rowLabelled(label)).getByTestId("key-browser-folder-count");
  const badge = (label: string): string => badgeCell(label).textContent ?? "";
  const loadMoreRows = (): HTMLElement[] => screen.queryAllByTestId("key-browser-load-more");

  test("draws a later sibling folder on the first page, folders before keys, none listed yet", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();

    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    });
    expect(route.seen).toHaveLength(1);
    expect(route.seen[0]).toMatchObject({ cursor: "0", count: 500, level: true });
    expect("pattern" in route.seen[0]).toBe(false);
    expect(badge("a/")).toBe("");
    expect(badgeCell("a/").getAttribute("title")).toBe("Not listed yet: open the folder to list it");
    // The top level came back complete, so it offers no row of its own.
    expect(loadMoreRows()).toEqual([]);
  });

  test("lists a folder once, on the reader's first expand, and not again when it is reopened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });

    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });
    expect(route.seen.filter((body) => body.pattern === "a/")).toEqual([
      expect.objectContaining({ cursor: "0", pattern: "a/", count: 1000, level: true }),
    ]);

    fireEvent.click(twisty("a/"));
    expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    fireEvent.click(twisty("a/"));
    expect(rows()).toContain("0/@1");
    expect(route.seen.filter((body) => body.pattern === "a/")).toHaveLength(1);
  });

  test("pages a folder's level with its own cursor, and drops its row and its + when the level is spent", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(badge("a/")).toBe("20+");
    });
    expect(badgeCell("a/").getAttribute("title")).toBe("20 entries listed in this folder; more pages remain");
    expect(loadMoreRows()).toHaveLength(1);

    fireEvent.click(loadMoreRows()[0]);
    await waitFor(() => {
      expect(badge("a/")).toBe("40+");
    });
    expect(route.seen.filter((body) => body.pattern === "a/")[1]).toMatchObject({ cursor: "i:20", level: true });

    fireEvent.click(loadMoreRows()[0]);
    await waitFor(() => {
      expect(badge("a/")).toBe("50");
    });
    expect(route.seen.filter((body) => body.pattern === "a/")[2]).toMatchObject({ cursor: "i:40", level: true });
    expect(loadMoreRows()).toEqual([]);
    expect(badgeCell("a/").getAttribute("title")).toBe("50 entries listed in this folder");
  });

  test("gives the top level its own row at depth 0, which pages the panel's own walk", async () => {
    const route = levelRoute(["a/x", "b/y", "c.txt"], 2);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "b/@0"]);
    });

    const [more] = loadMoreRows();
    expect(more.style.paddingLeft).toBe("8px");
    fireEvent.click(more);
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "b/@0", "c.txt@0"]);
    });
    // The panel's own walk: its cursor and its batch, with no pattern, and not a listing of `/`.
    expect(route.seen[1]).toMatchObject({ cursor: "i:2", count: 500, level: true });
    expect("pattern" in route.seen[1]).toBe(false);
    expect(loadMoreRows()).toEqual([]);
  });

  test("opens a handed-over prefix with its folder open and its level's row under it", async () => {
    const route = levelRoute(["sales/2026/x", "sales/a.csv", "sales/b.csv", "logs/z"], 2);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels({ pattern: "sales/" });

    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/a.csv@1"]);
    });
    expect(route.seen[0]).toMatchObject({ cursor: "0", pattern: "sales/", level: true });
    const [more] = loadMoreRows();
    expect(more.style.paddingLeft).toBe("20px");

    fireEvent.click(more);
    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/a.csv@1", "sales/b.csv@1"]);
    });
    // The scope's row continues the panel's walk (its cursor, its batch), not a listing of `sales/` from "0".
    expect(route.seen[1]).toMatchObject({ cursor: "i:2", pattern: "sales/", count: 500, level: true });
  });

  test("a filter draws no load-more rows and lists none of the folders it opens", async () => {
    const route = levelRoute(["a/x", "ab/y", "readme", "z/q"], 3);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "ab/@0", "readme@0"]);
    });
    expect(loadMoreRows()).toHaveLength(1);

    fireEvent.change(screen.getByPlaceholderText(/^Filter the/), { target: { value: "a" } });

    expect(loadMoreRows()).toEqual([]);
    expect(route.seen).toHaveLength(1);
  });

  test("hands a key row's full name to the shell, as today", async () => {
    const opened: string[] = [];
    mockGlobalFetch({ "/api/db/keys/scan": levelRoute(["a/x", "readme"], 20).handler });
    renderLevels(undefined, (key) => opened.push(key));
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "readme@0"]);
    });

    fireEvent.click(rowLabelled("readme"));

    expect(opened).toEqual(["readme"]);
  });

  test("a refresh lists the level again, closes a listed folder, and lists it again only when reopened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });
    const before = route.seen.length;

    fireEvent.click(screen.getByTestId("key-browser-refresh"));
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    });
    expect(route.seen.slice(before)).toEqual([expect.objectContaining({ cursor: "0", level: true })]);
    expect("pattern" in route.seen[before]).toBe(false);
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");

    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });
    expect(route.seen.slice(before + 1)).toEqual([expect.objectContaining({ cursor: "0", pattern: "a/" })]);
  });

  test("a second expand while the first listing is in flight sends no second request", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const route = levelRoute(SPACE, 20);
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.clone().json()) as Record<string, unknown>;
        if (body.pattern === "a/") await gate;
        return route.handler(req);
      },
    });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });

    // Open, close and open again while the first listing of `a/` is still on the wire.
    fireEvent.click(twisty("a/"));
    fireEvent.click(twisty("a/"));
    fireEvent.click(twisty("a/"));
    release();
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });

    expect(walksOf(fetchMock).filter((body) => body.pattern === "a/")).toHaveLength(1);
  });

  test("a second handover replaces the open folders and lists only the new prefix", async () => {
    const route = levelRoute(["sales/2026/x", "sales/a.csv", "logs/app/1.log", "logs/b.log"], 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    const view = renderLevels({ pattern: "sales/" });
    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/a.csv@1"]);
    });
    fireEvent.click(twisty("2026/"));
    await waitFor(() => {
      expect(rows()).toContain("sales/2026/x@2");
    });
    const before = route.seen.length;

    view.rerender(<KeyBrowser connection={CONNECTION} capability={LEVEL_SCAN} request={{ pattern: "logs/" }} />);

    await waitFor(() => {
      expect(rows()).toEqual(["logs/@0", "app/@1", "logs/b.log@1"]);
    });
    expect(route.seen.slice(before).map((body) => body.pattern)).toEqual(["logs/"]);
    expect(rows().some((row) => row.startsWith("sales"))).toBe(false);
  });

  test("a prefix that ends mid-segment lists its level under its folders, its row one level under them", async () => {
    const route = levelRoute(
      ["sales/2026/orders.csv", "sales/2026/ord-archive/x", "sales/2026/ord-b.csv", "sales/2026/q.csv"],
      2,
    );
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels({ pattern: "sales/2026/ord" });

    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "ord-archive/@2", "sales/2026/ord-b.csv@2"]);
    });
    const [more] = loadMoreRows();
    expect(more.style.paddingLeft).toBe("32px");

    fireEvent.click(more);
    await waitFor(() => {
      expect(rows()).toContain("sales/2026/orders.csv@2");
    });
    expect(route.seen[1]).toMatchObject({ cursor: "i:2", pattern: "sales/2026/ord", count: 500, level: true });
    expect(rows()).not.toContain("sales/2026/q.csv@2");
  });

  test("a folder marker equal to the handed-over prefix is a key row inside its folder", async () => {
    const opened: string[] = [];
    mockGlobalFetch({
      "/api/db/keys/scan": {
        json: { keys: ["sales/", "sales/a.csv"], prefixes: [], cursor: "0", total: 0, types: { "sales/": "0 B" } },
      },
    });
    renderLevels({ pattern: "sales/" }, (key) => opened.push(key));

    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "sales/@1", "sales/a.csv@1"]);
    });
    const marker = rowLabelled("sales/", 1);
    // Drawn, never hidden, with the descriptor its page carried in the type cell.
    expect(within(marker).getByTestId("key-browser-type").textContent).toBe("0 B");

    fireEvent.click(marker);

    expect(opened).toEqual(["sales/"]);
  });

  test("an unlisted server folder's tooltip claims no row count, and a listed one counts its level's rows", async () => {
    const route = levelRoute(["a/x", "a/y", "z/q"], 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0"]);
    });

    // Nothing under `z/` has been listed, so a sentence counting its rows would claim an empty folder.
    const unlisted = badgeCell("z/").getAttribute("title") ?? "";
    expect(unlisted).toBe("Not listed yet: open the folder to list it");
    expect(unlisted).not.toMatch(/\brows?\b/);

    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(badge("a/")).toBe("2");
    });
    expect(badgeCell("a/").getAttribute("title")).toBe("2 entries listed in this folder");
  });

  const ETCD_LIKE: KeyScanCapability = {
    defaultCount: 500,
    maxCount: 1000,
    separator: "/",
    cursor: "opaque",
    pattern: "prefix",
    totalScope: "walk",
  };
  const OXIA_LIKE: KeyScanCapability = { ...ETCD_LIKE, totalScope: "none" };

  /** Text that only a level panel draws (Keys panel levels, spec 3.6); today's panel must carry none of it. */
  const LEVEL_TEXT = [
    "Listed ",
    "List more",
    "List all of this level",
    "Load more of this folder",
    "Listing this folder",
    "entries listed",
    "entry listed",
    "Nothing is listed",
    "keys and folders",
  ];

  /** Open every folder the panel draws, one twisty at a time, bounded so a stuck twisty fails the test. */
  function openEveryFolder(): void {
    for (let pass = 0; pass < 100; pass += 1) {
      const closed = screen
        .queryAllByTestId("key-browser-twisty")
        .find((candidate) => candidate.getAttribute("aria-label")?.startsWith("Expand "));
      if (closed === undefined) return;
      fireEvent.click(closed);
    }
    throw new Error("a folder of the key tree did not open");
  }

  test("draws none of the level wording, and no top-level row, for Redis, etcd and Oxia", async () => {
    const shapes: ReadonlyArray<{ readonly capability: KeyScanCapability; readonly keys: string[] }> = [
      { capability: CAPABILITY, keys: ["app:cache:user:1", "app:cache:user:2", "app:env", "queue:jobs:1"] },
      { capability: ETCD_LIKE, keys: ["/apisix/routes/1", "/apisix/routes/2", "/app/cfg", "k3s/x/y"] },
      { capability: OXIA_LIKE, keys: ["/apisix/routes/1", "/apisix/routes/2", "/app/cfg", "k3s/x/y"] },
    ];
    for (const { capability, keys } of shapes) {
      mockGlobalFetch({ "/api/db/keys/scan": page(keys, "7", keys.length) });
      const view = render(<KeyBrowser connection={CONNECTION} capability={capability} />);
      // oxlint-disable-next-line no-await-in-loop -- one declaration at a time: each owns the global fetch mock.
      await waitFor(() => {
        expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0);
      });

      openEveryFolder();

      const text = view.container.textContent ?? "";
      for (const phrase of LEVEL_TEXT)
        expect({ phrase, found: text.includes(phrase) }).toEqual({ phrase, found: false });
      // Folders offer today's rows, and none of them sits at the top level.
      expect(loadMoreRows().length).toBeGreaterThan(0);
      expect(loadMoreRows().some((row) => row.style.paddingLeft === "8px")).toBe(false);
      view.unmount();
      restoreGlobalFetch();
    }
  });

  test("reads the level wording on the progress line, the buttons, the boxes and the refresh", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": levelRoute(["a/x", "readme"], 20).handler });
    const view = renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "readme@0"]);
    });

    expect(progress()).toBe("Listed 2");
    expect(screen.getByTestId("key-browser-progress").getAttribute("title")).toBe(
      "Folders and keys of this level listed so far: this engine lists one folder at a time and publishes no count, so no total is shown",
    );
    expect(screen.getByText("List more")).toBeDefined();
    expect(screen.getByText("List all of this level")).toBeDefined();
    const box = screen.getByLabelText("Key prefix") as HTMLInputElement;
    expect(box.placeholder).toBe("Prefix, e.g. app/config/");
    expect(box.title).toBe(
      "Lists the folders and keys directly under exactly this text. A * is part of the prefix, except in a trailing /*, which is read as the folder it names.",
    );
    const refresh = screen.getByTestId("key-browser-refresh");
    expect(refresh.getAttribute("aria-label")).toBe("List this prefix again");
    expect(refresh.getAttribute("title")).toBe("List this prefix again");
    const filter = screen.getByLabelText("Filter the folders and keys listed") as HTMLInputElement;
    expect(filter.placeholder).toBe("Filter the folders and keys listed");
    expect(filter.title).toBe(
      "Narrows the folders and keys already listed, without asking the server. Matches any part of a full name, or one of its `/`-separated segments.",
    );
    view.unmount();
    restoreGlobalFetch();

    // Today's words, on every engine without levels, and no filter box while nothing is held.
    for (const capability of [CAPABILITY, ETCD_LIKE, OXIA_LIKE]) {
      mockGlobalFetch({ "/api/db/keys/scan": page(["a/x", "a:y"], "7", 2) });
      const today = render(<KeyBrowser connection={CONNECTION} capability={capability} />);
      // oxlint-disable-next-line no-await-in-loop -- one declaration at a time: each owns the global fetch mock.
      await waitFor(() => {
        expect(screen.queryAllByRole("treeitem").length).toBeGreaterThan(0);
      });
      expect(screen.getByText("Scan more")).toBeDefined();
      expect(screen.getByText("Scan all")).toBeDefined();
      expect(screen.getByLabelText("Filter the keys found")).toBeDefined();
      expect(screen.queryByText("List more")).toBeNull();
      expect(screen.queryByText("List all of this level")).toBeNull();
      expect(screen.queryByLabelText("Filter the folders and keys listed")).toBeNull();
      today.unmount();
      restoreGlobalFetch();

      mockGlobalFetch({ "/api/db/keys/scan": page([], "0", 0) });
      const empty = render(<KeyBrowser connection={CONNECTION} capability={capability} />);
      // oxlint-disable-next-line no-await-in-loop -- one declaration at a time: each owns the global fetch mock.
      await waitFor(() => {
        expect(screen.getByTestId("key-browser-empty").textContent).toBe(
          "This database holds no keys the walk has seen",
        );
      });
      expect(screen.queryByLabelText("Filter the keys found")).toBeNull();
      empty.unmount();
      restoreGlobalFetch();
    }
  });

  test("words a folder's load-more row by its folder, while it asks and after, and counts it in entries", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.clone().json()) as Record<string, unknown>;
        if (body.cursor === "i:20") await gate;
        return route.handler(req);
      },
    });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(loadMoreRows()[0]?.textContent).toContain("Load more of this folder");
    });
    const [more] = loadMoreRows();
    expect(more.getAttribute("title")).toBe(
      "Ask the server for the next page of this folder. A page lists folders and keys of this level only, and each folder lists its own level when opened.",
    );
    expect(within(more).getByTestId("key-browser-load-more-count").textContent).toBe("20 entries listed");

    fireEvent.click(more);
    await waitFor(() => {
      expect(loadMoreRows()[0]?.textContent).toContain("Listing this folder...");
    });
    release();
    await waitFor(() => {
      expect(loadMoreRows()[0]?.textContent).toContain("Load more of this folder · +20 new");
    });
  });

  test("counts a load-more row of one listed entry in the singular", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": levelRoute(["b/1", "b/2"], 1).handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["b/@0"]);
    });
    fireEvent.click(twisty("b/"));
    await waitFor(() => {
      expect(screen.queryByTestId("key-browser-load-more-count")?.textContent).toBe("1 entry listed");
    });
  });

  test("says the held limit and the empty level in the level wording", async () => {
    // 9,999 keys and 2 folders: the folders go in first and the keys stop at ten thousand entries.
    mockGlobalFetch({
      "/api/db/keys/scan": {
        json: {
          keys: Array.from({ length: HELD_KEY_LIMIT - 1 }, (_, index) => `bulk/${index % 3}/${index}`),
          prefixes: ["a/", "b/"],
          cursor: "c1",
          total: 0,
          types: {},
        },
      },
    });
    const held = renderLevels();
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-held").textContent).toBe(
        "Holding 10,000 keys and folders, which is this panel's limit. Narrow the prefix to list a smaller part of the key space.",
      );
    });
    expect((screen.getByText("List more") as HTMLButtonElement).disabled).toBe(true);
    expect(progress()).toBe("Listed 10000");
    held.unmount();
    restoreGlobalFetch();

    mockGlobalFetch({ "/api/db/keys/scan": levelRoute([], 20).handler });
    const top = renderLevels();
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-empty").textContent).toBe("Nothing is listed at the top level");
    });
    top.unmount();
    restoreGlobalFetch();

    mockGlobalFetch({ "/api/db/keys/scan": levelRoute(["logs/a"], 20).handler });
    renderLevels({ pattern: "sales/" });
    await waitFor(() => {
      expect(screen.getByTestId("key-browser-empty").textContent).toBe("Nothing is listed under sales/");
    });
  });

  test("draws the filter box for a level of folders alone, and the filter keeps a folder by its own name", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": levelRoute(["a/1", "b/1", "c/1"], 20).handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "b/@0", "c/@0"]);
    });

    fireEvent.change(screen.getByLabelText("Filter the folders and keys listed"), { target: { value: "b" } });

    expect(rows()).toEqual(["b/@0"]);
  });

  test("disables List more and List all of this level once keys plus folders reach the held limit", async () => {
    mockGlobalFetch({
      "/api/db/keys/scan": {
        json: {
          keys: Array.from({ length: HELD_KEY_LIMIT - 2 }, (_, index) => `k${index}`),
          prefixes: ["a/", "b/"],
          cursor: "c1",
          total: 0,
          types: {},
        },
      },
    });
    renderLevels();
    await waitFor(() => {
      expect(screen.queryByTestId("key-browser-held")).not.toBeNull();
    });

    expect((screen.getByText("List more") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("List all of this level") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a folder above a handed-over prefix claims no listing, and opening it after a close lists its level", async () => {
    const route = levelRoute(["sales/2026/orders.csv", "sales/2026/ord-b.csv", "sales/a.csv", "sales/b/x"], 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels({ pattern: "sales/2026/ord" });
    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/2026/ord-b.csv@2", "sales/2026/orders.csv@2"]);
    });

    // Only `2026/`'s ord entries were asked for, so `sales/` holds one row nobody listed it for. It is
    // drawn open already, so the way to list it is to close it and open it again.
    expect(badge("sales/")).toBe("");
    expect(badgeCell("sales/").getAttribute("title")).toBe("Not listed yet: close and reopen the folder to list it");

    fireEvent.click(twisty("sales/"));
    // A request the click fired would land a tick later, so the tick is waited for before asserting none.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(route.seen.filter((body) => body.pattern === "sales/")).toEqual([]);
    expect(badgeCell("sales/").getAttribute("title")).toBe("Not listed yet: open the folder to list it");
    fireEvent.click(twisty("sales/"));
    await waitFor(() => {
      expect(rows()).toContain("sales/a.csv@1");
    });
    expect(route.seen.filter((body) => body.pattern === "sales/")).toEqual([
      expect.objectContaining({ cursor: "0", pattern: "sales/", level: true }),
    ]);
    expect(rows()).toContain("b/@1");
    expect(badge("sales/")).toBe("3");
    expect(badgeCell("sales/").getAttribute("title")).toBe("3 entries listed in this folder");
  });

  test("a listed folder above the prefix pages its own level from its own row", async () => {
    const route = levelRoute(["sales/2026/ord.csv", "sales/a.csv", "sales/b.csv", "sales/c.csv"], 2);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels({ pattern: "sales/2026/ord" });
    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/2026/ord.csv@2"]);
    });
    // Unlisted, so no row of its own yet.
    expect(loadMoreRows()).toEqual([]);

    fireEvent.click(twisty("sales/"));
    fireEvent.click(twisty("sales/"));
    await waitFor(() => {
      expect(badge("sales/")).toBe("2+");
    });
    expect(loadMoreRows()).toHaveLength(1);

    fireEvent.click(loadMoreRows()[0]);
    await waitFor(() => {
      expect(rows()).toContain("sales/b.csv@1");
    });
    expect(route.seen.filter((body) => body.pattern === "sales/")[1]).toMatchObject({ cursor: "i:2", level: true });
  });

  test("the scope row stays the walk's own level after its parent lists it as a folder", async () => {
    const route = levelRoute(["sales/2026/ord.csv", "sales/2026/q.csv", "sales/a.csv"], 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels({ pattern: "sales/2026/ord" });
    await waitFor(() => {
      expect(rows()).toEqual(["sales/@0", "2026/@1", "sales/2026/ord.csv@2"]);
    });
    // Listing `sales/` names `2026/` among its folders.
    fireEvent.click(twisty("sales/"));
    fireEvent.click(twisty("sales/"));
    await waitFor(() => {
      expect(rows()).toContain("sales/a.csv@1");
    });

    fireEvent.click(twisty("2026/"));
    fireEvent.click(twisty("2026/"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The typed prefix is the question: `2026/`'s whole level lies outside it and is never asked for.
    expect(route.seen.filter((body) => body.pattern === "sales/2026/")).toEqual([]);
    expect(rows()).not.toContain("sales/2026/q.csv@2");
  });

  test("switching to another connection closes the folders the last walk opened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    const view = renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });
    const before = route.seen.length;

    view.rerender(<KeyBrowser connection={{ ...CONNECTION, id: "s3-2" }} capability={LEVEL_SCAN} />);

    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
    expect(route.seen.slice(before).map((body) => body.pattern)).toEqual([undefined]);
  });

  test("a rebuilt connection and capability with the same content close the folders the last walk opened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    const view = renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });
    const before = route.seen.length;

    // New objects with the same content: the walk keys on the objects, so it restarts and drops every
    // folder's listing, and a folder left open would draw open with nothing listed under it.
    view.rerender(<KeyBrowser connection={{ ...CONNECTION }} capability={{ ...LEVEL_SCAN }} />);

    await waitFor(() => {
      expect(route.seen.length).toBe(before + 1);
    });
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    });
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
  });

  test("a level connection reached again through an engine without levels closes the folders it opened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    const view = renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });

    view.rerender(<KeyBrowser connection={{ ...CONNECTION, id: "etcd-2" }} capability={ETCD_LIKE} />);
    await waitFor(() => {
      expect(route.seen.at(-1)).not.toHaveProperty("level");
    });
    const before = route.seen.length;
    view.rerender(<KeyBrowser connection={CONNECTION} capability={LEVEL_SCAN} />);

    await waitFor(() => {
      expect(route.seen.length).toBe(before + 1);
    });
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "z/@0", "top.txt@0"]);
    });
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
  });

  test("a panel moved from a level walk to Redis draws the Redis walk and none of the old folders", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const body = (await req.clone().json()) as Record<string, unknown>;
        if (body.level !== true) return page(["app:env", "app:cache:ttl"], "0", 2);
        return route.handler(req);
      },
    });
    const view = renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });

    // Another separator: a folder of the last walk is no prefix in this shape, so a tree built from it
    // on the first render of the new question would throw.
    view.rerender(<KeyBrowser connection={{ ...CONNECTION, id: "redis-2" }} capability={CAPABILITY} />);

    await waitFor(() => {
      expect(rows()).toEqual(["app:*@0"]);
    });
  });

  test("an unlisted folder's twisty at the held limit leaves it closed and asks for nothing", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": {
        json: {
          keys: Array.from({ length: HELD_KEY_LIMIT - 2 }, (_, index) => `k${index}`),
          prefixes: ["a/", "b/"],
          cursor: "c1",
          total: 0,
          types: {},
        },
      },
    });
    renderLevels();
    await waitFor(() => {
      expect(screen.queryByTestId("key-browser-held")).not.toBeNull();
    });
    const before = fetchMock.mock.calls.length;

    fireEvent.click(twisty("a/"));
    // A request the click fired would land a tick later, so the tick is waited for before asserting none.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(badgeCell("a/").getAttribute("title")).toBe("Not listed yet: open the folder to list it");
  });

  test("an unlisted folder's twisty under a filter leaves it closed once the filter is cleared", async () => {
    const route = levelRoute(["a/x", "ab/y", "readme", "z/q"], 3);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toEqual(["a/@0", "ab/@0", "readme@0"]);
    });
    const filter = screen.getByLabelText("Filter the folders and keys listed");

    fireEvent.change(filter, { target: { value: "a" } });
    fireEvent.click(twisty("a/"));
    fireEvent.change(filter, { target: { value: "" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(route.seen).toHaveLength(1);
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
    expect(badgeCell("a/").getAttribute("title")).toBe("Not listed yet: open the folder to list it");
    // Only the top level's own row: the folder offers none until it is listed.
    expect(loadMoreRows().map((row) => row.style.paddingLeft)).toEqual(["8px"]);
  });

  test("a twisty pressed under a filter still opens the folder for Redis, etcd and Oxia, asking for nothing", async () => {
    const shapes: ReadonlyArray<{
      readonly capability: KeyScanCapability;
      readonly keys: string[];
      readonly folder: string;
    }> = [
      { capability: CAPABILITY, keys: ["app:cache:ttl", "app:env"], folder: "app:*" },
      { capability: ETCD_LIKE, keys: ["app/cfg", "app/env"], folder: "app/*" },
      { capability: OXIA_LIKE, keys: ["app/cfg", "app/env"], folder: "app/*" },
    ];
    for (const { capability, keys, folder } of shapes) {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(keys, "7", keys.length) });
      const view = render(<KeyBrowser connection={CONNECTION} capability={capability} />);
      // oxlint-disable-next-line no-await-in-loop -- one declaration at a time: each owns the global fetch mock.
      await waitFor(() => {
        expect(rows()).toEqual([`${folder}@0`]);
      });
      const before = fetchMock.mock.calls.length;
      const filter = screen.getByLabelText("Filter the keys found");

      fireEvent.change(filter, { target: { value: "app" } });
      fireEvent.click(twisty(folder));
      fireEvent.change(filter, { target: { value: "" } });

      expect(twisty(folder).getAttribute("aria-label")).toMatch(/^Collapse /);
      expect(fetchMock.mock.calls.length).toBe(before);
      view.unmount();
      restoreGlobalFetch();
    }
  });

  test("typing in the prefix box asks a new question and closes the folders the last one opened", async () => {
    const route = levelRoute(SPACE, 20);
    mockGlobalFetch({ "/api/db/keys/scan": route.handler });
    renderLevels();
    await waitFor(() => {
      expect(rows()).toContain("a/@0");
    });
    fireEvent.click(twisty("a/"));
    await waitFor(() => {
      expect(rows()).toContain("0/@1");
    });

    fireEvent.change(screen.getByLabelText("Key prefix"), { target: { value: "a" } });

    await waitFor(() => {
      expect(rows()).toEqual(["a/@0"]);
    });
    expect(twisty("a/").getAttribute("aria-label")).toBe("Expand a");
    expect(route.seen.filter((body) => body.pattern === "a/")).toHaveLength(1);
  });
});

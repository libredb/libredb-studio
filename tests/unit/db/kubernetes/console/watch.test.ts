/**
 * `get -w`: the listed rows, then one bounded watch from the list's resourceVersion; BOOKMARK never printed; an
 * in-band ERROR ends the window with a sentence and sends nothing again; the byte and row caps; the window's length;
 * and a planted Secret marker absent from every cell.
 */
import { describe, expect, test } from "bun:test";
import { TransportError } from "@/lib/db/http/node-transport";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import {
  getWatch,
  WATCH_BYTES_SENTENCE,
  WATCH_LIST_CAP_SENTENCE,
  WATCH_ROWS_SENTENCE,
} from "@/lib/db/providers/platform/kubernetes/console/watch";
import { STATEMENT_DEADLINE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/console/context";
import {
  CONSOLE_NOW,
  consoleContext,
  listAnswer,
  markerSecret,
  routes,
  SECRET_MARKER,
  sentLines,
  tableAnswer,
  textAnswer,
} from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

type Get = Extract<KubectlStatement, { readonly command: "get" }>;

function get(text: string): Get {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "get") throw new Error(`not a get: ${text}`);
  return parsed.statement;
}

const COLUMNS = [{ name: "Name" }, { name: "Status" }];
const LIST = "GET /api/v1/namespaces/shop/pods?limit=500&includeObject=None";
const WATCH =
  "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=10&includeObject=None";

/**
 * One Table event as the API server sends it: the column definitions on the window's first event only, null on
 * every later one (the shape of a captured watch of a k3s 1.33 server).
 */
const tableEvent = (type: string, name: string, status: string, first = false) =>
  JSON.stringify({
    type,
    object: {
      kind: "Table",
      apiVersion: "meta.k8s.io/v1",
      metadata: { resourceVersion: "101" },
      columnDefinitions: first
        ? COLUMNS.map((column) => ({ ...column, type: "string", format: "", priority: 0 }))
        : null,
      rows: [{ cells: [name, status] }],
    },
  });

const bookmark = JSON.stringify({ type: "BOOKMARK", object: { kind: "Pod", metadata: { resourceVersion: "120" } } });

function watching(lines: readonly string[]) {
  return routes({
    [LIST]: tableAnswer(COLUMNS, [{ cells: ["web", "Running"] }]),
    [WATCH]: textAnswer(`${lines.join("\n")}\n`),
  });
}

describe("the window", () => {
  test("a quiet window shows the listed rows and no BOOKMARK row", async () => {
    const { context, transport } = consoleContext(watching([bookmark]));
    const grid = await getWatch(context, get("kubectl get pods -w"));
    expect(sentLines(transport)).toEqual([LIST, WATCH]);
    expect(grid.fields).toEqual(["EVENT", "Name", "Status"]);
    expect(grid.rows).toEqual([{ EVENT: null, Name: "web", Status: "Running" }]);
    expect(transport.requests.at(-1)?.maxResponseBytes).toBe(8 * 1024 * 1024);
  });

  test("the window's events follow the listed rows, each under its type", async () => {
    const { context } = consoleContext(
      watching([
        tableEvent("ADDED", "api", "Pending", true),
        bookmark,
        tableEvent("MODIFIED", "api", "Running"),
        tableEvent("DELETED", "web", "Terminating"),
      ]),
    );
    expect((await getWatch(context, get("get pods -w"))).rows).toEqual([
      { EVENT: null, Name: "web", Status: "Running" },
      { EVENT: "ADDED", Name: "api", Status: "Pending" },
      { EVENT: "MODIFIED", Name: "api", Status: "Running" },
      { EVENT: "DELETED", Name: "web", Status: "Terminating" },
    ]);
  });

  test("a later event with no column definitions at all reads its cells against the list's columns", async () => {
    const bare = JSON.stringify({ type: "MODIFIED", object: { kind: "Table", rows: [{ cells: ["web", "Failed"] }] } });
    const { context } = consoleContext(watching([bare]));
    expect((await getWatch(context, get("get pods -w"))).rows[1]).toEqual({
      EVENT: "MODIFIED",
      Name: "web",
      Status: "Failed",
    });
  });

  test("an event whose object is not a Table fills the Name column alone", async () => {
    const plain = JSON.stringify({
      type: "ADDED",
      object: { kind: "Pod", metadata: { name: "raw", creationTimestamp: "t" } },
    });
    const { context } = consoleContext(watching([plain]));
    expect((await getWatch(context, get("get pods -w"))).rows[1]).toEqual({
      EVENT: "ADDED",
      Name: "raw",
      Status: null,
    });
  });

  test("an event that is not a Table, on a list read as names, fills Name and Created", async () => {
    const answer = routes({
      [LIST]: listAnswer([{ metadata: { name: "web", creationTimestamp: "t0" } }]),
      [WATCH]: textAnswer(
        `${JSON.stringify({ type: "ADDED", object: { kind: "Pod", metadata: { name: "raw", creationTimestamp: "t1" } } })}\n`,
      ),
    });
    const { context } = consoleContext(answer);
    expect((await getWatch(context, get("get pods -w"))).rows).toEqual([
      { EVENT: null, Name: "web", Created: "t0" },
      { EVENT: "ADDED", Name: "raw", Created: "t1" },
    ]);
  });

  test("--request-timeout is the window; past the query timeout less 5 s it is refused before anything is sent", async () => {
    const short = routes({
      [LIST]: tableAnswer(COLUMNS, []),
      "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=3&includeObject=None":
        textAnswer(""),
    });
    const { context, transport } = consoleContext(short);
    expect((await getWatch(context, get("get pods -w --request-timeout=3s"))).rows).toEqual([]);
    expect(sentLines(transport)).toHaveLength(2);
    const refused = consoleContext(short, { queryTimeoutMs: 10_000 });
    await expect(getWatch(refused.context, get("get pods -w --request-timeout=6s"))).rejects.toThrow(
      "--request-timeout may be at most 5 s here",
    );
    expect(sentLines(refused.transport)).toEqual([]);
  });

  test("a window of a fraction of a second is sent as whole seconds", async () => {
    const answer = routes({
      [LIST]: tableAnswer(COLUMNS, []),
      "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=2&includeObject=None":
        textAnswer(""),
    });
    const { context, transport } = consoleContext(answer);
    const statement = { ...get("get pods -w"), requestTimeoutSeconds: 2.5 };
    expect((await getWatch(context, statement)).rows).toEqual([]);
    expect(sentLines(transport)).toHaveLength(2);
  });

  test("a list read that used the statement's time shortens the window to the time left less 5 s", async () => {
    let clock = CONSOLE_NOW;
    const answer = routes({
      [LIST]: () => {
        clock += 17_000;
        return tableAnswer(COLUMNS, []);
      },
      "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=8&includeObject=None":
        textAnswer(""),
    });
    const { context, transport } = consoleContext(answer, { now: () => clock });
    expect((await getWatch(context, get("get pods -w"))).rows).toEqual([]);
    expect(sentLines(transport)).toHaveLength(2);
  });

  test("a list read that leaves under 6 s answers the deadline sentence and sends no watch", async () => {
    let clock = CONSOLE_NOW;
    const answer = routes({
      [LIST]: () => {
        clock += 25_000;
        return tableAnswer(COLUMNS, []);
      },
    });
    const { context, transport } = consoleContext(answer, { now: () => clock });
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow(STATEMENT_DEADLINE_SENTENCE);
    expect(sentLines(transport)).toEqual([LIST]);
  });

  test("the default window shortens to the query timeout less 5 s, and a query timeout of 5 s leaves no window", async () => {
    const answer = routes({
      [LIST]: tableAnswer(COLUMNS, []),
      "GET /api/v1/namespaces/shop/pods?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=7&includeObject=None":
        textAnswer(""),
    });
    const { context } = consoleContext(answer, { queryTimeoutMs: 12_000 });
    expect((await getWatch(context, get("get pods -w"))).rows).toEqual([]);
    const none = consoleContext(answer, { queryTimeoutMs: 5_000 });
    await expect(getWatch(none.context, get("get pods -w"))).rejects.toThrow("leaves no room for a watch window");
  });
});

describe("what ends a window with a sentence", () => {
  test.each([
    [410, "Expired", "(code 410, reason Expired)"],
    [500, "InternalError", "(code 500, reason InternalError)"],
  ])(
    "an in-band ERROR %d answers its code and reason, sends nothing again, and never the server's message",
    async (code, reason, words) => {
      const error = JSON.stringify({
        type: "ERROR",
        object: { kind: "Status", status: "Failure", message: "leaked-status-message", reason, code },
      });
      const { context, transport } = consoleContext(watching([tableEvent("ADDED", "api", "Pending", true), error]));
      const failure = await getWatch(context, get("get pods -w")).then(
        () => new Error("expected a sentence"),
        (refusal: Error) => refusal,
      );
      expect(failure.message).toBe(
        `The watch to watch pods in the namespace shop ended with an error event from the API server ${words}; run it again to read from now.`,
      );
      expect(failure.message).not.toContain("leaked-status-message");
      expect(sentLines(transport)).toEqual([LIST, WATCH]);
    },
  );

  test("a window past 8 MiB answers the sentence to narrow it", async () => {
    const answer = routes({
      [LIST]: tableAnswer(COLUMNS, []),
      [WATCH]: () => {
        throw new TransportError("too-large", "x");
      },
    });
    const { context } = consoleContext(answer);
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow(WATCH_BYTES_SENTENCE);
  });

  test("listed rows and window events past 5,000 rows answer the sentence to narrow", async () => {
    const events = Array.from({ length: 5_000 }, (_unused, index) =>
      tableEvent("ADDED", `p${index}`, "Running", index === 0),
    );
    const { context } = consoleContext(watching(events));
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow(WATCH_ROWS_SENTENCE);
    const fits = consoleContext(watching(events.slice(0, 4_999)));
    expect((await getWatch(fits.context, get("get pods -w"))).rows).toHaveLength(5_000);
  });

  test("another failure of the watch passes as it was raised", async () => {
    const answer = routes({
      [LIST]: tableAnswer(COLUMNS, []),
      [WATCH]: () => {
        throw new TransportError("tls", "certificate rejected");
      },
    });
    const { context } = consoleContext(answer);
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow("certificate rejected");
  });

  test("a line that is not JSON answers its sentence", async () => {
    const { context } = consoleContext(watching(["{not json"]));
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow("a line that is not JSON");
  });

  test("a list cut by the 5,000 cap answers its sentence before any watch", async () => {
    const page = (start: number, count: number, next?: string) =>
      tableAnswer(
        COLUMNS,
        Array.from({ length: count }, (_unused, index) => ({ cells: [`p-${start + index}`, "Running"] })),
        next === undefined ? {} : { continue: next },
      );
    const map: Record<string, ReturnType<typeof tableAnswer>> = { [LIST]: page(0, 500, "500") };
    for (let start = 500; start < 5_000; start += 500)
      map[`GET /api/v1/namespaces/shop/pods?limit=500&continue=${start}&includeObject=None`] = page(
        start,
        500,
        String(start + 500),
      );
    map["GET /api/v1/namespaces/shop/pods?limit=1&continue=5000&includeObject=None"] = page(5_000, 1);
    const { context, transport } = consoleContext(routes(map));
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow(WATCH_LIST_CAP_SENTENCE);
    expect(sentLines(transport).some((line) => line.includes("watch=1"))).toBe(false);
  });

  test("a list without a resourceVersion cannot start a window", async () => {
    const answer = routes({
      [LIST]: jsonAnswer({ kind: "Table", metadata: {}, columnDefinitions: [], rows: [] }),
    });
    const { context } = consoleContext(answer);
    await expect(getWatch(context, get("get pods -w"))).rejects.toThrow("listed no resourceVersion");
  });
});

describe("a Secret in a window", () => {
  test("labels from metadata, never a value or the last-applied annotation, in a listed row or an event", async () => {
    const secret = markerSecret();
    const list = "GET /api/v1/namespaces/shop/secrets?limit=500&includeObject=Metadata";
    const watch =
      "GET /api/v1/namespaces/shop/secrets?watch=1&allowWatchBookmarks=true&resourceVersion=100&timeoutSeconds=10&includeObject=Metadata";
    const event = (type: string, columnDefinitions: unknown) =>
      JSON.stringify({
        type,
        object: {
          kind: "Table",
          columnDefinitions,
          rows: [{ cells: ["db"], object: { ...secret, kind: "PartialObjectMetadata" } }],
        },
      });
    const events = [
      event("ADDED", [{ name: "Name", type: "string", format: "", priority: 0 }]),
      event("MODIFIED", null),
    ];
    const answer = routes({
      [list]: tableAnswer(
        [{ name: "Name" }],
        [{ cells: ["db"], object: { kind: "PartialObjectMetadata", metadata: secret.metadata } }],
      ),
      [watch]: textAnswer(`${events.join("\n")}\n`),
    });
    const { context } = consoleContext(answer);
    const grid = await getWatch(context, get("kubectl get secrets -w --show-labels"));
    expect(grid.rows).toEqual([
      { EVENT: null, Name: "db", LABELS: "app=web" },
      { EVENT: "ADDED", Name: "db", LABELS: "app=web" },
      { EVENT: "MODIFIED", Name: "db", LABELS: "app=web" },
    ]);
    expect(JSON.stringify(grid)).not.toContain(SECRET_MARKER);
  });
});

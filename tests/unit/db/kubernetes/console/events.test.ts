/**
 * `kubectl events`: kubectl's time order and columns, -A, --for's escaped selector, --types, the newest 1,000 with
 * a warning, and the sentence past 5,000.
 */
import { describe, expect, test } from "bun:test";
import { EVENTS_CAP_SENTENCE, eventTime, listEvents } from "@/lib/db/providers/platform/kubernetes/console/events";
import { type KubectlStatement, parseKubectl } from "@/lib/db/providers/platform/kubernetes/console/parse";
import { consoleContext, listAnswer, routes, sentLines } from "../../../../helpers/kubernetes-console";
import { jsonAnswer } from "../../../../helpers/kubernetes-transport";

type Events = Extract<KubectlStatement, { readonly command: "events" }>;

function events(text: string): Events {
  const parsed = parseKubectl(text);
  if (!parsed.ok || parsed.statement.command !== "events") throw new Error(`not events: ${text}`);
  return parsed.statement;
}

const event = (name: string, last: string, extra: Record<string, unknown> = {}) => ({
  metadata: { name: `${name}.1`, namespace: "shop" },
  involvedObject: { kind: "Pod", name, namespace: "shop" },
  type: "Normal",
  reason: "Pulled",
  message: ` image pulled for ${name} `,
  firstTimestamp: last,
  lastTimestamp: last,
  count: 1,
  ...extra,
});

describe("events", () => {
  test("sorted oldest first by kubectl's event time, in kubectl's columns", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/events?limit=500": listAnswer([
        event("b", "2026-10-10T11:55:00Z"),
        event("a", "2026-10-10T11:50:00Z", {
          count: 3,
          firstTimestamp: "2026-10-10T10:00:00Z",
          type: "Warning",
          reason: "BackOff",
        }),
        event("c", "", { lastTimestamp: null, eventTime: "2026-10-10T11:58:00.000000Z" }),
        event("d", "", {
          lastTimestamp: null,
          series: { count: 4, lastObservedTime: "2026-10-10T11:59:30.000000Z" },
          eventTime: "2026-10-10T11:00:00.000000Z",
        }),
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await listEvents(context, events("kubectl events"));
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/events?limit=500"]);
    expect(grid.fields).toEqual(["LAST SEEN", "TYPE", "REASON", "OBJECT", "MESSAGE"]);
    expect(grid.rows).toEqual([
      {
        "LAST SEEN": "10m (x3 over 120m)",
        TYPE: "Warning",
        REASON: "BackOff",
        OBJECT: "pod/a",
        MESSAGE: "image pulled for a",
      },
      { "LAST SEEN": "5m", TYPE: "Normal", REASON: "Pulled", OBJECT: "pod/b", MESSAGE: "image pulled for b" },
      { "LAST SEEN": "2m", TYPE: "Normal", REASON: "Pulled", OBJECT: "pod/c", MESSAGE: "image pulled for c" },
      {
        "LAST SEEN": "30s (x4 over 60m)",
        TYPE: "Normal",
        REASON: "Pulled",
        OBJECT: "pod/d",
        MESSAGE: "image pulled for d",
      },
    ]);
  });

  test("-A reads every namespace and adds NAMESPACE first; --types filters without case", async () => {
    const answer = routes({
      "GET /api/v1/events?limit=500&fieldSelector=type%3DWarning": listAnswer([
        event("a", "2026-10-10T11:50:00Z"),
        event("b", "2026-10-10T11:51:00Z", { type: "Warning" }),
      ]),
    });
    const { context } = consoleContext(answer);
    const grid = await listEvents(context, events("events -A --types=warning"));
    expect(grid.fields[0]).toBe("NAMESPACE");
    expect(grid.rows.map((row) => row.OBJECT)).toEqual(["pod/b"]);
  });

  test("--for selects by kind, API version and name, each value escaped", async () => {
    const selector =
      "involvedObject.kind%3DDeployment%2CinvolvedObject.apiVersion%3Dapps%2Fv1%2CinvolvedObject.name%3Dweb%5C%2Cv%5C%3D2";
    const answer = routes({
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`]: listAnswer([]),
    });
    const { context, transport } = consoleContext(answer);
    expect((await listEvents(context, events("events --for 'deploy/web,v=2'"))).rows).toEqual([]);
    expect(sentLines(transport)).toEqual([`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`]);
  });

  test("one --types value is sent as a field selector, so the server narrows the counted set", async () => {
    const answer = routes({
      "GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=type%3DWarning": listAnswer([
        event("w", "2026-10-10T11:50:00Z", { type: "Warning" }),
      ]),
    });
    const { context, transport } = consoleContext(answer);
    const grid = await listEvents(context, events("events --types=Warning"));
    expect(sentLines(transport)).toEqual(["GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=type%3DWarning"]);
    expect(grid.rows.map((row) => row.OBJECT)).toEqual(["pod/w"]);
  });

  test("--for and one --types value join in one selector; both types send no type selector", async () => {
    const selector = "involvedObject.kind%3DPod%2CinvolvedObject.apiVersion%3Dv1%2CinvolvedObject.name%3Dweb";
    const answer = routes({
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}%2Ctype%3DWarning`]: listAnswer([]),
      [`GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`]: listAnswer([]),
    });
    const { context, transport } = consoleContext(answer);
    await listEvents(context, events("events --for pod/web --types=Warning"));
    await listEvents(context, events("events --for pod/web --types=Warning,Normal"));
    expect(sentLines(transport).filter((line) => line.includes("/events?"))).toEqual([
      `GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}%2Ctype%3DWarning`,
      `GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`,
    ]);
  });

  test("past 1,000 events the newest 1,000 are shown with a warning", async () => {
    const many = Array.from({ length: 1_200 }, (_unused, index) =>
      event(`p${index}`, new Date(Date.UTC(2026, 9, 10, 10, 0, index)).toISOString()),
    );
    const answer = routes({
      "GET /api/v1/namespaces/shop/events?limit=500": listAnswer(many.slice(0, 500), { continue: "500" }),
      "GET /api/v1/namespaces/shop/events?limit=500&continue=500": listAnswer(many.slice(500, 1_000), {
        continue: "1000",
      }),
      "GET /api/v1/namespaces/shop/events?limit=500&continue=1000": listAnswer(many.slice(1_000)),
    });
    const { context } = consoleContext(answer);
    const grid = await listEvents(context, events("events"));
    expect(grid.rows).toHaveLength(1_000);
    expect(grid.rows[0].OBJECT).toBe("pod/p200");
    expect(grid.warnings).toEqual([
      { message: "1,200 events match; the newest 1,000 are shown. Narrow them with --for TYPE/NAME or --types." },
    ]);
  });

  test("more than 5,000 events, --for included, answer the sentence", async () => {
    const page = (start: number, next?: string) =>
      listAnswer(
        Array.from({ length: 500 }, (_unused, index) => event(`p${start + index}`, "2026-10-10T11:00:00Z")),
        next === undefined ? {} : { continue: next },
      );
    const selector = "involvedObject.kind%3DPod%2CinvolvedObject.apiVersion%3Dv1%2CinvolvedObject.name%3Dweb";
    const base = `GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=${selector}`;
    const map: Record<string, ReturnType<typeof listAnswer>> = {};
    for (let start = 0; start < 5_000; start += 500) {
      const key =
        start === 0 ? base : `GET /api/v1/namespaces/shop/events?limit=500&continue=${start}&fieldSelector=${selector}`;
      map[key] = page(start, String(start + 500));
    }
    const { context } = consoleContext(routes(map));
    await expect(listEvents(context, events("events --for pod/web"))).rejects.toThrow(EVENTS_CAP_SENTENCE);
  });

  test("exactly 5,000 events with no continue left are shown", async () => {
    const page = (start: number, next?: string) =>
      listAnswer(
        Array.from({ length: 500 }, (_unused, index) => event(`p${start + index}`, "2026-10-10T11:00:00Z")),
        next === undefined ? {} : { continue: next },
      );
    const map: Record<string, ReturnType<typeof listAnswer>> = {};
    for (let start = 0; start < 5_000; start += 500) {
      const key =
        start === 0
          ? "GET /api/v1/namespaces/shop/events?limit=500"
          : `GET /api/v1/namespaces/shop/events?limit=500&continue=${start}`;
      map[key] = page(start, start + 500 < 5_000 ? String(start + 500) : undefined);
    }
    const { context } = consoleContext(routes(map));
    expect((await listEvents(context, events("events"))).rows).toHaveLength(1_000);
  });

  test("eventTime reads the series, then the last timestamp, then the event time", () => {
    expect(
      eventTime({ series: { lastObservedTime: "2026-10-10T00:00:01Z" }, lastTimestamp: "2026-10-10T00:00:02Z" }),
    ).toBe(Date.UTC(2026, 9, 10, 0, 0, 1));
    expect(eventTime({ lastTimestamp: "2026-10-10T00:00:02Z", eventTime: "2026-10-10T00:00:03Z" })).toBe(
      Date.UTC(2026, 9, 10, 0, 0, 2),
    );
    expect(eventTime({ eventTime: "2026-10-10T00:00:03Z" })).toBe(Date.UTC(2026, 9, 10, 0, 0, 3));
    expect(eventTime({})).toBe(0);
  });

  test("a server without core events answers a sentence", async () => {
    const { context } = consoleContext(
      routes({
        "GET /api": jsonAnswer({
          kind: "APIGroupDiscoveryList",
          apiVersion: "apidiscovery.k8s.io/v2",
          items: [{ metadata: {}, versions: [{ version: "v1", resources: [] }] }],
        }),
      }),
    );
    await expect(listEvents(context, events("events"))).rejects.toThrow("This server does not serve core events.");
  });
});

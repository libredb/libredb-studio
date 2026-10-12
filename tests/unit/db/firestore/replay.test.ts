/**
 * The replay of the Firestore captures, which the integration test and the end-to-end stub both answer through, and
 * the recorder the capture harness writes them with: each lane's record, each request's key per lane, the 404 for a
 * request nobody recorded.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeRequest, NodeResponse, NodeTransport, NodeTransportOptions } from "@/lib/db/http/node-transport";
import {
  authorizationClass,
  type CaptureSink,
  type FirestoreExchange,
  jsonAnswer,
  laneRecord,
  readCapture,
  type RecordedRequest,
  recordedRequest,
  recordingTransport,
  replayAnswer,
  replayKey,
  replayTransport,
  scriptedTransport,
  UNRECORDED_ANSWER,
} from "../../../helpers/firestore-replay";

const options = (overrides: Partial<NodeTransportOptions> = {}): NodeTransportOptions => ({
  origin: { scheme: "http", host: "127.0.0.1", port: 8080 },
  tls: null,
  maxSockets: 4,
  headers: { authorization: "Bearer owner" },
  ...overrides,
});

const request = (url: string, extra: Partial<NodeRequest> = {}): NodeRequest => ({
  method: "GET",
  url,
  signal: new AbortController().signal,
  maxResponseBytes: 4 * 1024 * 1024,
  ...extra,
});

const recorded = (
  lane: FirestoreExchange["lane"],
  method: "GET" | "POST",
  path: string,
  text: string,
  extra: Partial<RecordedRequest> = {},
) =>
  ({
    lane,
    request: { method, path, maxResponseBytes: 1024, ...extra },
    response: { status: 200, contentType: "application/json", retryAfter: null, text },
  }) satisfies FirestoreExchange;

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("authorizationClass", () => {
  test("keeps the emulator's literal, classes every other bearer value, and absent is null", () => {
    expect(authorizationClass("Bearer owner")).toBe("Bearer owner");
    expect(authorizationClass("Bearer ya29.real-token")).toBe("Bearer <token>");
    expect(authorizationClass(undefined)).toBeNull();
  });

  test("refuses an authorization that is not a bearer value rather than recording it", () => {
    expect(() => authorizationClass("Basic dXNlcjpwYXNz")).toThrow("not a bearer value");
  });
});

describe("laneRecord", () => {
  test("names the lane, the origin, the sorted header names and the link-local refusal, never a header value", () => {
    const lane = laneRecord(
      options({
        origin: { scheme: "https", host: "firestore.googleapis.com", port: 443 },
        headers: {
          "X-Goog-Request-Params": "project_id=p",
          authorization: "Bearer ya29.secret",
          "google-cloud-resource-prefix": "projects/p/databases/(default)",
        },
        refusesLinkLocal: true,
      }),
      "api",
    );
    expect(lane).toEqual({
      lane: "api",
      origin: "https://firestore.googleapis.com:443",
      headerNames: ["authorization", "google-cloud-resource-prefix", "x-goog-request-params"],
      authorization: "Bearer <token>",
      refusesLinkLocal: true,
    });
    expect(JSON.stringify(lane)).not.toContain("secret");
  });

  test("a lane without the option records refusesLinkLocal false", () => {
    expect(laneRecord(options({ headers: {} }), "metadata").refusesLinkLocal).toBe(false);
  });
});

describe("recordedRequest", () => {
  test("keeps path and query, body, request header names and the cap", () => {
    expect(
      recordedRequest(
        "api",
        request("https://firestore.googleapis.com/v1/projects/p/databases/%28default%29/documents:runQuery?b=2&a=1", {
          method: "POST",
          body: '{"structuredQuery":{}}',
          headers: { "X-Goog-User-Project": "q" },
        }),
      ),
    ).toEqual({
      method: "POST",
      path: "/v1/projects/p/databases/%28default%29/documents:runQuery?b=2&a=1",
      body: '{"structuredQuery":{}}',
      headerNames: ["x-goog-user-project"],
      maxResponseBytes: 4 * 1024 * 1024,
    });
  });

  test("a token request keeps its grant type and never its form or body", () => {
    const kept = recordedRequest(
      "token",
      request("https://oauth2.googleapis.com/token", {
        method: "POST",
        form: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: "eyJhbGciOi.secret.sig" },
      }),
    );
    expect(kept).toEqual({
      method: "POST",
      path: "/token",
      grantType: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      maxResponseBytes: 4 * 1024 * 1024,
    });
    expect(JSON.stringify(kept)).not.toContain("secret");
  });
});

describe("replayKey", () => {
  test("API and emulator lanes key on method, path, sorted query and body", () => {
    expect(replayKey("emulator", { method: "POST", path: "/v1/x:runQuery?b=2&a=1", body: "{}" })).toBe(
      "emulator POST /v1/x:runQuery?a=1&b=2 {}",
    );
    expect(replayKey("api", { method: "GET", path: "/v1/x?pageSize=3&mask.fieldPaths=__name__" })).toBe(
      "api GET /v1/x?mask.fieldPaths=__name__&pageSize=3",
    );
  });

  test("the same request on two lanes has two keys", () => {
    const line = { method: "GET" as const, path: "/v1/x" };
    expect(replayKey("api", line)).not.toBe(replayKey("emulator", line));
  });

  test("the token lane keys on method, path and grant type alone", () => {
    expect(
      replayKey("token", { method: "POST", path: "/token?x=1", body: "ignored", grantType: "refresh_token" }),
    ).toBe("token POST /token grant_type=refresh_token");
  });

  test("the metadata lane keys on method, path and sorted query", () => {
    expect(
      replayKey("metadata", {
        method: "GET",
        path: "/computeMetadata/v1/instance/service-accounts/default/token?scopes=s&b=1",
      }),
    ).toBe("metadata GET /computeMetadata/v1/instance/service-accounts/default/token?b=1&scopes=s");
  });
});

describe("replayAnswer", () => {
  test("answers in recorded order, repeats the last answer, and 404s what nobody recorded", () => {
    const answer = replayAnswer([
      recorded("emulator", "GET", "/v1/a?y=1&x=2", "first"),
      recorded("emulator", "GET", "/v1/a?x=2&y=1", "second"),
    ]);
    expect(answer("emulator", { method: "GET", path: "/v1/a?x=2&y=1" }).text).toBe("first");
    expect(answer("emulator", { method: "GET", path: "/v1/a?y=1&x=2" }).text).toBe("second");
    expect(answer("emulator", { method: "GET", path: "/v1/a?x=2&y=1" }).text).toBe("second");
    expect(answer("api", { method: "GET", path: "/v1/a?x=2&y=1" })).toBe(UNRECORDED_ANSWER);
    expect(UNRECORDED_ANSWER).toMatchObject({ status: 404, contentType: "text/plain; charset=utf-8" });
  });
});

describe("replayTransport", () => {
  test("answers each lane from the exchanges, recording lanes, keys asked, keys missed and requests sent", async () => {
    const replay = replayTransport([
      recorded("emulator", "POST", "/v1/d:listCollectionIds", '{"collectionIds":["users"]}', {
        body: '{"pageSize":1}',
      }),
    ]);
    const transport = replay.createTransport(options(), "emulator");
    const hit = await transport.request(
      request("http://127.0.0.1:8080/v1/d:listCollectionIds", { method: "POST", body: '{"pageSize":1}' }),
    );
    expect(JSON.parse(hit.text)).toEqual({ collectionIds: ["users"] });
    const miss = await transport.request(request("http://127.0.0.1:8080/v1/other"));
    expect(miss.status).toBe(404);
    transport.close();
    expect(replay.lanes).toEqual([
      {
        lane: "emulator",
        origin: "http://127.0.0.1:8080",
        headerNames: ["authorization"],
        authorization: "Bearer owner",
        refusesLinkLocal: false,
      },
    ]);
    expect(replay.asked).toEqual(['emulator POST /v1/d:listCollectionIds {"pageSize":1}', "emulator GET /v1/other"]);
    expect(replay.missed).toEqual(["emulator GET /v1/other"]);
    expect(replay.sent.map((sent) => sent.lane)).toEqual(["emulator", "emulator"]);
  });
});

describe("scriptedTransport", () => {
  test("answers through the function, which sees the lane, the request and the lane's options", async () => {
    const seen: string[] = [];
    const script = scriptedTransport((lane, sent, laneOptions) => {
      seen.push(`${lane} ${sent.method} ${laneOptions.origin.host}`);
      return jsonAnswer({ ok: true }, 201, "7");
    });
    const answer = await script.createTransport(options(), "api").request(request("http://127.0.0.1:8080/v1/x"));
    expect(answer).toEqual({ status: 201, contentType: "application/json", retryAfter: "7", text: '{"ok":true}' });
    expect(seen).toEqual(["api GET 127.0.0.1"]);
    expect(script.missed).toEqual([]);
  });

  test("a script that throws rejects the request, as a transport failure does", async () => {
    const script = scriptedTransport(() => {
      throw new Error("too large");
    });
    await expect(
      script.createTransport(options(), "api").request(request("http://127.0.0.1:8080/v1/x")),
    ).rejects.toThrow("too large");
  });

  test("a script that answers UNRECORDED_ANSWER is a miss", async () => {
    const script = scriptedTransport(() => UNRECORDED_ANSWER);
    await script.createTransport(options(), "api").request(request("http://127.0.0.1:8080/v1/x"));
    expect(script.missed).toEqual(["api GET /v1/x"]);
  });
});

describe("recordingTransport", () => {
  test("sends through the inner transport and keeps the lane and each exchange as a capture holds them", async () => {
    const sink: CaptureSink = { lanes: [], exchanges: [] };
    let closed = 0;
    const inner = (): NodeTransport => ({
      async request(): Promise<NodeResponse> {
        return jsonAnswer({ collectionIds: [] });
      },
      close() {
        closed += 1;
      },
    });
    const transport = recordingTransport(inner, sink)(options({ refusesLinkLocal: true }), "emulator");
    await transport.request(request("http://127.0.0.1:8080/v1/d:listCollectionIds", { method: "POST", body: "{}" }));
    transport.close();
    expect(closed).toBe(1);
    expect(sink.lanes).toEqual([
      {
        lane: "emulator",
        origin: "http://127.0.0.1:8080",
        headerNames: ["authorization"],
        authorization: "Bearer owner",
        refusesLinkLocal: true,
      },
    ]);
    expect(sink.exchanges).toEqual([
      {
        lane: "emulator",
        request: { method: "POST", path: "/v1/d:listCollectionIds", body: "{}", maxResponseBytes: 4 * 1024 * 1024 },
        response: { status: 200, contentType: "application/json", retryAfter: null, text: '{"collectionIds":[]}' },
      },
    ]);
  });

  test("a request the inner transport rejects is not recorded, and the rejection passes through", async () => {
    const sink: CaptureSink = { lanes: [], exchanges: [] };
    const inner = (): NodeTransport => ({
      async request(): Promise<NodeResponse> {
        throw new Error("unreachable");
      },
      close() {},
    });
    const transport = recordingTransport(inner, sink)(options(), "emulator");
    await expect(transport.request(request("http://127.0.0.1:8080/v1/x"))).rejects.toThrow("unreachable");
    expect(sink.exchanges).toEqual([]);
  });
});

describe("readCapture", () => {
  test("reads a capture file", () => {
    const dir = mkdtempSync(join(tmpdir(), "firestore-replay-"));
    dirs.push(dir);
    const file = join(dir, "browse.json");
    writeFileSync(file, JSON.stringify({ scenario: "browse", lanes: [], exchanges: [] }));
    expect(readCapture(file)).toEqual({ scenario: "browse", lanes: [], exchanges: [] });
  });
});

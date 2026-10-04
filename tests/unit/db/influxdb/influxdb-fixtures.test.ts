/**
 * The two InfluxDB test helpers every later integration test replays captures through (InfluxDB spec 8, contract
 * section 19): tests/helpers/influxdb-fixtures.ts, the one reader of tests/fixtures/influxdb/, and
 * tests/helpers/influxdb-transport.ts, the recording `NodeTransport` handed to the real client in place of the
 * shared one. A capture is loaded by its version and name, the manifest names the three pinned lines, and the
 * recording transport answers each request with the next scripted capture, records what the client put on the wire,
 * and fails a `cut` capture the way the shared transport fails a truncated body.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TransportError } from "@/lib/db/http/node-transport";
import {
  INFLUX_FIXTURE_VERSIONS,
  INFLUX_FIXTURES_DIR,
  type InfluxCapture,
  loadDifferentialCorpus,
  loadInfluxCapture,
  loadInfluxManifest,
} from "../../../helpers/influxdb-fixtures";
import { recordingInfluxTransport } from "../../../helpers/influxdb-transport";

const ORIGIN = { protocol: "http:", hostname: "127.0.0.1", port: 8086 } as never;
const TRANSPORT_OPTIONS = {
  origin: ORIGIN,
  tls: null,
  maxSockets: 4,
  headers: { authorization: "Token <token>" },
};

function capture(overrides: Partial<InfluxCapture> = {}): InfluxCapture {
  return {
    version: "2.9.1",
    name: "probe",
    image: "influxdb:2.9.1@sha256:0",
    capturedAt: "2026-10-04",
    request: { method: "POST", path: "/query", query: {}, form: { q: "SHOW DATABASES" }, auth: "token" },
    status: 200,
    contentType: "application/json",
    body: '{"results":[{"statement_id":0}]}\n',
    ...overrides,
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  method: "POST" as const,
  url: "http://127.0.0.1:8086/query",
  form: { q: "SHOW DATABASES", chunked: "true" },
  signal: new AbortController().signal,
  maxResponseBytes: 1024,
  ...overrides,
});

describe("loadInfluxCapture", () => {
  test("reads a capture by its version and name, in the contract's shape", () => {
    const ping = loadInfluxCapture("3.12.0-core", "ping-auth");
    expect(ping.version).toBe("3.12.0-core");
    expect(ping.name).toBe("ping-auth");
    expect(ping.image).toMatch(/^influxdb:3\.12\.0-core@sha256:[0-9a-f]{64}$/);
    expect(ping.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ping.request).toEqual({ method: "GET", path: "/ping", query: {}, auth: "bearer" });
    expect(ping.status).toBe(200);
    expect(JSON.parse(ping.body)).toMatchObject({ product_name: "InfluxDB 3 Core", version: "3.12.0" });
  });

  test("reads a capture under differential/ by its plan name", () => {
    const entry = loadInfluxCapture("1.13.1", "differential/b5-nul");
    expect(entry.name).toBe("differential/b5-nul");
    expect(entry.request.form?.q).toBe("SELECT count(temp) FROM home\u0000; SHOW DATABASES");
  });

  test("reads both query_sql truncations: the real line-end cut and the mid-line slice of it (R39)", () => {
    const real = loadInfluxCapture("3.12.0-core", "sql-truncated");
    expect([real.cut, real.bytes, real.synthetic]).toEqual(["line-end", Buffer.byteLength(real.body), undefined]);
    expect(real.body.endsWith("\n")).toBe(true);
    const slice = loadInfluxCapture("3.12.0-core", "sql-truncated-mid-line");
    expect([slice.cut, slice.bytes]).toEqual(["mid-line", Buffer.byteLength(slice.body)]);
    expect(slice.synthetic).toStartWith(
      `SYNTHETIC (R39): the first ${slice.bytes} of the ${real.bytes} bytes of sql-truncated.json`,
    );
    expect(real.body.startsWith(slice.body) && !slice.body.endsWith("\n")).toBe(true);
    // Everything but the body and its labels is the server's answer to the one request that was sent.
    const answerOf = (c: InfluxCapture) => [c.version, c.image, c.capturedAt, c.request, c.status, c.contentType];
    expect(answerOf(slice)).toEqual(answerOf(real));
  });

  test("a missing capture throws, naming the file", () => {
    expect(() => loadInfluxCapture("2.9.1", "no-such-capture")).toThrow("no-such-capture.json");
  });

  test("a file whose version or name is not the one asked for throws", () => {
    expect(() => loadInfluxCapture("2.9.1", "../1.13.1/ping-anon")).toThrow(
      "../1.13.1/ping-anon.json holds 1.13.1/ping-anon, not 2.9.1/../1.13.1/ping-anon",
    );
  });
});

describe("loadDifferentialCorpus", () => {
  test("reads every differential capture of a line, sorted by name", () => {
    const corpus = loadDifferentialCorpus("2.9.1");
    expect(corpus.length).toBe(25);
    const names = corpus.map((entry) => entry.name);
    expect(names).toEqual([...names].sort());
    for (const entry of corpus) expect(entry.name.startsWith("differential/")).toBe(true);
  });

  test("3.12.0-core also holds the two-statement capture", () => {
    expect(loadDifferentialCorpus("3.12.0-core").map((entry) => entry.name)).toContain("differential/two-statements");
  });
});

describe("the manifest", () => {
  test("names the three pinned lines with their image and date, and a README beside each", () => {
    const manifest = loadInfluxManifest();
    expect(manifest.versions.map((entry) => entry.version)).toEqual([...INFLUX_FIXTURE_VERSIONS]);
    for (const entry of manifest.versions) {
      expect(entry.image).toMatch(new RegExp(String.raw`^influxdb:${entry.version.replaceAll(".", "\\.")}@sha256:`));
      expect(entry.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(existsSync(join(INFLUX_FIXTURES_DIR, entry.version, "README.md"))).toBe(true);
      expect(loadInfluxCapture(entry.version, "ping-anon").image).toBe(entry.image);
    }
  });
});

describe("recordingInfluxTransport", () => {
  test("answers each request with the next scripted capture, in order", async () => {
    const first = capture({ body: "first" });
    const second = capture({ status: 401, contentType: null, body: "second" });
    const { factory } = recordingInfluxTransport([first, second]);
    const transport = factory(TRANSPORT_OPTIONS);
    expect(await transport.request(request())).toEqual({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: "first",
    });
    expect(await transport.request(request())).toEqual({
      status: 401,
      contentType: null,
      retryAfter: null,
      text: "second",
    });
    transport.close();
  });

  test("records the method, the URL, the form, the body and the connection's headers of every request", async () => {
    const { factory, requests } = recordingInfluxTransport([capture(), capture()]);
    const transport = factory(TRANSPORT_OPTIONS);
    await transport.request(request());
    await transport.request(
      request({ url: "http://127.0.0.1:8181/api/v3/query_sql", form: undefined, body: '{"q":"SELECT 1"}' }),
    );
    expect(requests).toEqual([
      {
        method: "POST",
        url: "http://127.0.0.1:8086/query",
        form: { q: "SHOW DATABASES", chunked: "true" },
        headers: { authorization: "Token <token>" },
      },
      {
        method: "POST",
        url: "http://127.0.0.1:8181/api/v3/query_sql",
        body: '{"q":"SELECT 1"}',
        headers: { authorization: "Token <token>" },
      },
    ]);
  });

  test("a scripted function picks the capture from the recorded request", async () => {
    const { factory } = recordingInfluxTransport([
      (seen) => capture({ body: `${seen.method} ${new URL(seen.url).pathname}` }),
    ]);
    expect((await factory(TRANSPORT_OPTIONS).request(request({ method: "GET", form: undefined }))).text).toBe(
      "GET /query",
    );
  });

  test("a cut capture fails as a truncated network error, after it was recorded", async () => {
    const { factory, requests } = recordingInfluxTransport([capture({ cut: "mid-line", body: '{"a":1}\n{"b' })]);
    const failure = await factory(TRANSPORT_OPTIONS)
      .request(request())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TransportError);
    expect(failure).toMatchObject({
      kind: "network",
      truncated: true,
      message: "The server ended the response before it was complete",
    });
    expect(requests).toHaveLength(1);
  });

  test("each truncation capture fails as a truncated network error, the line-end cut too (R39)", async () => {
    const script = ["sql-truncated-zero", "sql-truncated", "sql-truncated-mid-line"].map((name) =>
      loadInfluxCapture("3.12.0-core", name),
    );
    const transport = recordingInfluxTransport(script).factory(TRANSPORT_OPTIONS);
    for (const { name } of script) {
      // oxlint-disable-next-line no-await-in-loop -- the scripted answers are taken in order.
      const failure = await transport.request(request({ maxResponseBytes: 1 << 20 })).catch((error: unknown) => error);
      expect({ name, failure }).toMatchObject({ name, failure: { kind: "network", truncated: true } });
    }
  });

  test("an already-cancelled request fails as the shared transport fails it, sends nothing and keeps its answer", async () => {
    const controller = new AbortController();
    controller.abort();
    const { factory, requests } = recordingInfluxTransport([capture()]);
    const transport = factory(TRANSPORT_OPTIONS);
    const cancelled = await transport.request(request({ signal: controller.signal })).catch((error: unknown) => error);
    expect(cancelled).toBeInstanceOf(TransportError);
    expect(cancelled).toMatchObject({ kind: "aborted", truncated: false, message: "The request was cancelled" });
    expect(requests).toHaveLength(0);
    const late = await transport
      .request(request({ signal: AbortSignal.abort(new DOMException("late", "TimeoutError")) }))
      .catch((error: unknown) => error);
    expect(late).toMatchObject({ kind: "timeout", message: "The request did not finish within its time limit" });
    expect((await transport.request(request())).status).toBe(200);
  });

  test("a body over maxResponseBytes fails as too-large, before a cut is read", async () => {
    const body = '{"results":[{"statement_id":0}]}\n';
    const { factory, requests } = recordingInfluxTransport([capture({ body }), capture({ body, cut: "mid-line" })]);
    const transport = factory(TRANSPORT_OPTIONS);
    const limit = Buffer.byteLength(body) - 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      // oxlint-disable-next-line no-await-in-loop -- the two scripted answers are taken in order.
      const failure = await transport.request(request({ maxResponseBytes: limit })).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        kind: "too-large",
        message: `The response exceeded the ${limit}-byte limit for one response, so it was not read to the end`,
      });
    }
    expect(requests).toHaveLength(2);
  });

  test("a body of exactly maxResponseBytes is answered", async () => {
    const body = '{"results":[{"statement_id":0}]}\n';
    const { factory } = recordingInfluxTransport([capture({ body })]);
    const answer = await factory(TRANSPORT_OPTIONS).request(request({ maxResponseBytes: Buffer.byteLength(body) }));
    expect(answer.text).toBe(body);
  });

  test("a request past the script throws, naming the request line", async () => {
    const { factory } = recordingInfluxTransport([]);
    await expect(factory(TRANSPORT_OPTIONS).request(request())).rejects.toThrow(
      "No scripted answer is left for POST http://127.0.0.1:8086/query",
    );
  });

  test("replays a committed capture as the shared transport hands an answer over", async () => {
    const health = loadInfluxCapture("1.13.1", "health-anon");
    const { factory } = recordingInfluxTransport([health]);
    const answer = await factory(TRANSPORT_OPTIONS).request(request({ method: "GET", form: undefined }));
    expect(answer).toEqual({
      status: health.status,
      contentType: health.contentType,
      retryAfter: null,
      text: health.body,
    });
  });
});

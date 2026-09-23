/**
 * The one reader of the Prometheus fixtures (#1085, section 9, gate 4).
 *
 * `tests/fixtures/prometheus/` holds what the compose servers answered before any provider code
 * existed: `v3.13.3/` from `prom/prometheus:v3.13.3` (the `auth-` files from its basic-auth twin),
 * `victoriametrics-v1.152.0/` from `victoriametrics/victoria-metrics:v1.152.0`, every file named in
 * that directory's README. Every test reads them through this file, so a capture has one name and
 * one reading everywhere, and no test builds a path, parses a record or guesses how a body is
 * encoded on its own.
 *
 * A capture file records one request and the answer to it. `capture` hands back what a replay
 * needs, the body decoded and verbatim; `captureBody` hands back the decoded body alone, for a test
 * that reads what the server said; `captureVm` and `captureVmBody` are the same two over the
 * VictoriaMetrics directory. `fixtureDocument` reads the three documents the capture harness
 * derived rather than captured: `lexer-words` and `promql-functions`, the PromQL parser's word
 * tables at the probed tag, and `reserved-words`, every lexer word asked bare and as a selector.
 *
 * Whatever is not what a test expects is refused by name, never stepped over: a name that is not a
 * bare fixture name, a file that is not there, a capture that is not a record, a derived document
 * read as a capture and a capture read as a document, and, when a test reads its decoded body, a
 * body labelled JSON that does not parse. A test that went on without the answer would test
 * nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The repository root: this file is `tests/helpers/prometheus-fixtures.ts`. */
const ROOT = path.resolve(import.meta.dir, "../..");
const PROMETHEUS_DIR = "tests/fixtures/prometheus/v3.13.3";
const VICTORIA_DIR = "tests/fixtures/prometheus/victoriametrics-v1.152.0";
/** A name as the fixture README's table writes it: lowercase letters and digits in hyphenated words. */
const FIXTURE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Recorded in the capture and never handed on, because they describe the wire rather than the body:
 * `content-length` counts the bytes as sent, and `content-encoding` names a compression `fetch` had
 * already undone. A replay that passed them would describe a body it is not sending.
 */
const WIRE_HEADERS: ReadonlySet<string> = new Set(["content-length", "content-encoding"]);

/** One answer a compose server gave, as a test reads it. */
export interface CapturedAnswer {
  /** The HTTP status. */
  readonly status: number;
  /** The recorded headers the server sent, except the two that describe the wire. */
  readonly headers: Readonly<Record<string, string>>;
  /** The body decoded on first read: the parsed document where `content-type` names JSON, the text otherwise. */
  readonly body: unknown;
  /** The body exactly as it arrived, for a replay that must hand over the server's own bytes. */
  readonly text: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The fixture's path from the repository root, once the name is a bare fixture name and the file exists. */
function fixturePath(directory: string, name: string): string {
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(
      `"${name}" is not a fixture name: pass the bare name the fixture README lists, with no directory and no .json`,
    );
  }
  const relative = `${directory}/${name}.json`;
  if (!existsSync(path.join(ROOT, relative))) {
    throw new Error(`${relative} does not exist; the fixture README lists every captured file`);
  }
  return relative;
}

function readJson(relative: string): unknown {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relative), "utf8"));
  } catch (error) {
    throw new Error(`${relative} is not JSON: ${messageOf(error)}`, { cause: error });
  }
}

/** Whether a Content-Type value names JSON: `application/json`, with or without parameters, or a `+json` type. */
function namesJson(contentType: string | undefined): boolean {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return media === "application/json" || media.endsWith("+json");
}

function decode(relative: string, contentType: string | undefined, text: string): unknown {
  if (!namesJson(contentType)) return text;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${relative}: the body is labelled ${contentType} and does not parse: ${messageOf(error)}`, {
      cause: error,
    });
  }
}

function readCapture(directory: string, name: string): CapturedAnswer {
  const relative = fixturePath(directory, name);
  const record = readJson(relative);
  const status = isObject(record) ? record.status : undefined;
  const recorded = isObject(record) ? record.headers : undefined;
  const text = isObject(record) ? record.body : undefined;
  if (typeof status !== "number" || !Number.isInteger(status) || !isObject(recorded) || typeof text !== "string") {
    throw new Error(`${relative} is not a capture record; a derived document is read with fixtureDocument()`);
  }
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(recorded)) {
    if (value === null || WIRE_HEADERS.has(header)) continue;
    if (typeof value !== "string") throw new Error(`${relative}: the recorded header ${header} is not text`);
    headers[header] = value;
  }
  let decoded: { readonly value: unknown } | undefined;
  return {
    status,
    headers,
    text,
    // Decoded on first read, so an answer whose body is labelled JSON and does not parse still
    // replays through `text`, and only a test that asks for the decoded body is refused.
    get body(): unknown {
      decoded ??= { value: decode(relative, headers["content-type"], text) };
      return decoded.value;
    },
  };
}

/**
 * A capture of the compose `prometheus` service, `prom/prometheus:v3.13.3`; the `auth-` ones were
 * asked of `prometheus-auth`, the same image behind basic auth.
 */
export function capture(name: string): CapturedAnswer {
  return readCapture(PROMETHEUS_DIR, name);
}

/** The decoded body of a `prometheus` capture, typed by the test: `captureBody<Envelope<Build>>("buildinfo")`. */
export function captureBody<T>(name: string): T {
  return capture(name).body as T;
}

/** A capture of the compose `victoriametrics` service, `victoriametrics/victoria-metrics:v1.152.0`. */
export function captureVm(name: string): CapturedAnswer {
  return readCapture(VICTORIA_DIR, name);
}

/** The decoded body of a `victoriametrics` capture, typed by the test. */
export function captureVmBody<T>(name: string): T {
  return captureVm(name).body as T;
}

/**
 * A document the capture harness derived rather than captured, whole: `lexer-words`,
 * `promql-functions` or `reserved-words`. Nothing in it is decoded, so the answers
 * `reserved-words` holds keep `body` as text, the way the capture files keep it.
 */
export function fixtureDocument<T>(name: string): T {
  const relative = fixturePath(PROMETHEUS_DIR, name);
  const parsed = readJson(relative);
  if (isObject(parsed) && "request" in parsed && "body" in parsed) {
    throw new Error(`${relative} is a capture record; read it with capture() or captureBody()`);
  }
  return parsed as T;
}

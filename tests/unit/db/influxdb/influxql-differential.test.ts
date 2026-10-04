/**
 * The InfluxQL read policy held against what the servers actually ran (InfluxDB spec 3.6 E4, review focus 1 and 2):
 * the differential corpus of tests/fixtures/influxdb/<version>/differential/, each text a fixed part, a separator and
 * the hidden statement `SHOW DATABASES`, sent by tests/live/influxdb-evidence.ts to 1.13.1 and 2.9.1 as the read
 * principal and to 3.12.0 Core (whose `/query` runs a separate Rust parser) as admin, all against a database that
 * does not exist.
 *
 * Each capture is read for what the server did with the text: a parse error, or the statements it parsed and how
 * the first one reads. 2.9.1 answers one result per statement (the second "not executed" once the first fails) and
 * 3.12.0 runs the hidden statement as `statement_id` 1. 1.13.1 authorizes every statement before it runs any, so
 * the read principal's 403 names only the first statement, as the server reprints it, and hides the count. A
 * reprint without the hidden statement does not show a second statement: a hidden statement a comment swallowed is
 * absent from it too. So the 1.13.1 captures are not differential evidence of a statement count; they show only
 * how the first statement reads (a write there must be refused), and the policy refuses every 1.13.1 text on the
 * same ground as every other corpus text.
 * The policy must refuse every entry whose capture shows more than one statement or a first statement that is not
 * a read; a verdict that disagrees is a security defect. Every corpus text ends in a statement the server can run,
 * so the policy refuses every one of them.
 */
import { describe, expect, test } from "bun:test";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import {
  INFLUX_FIXTURE_VERSIONS,
  type InfluxCapture,
  type InfluxFixtureVersion,
  loadDifferentialCorpus,
} from "../../../helpers/influxdb-fixtures";

const HIDDEN = "SHOW DATABASES";

type ServerReading =
  | { readonly parsed: false; readonly error: string }
  | {
      readonly parsed: true;
      /** Statements the server parsed; null where a 403 names only the first. */
      readonly statements: number | null;
      /** The first statement as the server reprints it; null where the answer does not show it. */
      readonly first: string | null;
    };

/** The JSON documents of a chunked body: newline separated on 1.x and 2.x, back to back on 3.x (K5). */
function documentsOf(body: string): unknown[] {
  const documents: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) documents.push(JSON.parse(body.slice(start, index + 1)));
    }
  }
  return documents;
}

interface Result {
  readonly statement_id: number;
  readonly error?: string;
}

const RUST_PARSE_ERROR = "error in InfluxQL statement: parsing error";

function readCapture(capture: InfluxCapture): ServerReading {
  if (capture.status === 400) {
    const [answer] = documentsOf(capture.body) as { error?: string; message?: string }[];
    return { parsed: false, error: answer.error ?? answer.message ?? "" };
  }
  if (capture.status === 403) {
    const [answer] = documentsOf(capture.body) as { error: string }[];
    const first = /execute statement '([\s\S]*)', requires /.exec(answer.error)?.[1];
    if (first === undefined) throw new Error(`${capture.name}: a 403 that names no statement: ${capture.body}`);
    return { parsed: true, statements: null, first };
  }
  if (capture.status !== 200) throw new Error(`${capture.name}: status ${capture.status} is not read here`);
  const results = (documentsOf(capture.body) as { results: Result[] }[]).flatMap((document) => document.results);
  if (results.length === 1 && results[0].error?.startsWith(RUST_PARSE_ERROR)) {
    return { parsed: false, error: results[0].error };
  }
  return { parsed: true, statements: results.length, first: null };
}

/** A first statement that writes or administers: `INTO`, or a leading keyword that is not a read. */
function firstIsNotARead(first: string | null): boolean {
  if (first === null) return false;
  return /\bINTO\b/i.test(first) || !/^(SELECT|SHOW|EXPLAIN)\b/i.test(first);
}

/**
 * The R42 entries: two statements that only whitespace or a comment separates. 1.13.1 and 2.9.1 answer "found SHOW,
 * expected ;"; 3.12.0 runs both (captures of 2026-10-04).
 */
const R42 = ["r42-comment-show", "r42-newline-show", "r42-space-select", "r42-space-show", "r42-tab-show"];

/** The entries each server refused as a parse error, read from the captures of 2026-10-04. */
const PARSE_ERRORS: Readonly<Record<InfluxFixtureVersion, readonly string[]>> = {
  "1.13.1": ["c1-nul-in-string", ...R42],
  "2.9.1": ["c1-nul-in-string", ...R42],
  "3.12.0-core": ["b5-nul", "into-explain", "into-lowercase", "into-subquery"],
};

/** The 1.13.1 reprints whose first statement is a write: the INTO shapes, which the 403 shows before running. */
const V1_WRITES = ["into-explain", "into-lowercase", "into-subquery"];

const CORPUS = INFLUX_FIXTURE_VERSIONS.map((version) => [version, loadDifferentialCorpus(version)] as const);

const idOf = (capture: InfluxCapture) => capture.name.slice("differential/".length);

describe("the differential corpus as the servers read it (E4)", () => {
  test("every line holds the twenty-five entries, and 3.12.0 the two-statement answer too", () => {
    for (const [version, corpus] of CORPUS) {
      expect(corpus.length).toBe(version === "3.12.0-core" ? 26 : 25);
      for (const capture of corpus) expect(capture.request.form?.q.endsWith(HIDDEN)).toBe(true);
    }
  });

  test("the parse errors are the ones recorded here", () => {
    for (const [version, corpus] of CORPUS) {
      const refused = corpus.filter((capture) => !readCapture(capture).parsed).map(idOf);
      expect({ version, refused }).toEqual({ version, refused: [...PARSE_ERRORS[version]] });
    }
  });

  test("2.9.1 and 3.12.0 parsed the hidden statement as a second statement wherever the text parsed", () => {
    for (const [version, corpus] of CORPUS) {
      if (version === "1.13.1") continue;
      for (const capture of corpus) {
        const reading = readCapture(capture);
        if (reading.parsed)
          expect({ id: idOf(capture), statements: reading.statements }).toEqual({ id: idOf(capture), statements: 2 });
      }
    }
  });

  test("3.12.0 ran the hidden statement as statement 1, and the two-statement answer arrives as two documents (R19)", () => {
    const corpus = loadDifferentialCorpus("3.12.0-core");
    const twoStatements = corpus.find((capture) => idOf(capture) === "two-statements") as InfluxCapture;
    expect(documentsOf(twoStatements.body)).toHaveLength(2);
    expect(twoStatements.body).toContain('}{"results":[{"statement_id":1,');
    for (const capture of corpus) {
      if (readCapture(capture).parsed) expect(capture.body).toContain('"statement_id":1,"series":[{"name":"databases"');
    }
  });

  test("1.13.1 parsed every text but the NUL and R42 ones, and its reprint of the first statement never holds the hidden one", () => {
    for (const capture of loadDifferentialCorpus("1.13.1")) {
      const reading = readCapture(capture);
      if (!reading.parsed) continue;
      expect(reading.first).not.toBeNull();
      expect(reading.first).not.toContain(HIDDEN);
      expect({ id: idOf(capture), write: firstIsNotARead(reading.first) }).toEqual({
        id: idOf(capture),
        write: V1_WRITES.includes(idOf(capture)),
      });
    }
  });

  test("the reader of a capture refuses an answer it cannot read, rather than guessing", () => {
    const base = loadDifferentialCorpus("1.13.1")[0];
    expect(() => readCapture({ ...base, status: 403, body: '{"error":"forbidden"}' })).toThrow(
      "a 403 that names no statement",
    );
    expect(() => readCapture({ ...base, status: 500 })).toThrow("status 500 is not read here");
  });
});

describe("the policy against the corpus (E4)", () => {
  test("refuses every entry whose capture shows more than one statement or a first statement that is not a read", () => {
    let shown = 0;
    for (const [version, corpus] of CORPUS) {
      for (const capture of corpus) {
        const reading = readCapture(capture);
        if (!reading.parsed) continue;
        const mustRefuse = (reading.statements !== null && reading.statements > 1) || firstIsNotARead(reading.first);
        // 1.13.1 hides the count (see the docblock), so only its writes are evidence; 2.9.1 and 3.12.0 show it.
        if (reading.statements === null && !mustRefuse) continue;
        shown += 1;
        expect({ version, id: idOf(capture), mustRefuse }).toEqual({ version, id: idOf(capture), mustRefuse: true });
        const verdict = evaluateInfluxql(capture.request.form?.q ?? "");
        expect({ version, id: idOf(capture), allowed: verdict.allowed }).toEqual({
          version,
          id: idOf(capture),
          allowed: false,
        });
      }
    }
    // The 41 texts 2.9.1 and 3.12.0 parsed, and the three 1.13.1 writes: never a vacuous pass.
    expect(shown).toBe(41 + V1_WRITES.length);
  });

  test("refuses each text 3.12.0 ran as two statements with no semicolon between them (R42)", () => {
    const corpus = loadDifferentialCorpus("3.12.0-core").filter((capture) => R42.includes(idOf(capture)));
    expect(corpus.map(idOf)).toEqual(R42);
    for (const capture of corpus) {
      const text = capture.request.form?.q ?? "";
      expect(text).not.toContain(";");
      expect({ id: idOf(capture), reading: readCapture(capture) }).toEqual({
        id: idOf(capture),
        reading: { parsed: true, statements: 2, first: null },
      });
      const verdict = evaluateInfluxql(text);
      expect({ id: idOf(capture), reason: verdict.allowed ? "allowed" : verdict.reason }).toEqual({
        id: idOf(capture),
        reason: "multiple-statements",
      });
    }
  });

  test("refuses every corpus text, the ones a server refused as a parse error included", () => {
    for (const [version, corpus] of CORPUS) {
      for (const capture of corpus) {
        const verdict = evaluateInfluxql(capture.request.form?.q ?? "");
        expect({ version, id: idOf(capture), allowed: verdict.allowed }).toEqual({
          version,
          id: idOf(capture),
          allowed: false,
        });
      }
    }
  });

  test("reads each NUL as a lexical fault and every other entry as more than one statement", () => {
    for (const [, corpus] of CORPUS) {
      for (const capture of corpus) {
        const verdict = evaluateInfluxql(capture.request.form?.q ?? "");
        const reason = verdict.allowed ? "allowed" : verdict.reason;
        expect({ id: idOf(capture), reason }).toEqual({
          id: idOf(capture),
          reason: idOf(capture).includes("nul") ? "lexical" : "multiple-statements",
        });
      }
    }
  });
});

/**
 * The pure-data plan of tests/live/firestore-evidence.ts, held to spec 9: the emulator pin, the seed plan's required
 * cases, a statement of every kind the parser produces, a fact for every statement that runs, and the conformance
 * expectation read off the seed rather than typed twice.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { compileStatement } from "@/lib/db/providers/document/firestore/console/compile";
import { countStatement, previewStatement } from "@/lib/db/providers/document/firestore/console/generators";
import { parseStatement, type Statement } from "@/lib/db/providers/document/firestore/console/parser";
import { compareUtf8 } from "@/lib/db/providers/document/firestore/names";
import { type FirestoreTypeName, type RestValue, typeNameOf } from "@/lib/db/providers/document/firestore/values";
import {
  DERIVED_FACTS,
  FIRESTORE_CONFORMANCE,
  FIRESTORE_EMULATOR,
  FIRESTORE_SCENARIOS,
  FIRESTORE_SEED,
  FIRESTORE_STATEMENTS,
  gridShows,
} from "../../../live/firestore-evidence-plan";

const TARGET = { projectId: FIRESTORE_EMULATOR.project, databaseId: "(default)" };
const paths = FIRESTORE_SEED.map((document) => document.path);
const segmentsOf = (path: string) => path.split("/");
const topLevel = [...new Set(paths.map((path) => segmentsOf(path)[0]))];
const utf16Order = (values: readonly string[]) => [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const utf8Order = (values: readonly string[]) => [...values].sort(compareUtf8);
const steps = FIRESTORE_SCENARIOS.flatMap((scenario) => scenario.steps);

/** Every `stringValue` the seed holds, at any depth of a map or an array. */
function stringsOf(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) stringsOf(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === "stringValue" && typeof inner === "string") into.add(inner);
      else stringsOf(inner, into);
    }
  }
  return into;
}
const seedStrings = stringsOf(
  FIRESTORE_SEED.map((document) => document.fields),
  new Set(),
);
/** Every path of the seed, every leading run of its segments (a parent collection or document), and every segment. */
const pathFacts = new Set(
  paths.flatMap((path) => {
    const segments = segmentsOf(path);
    return [...segments.map((_, index) => segments.slice(0, index + 1).join("/")), ...segments];
  }),
);
/** A fact the seed holds whole: one of its string values, a path, a parent, a segment, or a key of DERIVED_FACTS. */
const isSeedFact = (text: string) => seedStrings.has(text) || pathFacts.has(text) || Object.hasOwn(DERIVED_FACTS, text);

describe("the emulator pin is spec 9's", () => {
  test("version 1.22.0, its jar SHA-256, Java 21 or later, loopback and a demo- project", () => {
    expect(FIRESTORE_EMULATOR.version).toBe("1.22.0");
    expect(FIRESTORE_EMULATOR.jarSha256).toBe("9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c");
    expect(FIRESTORE_EMULATOR.javaMajorFloor).toBe(21);
    expect(FIRESTORE_EMULATOR.host).toBe("127.0.0.1");
    expect(FIRESTORE_EMULATOR.project.startsWith("demo-")).toBe(true);
  });
});

describe("the seed holds every case spec 9 names", () => {
  test("at least two top-level collections", () => {
    expect(topLevel.length).toBeGreaterThanOrEqual(2);
  });

  test("top-level collection ids whose UTF-16 and UTF-8 orders differ", () => {
    expect(utf16Order(topLevel)).not.toEqual(utf8Order(topLevel));
  });

  test("document ids of one collection whose UTF-16 and UTF-8 orders differ", () => {
    const ids = paths.filter((path) => path.startsWith("ids/")).map((path) => segmentsOf(path)[1]);
    expect(utf16Order(ids)).not.toEqual(utf8Order(ids));
  });

  test("a collection with an odd document count, scanned at a smaller count and followed to its end", () => {
    const orders = paths.filter((path) => segmentsOf(path).length === 2 && path.startsWith("orders/"));
    expect(orders.length % 2).toBe(1);
    const scan = steps.find((step) => step.op === "scan" && step.pattern === "orders/" && step.follow === true);
    expect(scan !== undefined && scan.op === "scan" && scan.count < orders.length).toBe(true);
  });

  test("a missing parent: a document whose parent document is not in the seed", () => {
    const missing = paths.filter((path) => {
      const segments = segmentsOf(path);
      return segments.length > 2 && !paths.includes(segments.slice(0, segments.length - 2).join("/"));
    });
    expect(missing).toContain("orphans/ghost/notes/n1");
  });

  test("a parent id with a colon, holding a subcollection", () => {
    expect(paths).toContain("users/a:b");
    expect(paths.some((path) => path.startsWith("users/a:b/"))).toBe(true);
  });

  test("every Firestore value type of the Native API", () => {
    const seen = new Set<FirestoreTypeName>();
    for (const document of FIRESTORE_SEED) {
      for (const value of Object.values(document.fields)) seen.add(typeNameOf(value as RestValue));
    }
    for (const type of [
      "null",
      "boolean",
      "integer",
      "double",
      "timestamp",
      "string",
      "bytes",
      "reference",
      "geopoint",
      "array",
      "map",
      "vector",
    ] as const)
      expect({ type, seen: seen.has(type) }).toEqual({ type, seen: true });
  });

  test("a garbage page token inside a well-formed envelope", () => {
    expect(steps.some((step) => step.op === "scan" && step.cursor !== undefined && step.refused !== undefined)).toBe(
      true,
    );
  });
});

describe("the scenarios", () => {
  test("are browse, console, surface, empty and datastore, the last two unseeded", () => {
    expect(FIRESTORE_SCENARIOS.map((scenario) => [scenario.name, scenario.seeded])).toEqual([
      ["browse", true],
      ["console", true],
      ["surface", true],
      ["empty", false],
      ["datastore", false],
    ]);
    expect(FIRESTORE_SCENARIOS.find((scenario) => scenario.name === "datastore")?.databaseMode).toBe("datastore-mode");
  });

  test("each starts by connecting, and the surface scenario runs the conformance helper", () => {
    for (const scenario of FIRESTORE_SCENARIOS) expect(scenario.steps[0]?.op).toBe("connect");
    expect(FIRESTORE_SCENARIOS.find((scenario) => scenario.name === "surface")?.steps.map((step) => step.op)).toEqual([
      "connect",
      "surface",
    ]);
  });

  test("the root level lists every top-level collection as a folder, in UTF-8 byte order", () => {
    const root = steps.find((step) => step.op === "scan" && step.pattern === "");
    expect(root?.op === "scan" ? root.prefixes : undefined).toEqual(utf8Order(topLevel).map((id) => `${id}/`));
  });

  test("the tree lists the same collections, and counts them", () => {
    const listing = steps.find((step) => step.op === "collections");
    expect(listing?.op === "collections" ? listing.ids : undefined).toEqual(utf8Order(topLevel));
    const count = steps.find((step) => step.op === "count");
    expect(count?.op === "count" ? count.collections : undefined).toBe(topLevel.length);
  });

  test("every refusal names a fragment of its sentence", () => {
    for (const step of steps) {
      if ("refused" in step && step.refused !== undefined) expect(step.refused.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("the console statements", () => {
  const running = FIRESTORE_STATEMENTS.filter((statement) => statement.refused === undefined);

  test("every statement that runs parses and compiles to one request", () => {
    for (const { text } of running) {
      const compiled = compileStatement(parseStatement(text), text, { target: TARGET, explainButton: false });
      expect({ text, kind: typeof compiled.request.kind }).toEqual({ text, kind: "string" });
    }
  });

  test("they cover every statement kind the parser produces", () => {
    const kinds = new Set<Statement["kind"]>(running.map(({ text }) => parseStatement(text).kind));
    const expected: Statement["kind"][] = [
      "aggregate",
      "getAll",
      "getDocument",
      "listCollections",
      "listDocuments",
      "query",
      "vector",
    ];
    expect([...kinds].sort()).toEqual(expected.sort());
  });

  test("every statement that runs names a fact of the seed its grid must show", () => {
    for (const statement of running) {
      expect({ text: statement.text, fact: statement.shows !== undefined }).toEqual({
        text: statement.text,
        fact: true,
      });
      const fact = statement.shows!;
      const text = "cell" in fact ? fact.cell : fact.within;
      expect({ text: statement.text, known: isSeedFact(text) }).toEqual({ text: statement.text, known: true });
    }
  });

  test("a fact is matched whole, so an invented one is not a seed fact", () => {
    for (const invented of ["Mallory", "Ali", "users/ali", "6", "lice"]) {
      expect({ invented, known: isSeedFact(invented) }).toEqual({ invented, known: false });
    }
    expect(isSeedFact("5")).toBe(true);
    expect(seedStrings.has("5") || pathFacts.has("5")).toBe(false);
  });

  test("the derived facts are computed from the seed", () => {
    const orders = paths.filter((path) => segmentsOf(path).length === 2 && path.startsWith("orders/"));
    expect(DERIVED_FACTS["5"]).toBe(orders.length);
    const prices = FIRESTORE_SEED.filter((document) => document.path.startsWith("products/")).map(
      (document) => (document.fields.price as { doubleValue: number }).doubleValue,
    );
    expect(DERIVED_FACTS["61.5"]).toBe(prices.reduce((sum, price) => sum + price, 0));
  });

  test("the preview and the count are the generators' own text", () => {
    expect(FIRESTORE_STATEMENTS[0]?.text).toBe(previewStatement(["users"]));
    expect(FIRESTORE_STATEMENTS.map((statement) => statement.text)).toContain(countStatement(["orders"]));
  });

  test("a write is refused by the parser with the read-only sentence, never sent", () => {
    const write = FIRESTORE_STATEMENTS.find((statement) => statement.text.includes(".set("));
    expect(() => parseStatement(write!.text)).toThrow(QueryError);
    expect(() => parseStatement(write!.text)).toThrow(write!.refused!);
  });
});

describe("gridShows", () => {
  const rows = [{ __name__: "users/alice", address: { city: "Istanbul" }, count: 5 }];

  test("a cell fact matches a whole cell, an object cell read as its JSON", () => {
    expect(gridShows(rows, { cell: "users/alice" })).toBe(true);
    expect(gridShows(rows, { cell: "5" })).toBe(true);
    expect(gridShows(rows, { cell: "users" })).toBe(false);
  });

  test("a within fact matches a part of a cell", () => {
    expect(gridShows(rows, { within: "Istanbul" })).toBe(true);
    expect(gridShows(rows, { within: "Ankara" })).toBe(false);
  });
});

describe("the conformance expectation", () => {
  test("counts the seed's top-level collections and reads users and users/alice", () => {
    expect(FIRESTORE_CONFORMANCE.containers).toEqual([]);
    expect(FIRESTORE_CONFORMANCE.kinds).toEqual({ collection: topLevel.length });
    expect(FIRESTORE_CONFORMANCE.sampleObject).toEqual({ path: ["users"], kind: "collection" });
    expect(FIRESTORE_CONFORMANCE.keyBrowserSample).toEqual({ path: ["users/alice"], kind: "document" });
    expect(paths).toContain("users/alice");
    expect(paths).not.toContain(FIRESTORE_CONFORMANCE.absentSource?.path[0]);
    expect(FIRESTORE_CONFORMANCE.noAbstainingKinds).toBe(true);
  });
});

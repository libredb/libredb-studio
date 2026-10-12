/**
 * What tests/live/firestore-evidence.ts asks the pinned Firestore emulator, scenario by scenario, and what each answer
 * must show for the capture to be written. Pure data: tests/unit/db/firestore/evidence-plan.test.ts holds it to spec 9,
 * and the integration test and the end-to-end stub replay exactly the requests these steps make.
 *
 * The seed is docker/firestore/seed.json, the same file the compose seeder writes, so the compose fixture and the
 * captures hold the same data. A fact is a value of the seed, a path in it, or a number DERIVED_FACTS computes from it,
 * never a value read back from a capture.
 */
import seed from "../../docker/firestore/seed.json";
import { COMPILE_WARNINGS } from "@/lib/db/providers/document/firestore/console/compile";
import { jsString } from "@/lib/db/providers/document/firestore/console/generators";
import type { ObjectSurfaceExpectation } from "../helpers/object-surface-conformance";

export const FIRESTORE_EMULATOR = Object.freeze({
  version: "1.22.0",
  jarSha256: "9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c",
  javaMajorFloor: 21,
  host: "127.0.0.1",
  /** Not the compose fixture's 8380, so a capture can run beside it. */
  port: 28380,
  project: seed.project,
} as const);

export interface SeedDocument {
  /** The path relative to `documents`, segments joined by `/`. */
  readonly path: string;
  /** REST `Value`s, by field name. */
  readonly fields: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const FIRESTORE_SEED: readonly SeedDocument[] = Object.freeze(seed.documents as unknown as SeedDocument[]);

/** A fact of the seed a grid must show: a cell whose text is exactly `cell`, or one whose text holds `within`. */
export type GridFact = { readonly cell: string } | { readonly within: string };

/** Whether one row of a grid holds the fact, each cell read as text (an object cell as its JSON). */
export function gridShows(rows: readonly Record<string, unknown>[], fact: GridFact): boolean {
  return rows.some((row) =>
    Object.values(row).some((value) => {
      const text =
        typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
      return "cell" in fact ? text === fact.cell : text.includes(fact.within);
    }),
  );
}

/** Facts no seed value spells: the orders' count and the products' price sum. */
export const DERIVED_FACTS: Readonly<Record<string, number>> = Object.freeze({ "5": 5, "61.5": 61.5 });

export interface PlannedStatement {
  readonly text: string;
  readonly shows?: GridFact;
  /** A fragment one of the result's warnings must hold. */
  readonly warns?: string;
  /** A fragment of the refusal's sentence; the statement must be refused. */
  readonly refused?: string;
}

/** One statement of every kind, each as the editor runs it; the first is the tree's preview. */
export const FIRESTORE_STATEMENTS: readonly PlannedStatement[] = Object.freeze([
  { text: 'db.collection("users").limit(100)', shows: { cell: "Alice" } },
  {
    text: 'db.collection("users").where("age", ">=", 30).orderBy("age")',
    shows: { cell: "Bob" },
    warns: COMPILE_WARNINGS.defaultLimit,
  },
  { text: 'db.collection("users").where("nickname", "==", null).get()', shows: { cell: "Alice" } },
  { text: 'db.collection("users").where("tags", "array-contains", "beta")', shows: { cell: "Alice" } },
  {
    text: 'db.collection("users").where(Filter.or(Filter.where("age", "==", 34), Filter.where("age", "==", 41)))',
    shows: { cell: "Bob" },
  },
  {
    text: 'db.collection("users").where("joined", ">=", Timestamp.fromDate(new Date("2026-01-01")))',
    shows: { cell: "Alice" },
  },
  {
    text: 'db.collection("users").offset(1).limit(1)',
    shows: { cell: "users/alice" },
    warns: COMPILE_WARNINGS.offsetBilling,
  },
  {
    text: 'db.collection("orders").orderBy(FieldPath.documentId()).startAfter("0002").limit(2)',
    shows: { cell: "orders/0003" },
  },
  { text: 'db.collectionGroup("orders").select("total")', shows: { cell: "users/alice/orders/o1" } },
  { text: 'db.collection("orders").count()', shows: { cell: "5" } },
  {
    text: 'db.collection("products").aggregate({ total: AggregateField.sum("price"), mean: AggregateField.average("price") })',
    shows: { cell: "61.5" },
  },
  {
    text: 'db.collection("products").findNearest({ vectorField: "embedding", queryVector: [0.1, 0.2, 0.3], limit: 2, distanceMeasure: "EUCLIDEAN", distanceResultField: "distance" })',
    shows: { cell: "products/p1" },
  },
  { text: 'db.doc("users/alice").get()', shows: { within: "Istanbul" } },
  { text: 'db.doc("users/alice").listCollections()', shows: { cell: "orders" } },
  { text: "db.listCollections()", shows: { cell: "products" } },
  { text: 'db.collection("orphans").listDocuments()', shows: { cell: "orphans/ghost" } },
  {
    text: 'db.getAll(db.doc("users/alice"), db.doc("users/ghost"))',
    shows: { cell: "Alice" },
    warns: "users/ghost",
  },
  { text: 'db.collection("ids").orderBy(admin.firestore.FieldPath.documentId())', shows: { cell: "ids/z" } },
  { text: 'db.collection("users").explain()', refused: "The Firestore emulator does not run Query Explain" },
  {
    text: 'db.collection("users").doc("alice").set({ name: "Mallory" })',
    refused: "Studio is read-only for Firestore in this version",
  },
  { text: 'db.collection("users/a:b/notes").limit(5)', refused: "colon" },
]);

export type EvidenceStep =
  | { readonly op: "connect"; readonly warns?: readonly string[]; readonly refused?: string }
  /** `listObjects([], "collection")`: the last path segment of each object, in the order answered. */
  | { readonly op: "collections"; readonly ids: readonly string[] }
  /** `countObjects([])`: the collection count. */
  | { readonly op: "count"; readonly collections: number }
  /** `describeObject([collection], "collection")`: column names that must be present, and some column types. */
  | {
      readonly op: "describe";
      readonly collection: string;
      readonly columns: readonly string[];
      readonly types?: Readonly<Record<string, string>>;
    }
  /** `describeObjects([], "collection", limit)`: whether the caller's bound bit. */
  | { readonly op: "describeAll"; readonly limit: number; readonly truncated: boolean }
  /**
   * `scanKeysPage` with `level: true`: from `"0"`, or from an envelope carrying `cursor.t` as Google's page token;
   * `follow` reads pages until the cursor is `"0"` (at most 20). `keys` and `prefixes` are the whole answer, in order.
   */
  | {
      readonly op: "scan";
      readonly pattern: string;
      readonly count: number;
      readonly cursor?: { readonly t: string };
      readonly follow?: true;
      readonly keys?: readonly string[];
      readonly prefixes?: readonly string[];
      readonly outcome?: "incomplete" | "unknown";
      readonly refused?: string;
    }
  /** `readObjectSource([path], "document")`: fragments its parts must hold. */
  | { readonly op: "source"; readonly path: string; readonly holds?: readonly string[]; readonly refused?: string }
  | ({ readonly op: "statement" } & PlannedStatement)
  /** `assertObjectSurface(provider, FIRESTORE_CONFORMANCE)`. */
  | { readonly op: "surface" };

export interface EvidenceScenario {
  readonly name: "browse" | "console" | "surface" | "empty" | "datastore";
  /** Whether the seed is written after the flush. */
  readonly seeded: boolean;
  /** An emulator started in this mode instead of Native mode. */
  readonly databaseMode?: "datastore-mode";
  readonly steps: readonly EvidenceStep[];
}

const TOP_LEVEL = ["ids", "orders", "orphans", "products", "users", "Ａ-col", "𐐀-col"] as const;
const EMULATOR_WARNING = "Connected to the Firestore emulator at";

export const FIRESTORE_SCENARIOS: readonly EvidenceScenario[] = Object.freeze([
  {
    name: "browse",
    seeded: true,
    steps: [
      { op: "connect", warns: [EMULATOR_WARNING] },
      { op: "collections", ids: TOP_LEVEL },
      { op: "count", collections: TOP_LEVEL.length },
      {
        op: "describe",
        collection: "users",
        columns: [
          "__name__",
          "name",
          "age",
          "address.city",
          "address.geo.zone",
          "embedding",
          `new FieldPath(${jsString("dotted.key")})`,
        ],
        types: { age: "mixed(integer|string)" },
      },
      { op: "describeAll", limit: 3, truncated: true },
      { op: "scan", pattern: "", count: 100, keys: [], prefixes: TOP_LEVEL.map((id) => `${id}/`) },
      { op: "scan", pattern: "us", count: 100, keys: [], prefixes: ["users/"] },
      {
        op: "scan",
        pattern: "users/",
        count: 100,
        keys: ["users/a:b", "users/alice", "users/bob", "users/carol"],
        prefixes: ["users/a:b/", "users/alice/", "users/bob/", "users/carol/"],
      },
      {
        op: "scan",
        pattern: "users/al",
        count: 100,
        keys: ["users/alice"],
        prefixes: ["users/alice/"],
        outcome: "unknown",
      },
      { op: "scan", pattern: "users/alice/", count: 100, keys: [], prefixes: ["users/alice/orders/"] },
      { op: "scan", pattern: "users/a:b/", count: 100, refused: "contains a colon" },
      {
        op: "scan",
        pattern: "orders/",
        count: 3,
        follow: true,
        keys: ["orders/0001", "orders/0002", "orders/0003", "orders/0004", "orders/0005"],
        prefixes: ["orders/0001/", "orders/0002/", "orders/0003/", "orders/0004/", "orders/0005/"],
      },
      {
        op: "scan",
        pattern: "orders/",
        count: 3,
        // Base64 of "not-a-page-token": emulator 1.22.0 answers a token it cannot decode with HTTP 500 UNKNOWN, and
        // a decodable one it does not know with 400 INVALID_ARGUMENT "invalid page token", the refusal measured here.
        cursor: { t: "bm90LWEtcGFnZS10b2tlbg" },
        refused: "This listing expired; list the level again",
      },
      { op: "scan", pattern: "orphans/", count: 100, keys: [], prefixes: ["orphans/ghost/"] },
      {
        op: "scan",
        pattern: "ids/",
        count: 100,
        keys: ["ids/z", "ids/Ａ", "ids/𐐀"],
        prefixes: ["ids/z/", "ids/Ａ/", "ids/𐐀/"],
      },
      { op: "source", path: "users/alice", holds: ["Istanbul", "orders"] },
      { op: "source", path: "users/a:b", holds: ["Colon", "colon"] },
      { op: "source", path: "users/ghost", refused: "users/ghost" },
    ],
  },
  {
    name: "console",
    seeded: true,
    steps: [
      { op: "connect", warns: [EMULATOR_WARNING] },
      ...FIRESTORE_STATEMENTS.map((statement): EvidenceStep => Object.assign({ op: "statement" as const }, statement)),
    ],
  },
  { name: "surface", seeded: true, steps: [{ op: "connect", warns: [EMULATOR_WARNING] }, { op: "surface" }] },
  {
    name: "empty",
    seeded: false,
    steps: [{ op: "connect", warns: [EMULATOR_WARNING, "creates any project and database on demand"] }],
  },
  {
    name: "datastore",
    seeded: false,
    databaseMode: "datastore-mode",
    steps: [{ op: "connect", refused: "Datastore mode" }],
  },
]);

export const FIRESTORE_CONFORMANCE: ObjectSurfaceExpectation = Object.freeze({
  containers: [],
  kinds: { collection: TOP_LEVEL.length },
  sampleObject: { path: ["users"], kind: "collection" },
  // A document id the seed never writes: the Source tab raises a not-found sentence that names the path.
  absentSource: { path: ["users/ghost"], kind: "document" },
  keyBrowserSample: { path: ["users/alice"], kind: "document" },
  // The one listed kind, `collection`, declares columns; `document` is enumerated by the Keys panel only.
  noAbstainingKinds: true,
});

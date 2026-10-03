/**
 * The vector family's fixtures (tests/fixtures/vector/, captured by tests/live/vector-evidence.ts; vector-family
 * spec 7.3 and 8.2): the directories are exactly the catalog, every capture says which build answered it and holds
 * no credential, the seeds' manifests hold what the seeds' rules need, and the measured claims the shared suites
 * read hold: (3,4) against the origin answers 25.0 with Milvus L2 and 5.0 with Qdrant Euclid, Qdrant prints a
 * non-finite score as null, Milvus REST answers it with an empty body, and the derived Milvus score is Infinity.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { quoteUnsafeIntegers } from "@/lib/db/utils/json-integers";
import {
  expectedMilvusCells,
  expectedQdrantCells,
  type MilvusManifest,
  type QdrantManifest,
} from "../../../live/vector-evidence-derive";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DIR = path.join(ROOT, "tests/fixtures/vector");
const parse = (text: string): unknown => JSON.parse(quoteUnsafeIntegers(text));
const read = (name: string): unknown => parse(readFileSync(path.join(DIR, name), "utf8"));

const MILVUS_COLLECTIONS = [
  "default-docs_int64",
  "default-docs_varchar",
  "default-edge_values",
  "default-emb_list",
  "default-fts",
  "default-large_topk",
  "default-pk_partitioned",
  "default-scratch",
  "default-shadowed",
  "default-unloaded_big",
  "default-wide_768",
  "probe_db-notes",
];
const QDRANT_COLLECTIONS = ["docs", "edge_values", "empty_novec", "payload_spread", "plain", "scratch", "small_dtypes"];
const DERIVED = ["expected-cells", "expected-fields", "manifest"];

const CATALOG: Readonly<Record<"milvus" | "qdrant", readonly string[]>> = {
  milvus: [
    ...DERIVED,
    ...MILVUS_COLLECTIONS.map((name) => `describe-${name}`),
    "query-docs_int64",
    "query-docs_varchar",
    "query-edge_values",
    "query-emb_list",
    "search-bm25",
    "search-cosine",
    "search-hamming-binary",
    "search-ip-bfloat16",
    "search-ip-sparse",
    "search-l2-float16",
    "search-l2-int8",
    "search-l2-origin",
    "search-max-sim",
    "search-non-finite",
  ],
  qdrant: [
    ...DERIVED,
    "aliases",
    ...QDRANT_COLLECTIONS.map((name) => `describe-${name}`),
    "retrieve-edge_values",
    "retrieve-plain",
    "retrieve-small_dtypes",
    "root",
    "scroll-docs",
    "search-cosine",
    "search-dot",
    "search-euclid",
    "search-euclid-origin",
    "search-manhattan",
    "search-multivector",
    "search-non-finite",
    "search-sparse",
  ],
};

const BUILDS: Readonly<Record<"milvus" | "qdrant", { image: string; digest: string; version: string }>> = {
  milvus: {
    image: "milvusdb/milvus:v3.0.2",
    digest: "sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0",
    version: "3.0.2",
  },
  qdrant: {
    image: "ghcr.io/qdrant/qdrant/qdrant:v1.19.1",
    digest: "sha256:808d42530f48a2b88abe960165ffe81e9ec71f505d72e6404145444e0e085822",
    version: "1.19.1",
  },
};

interface Captured {
  readonly $captured: {
    readonly engine: string;
    readonly image: string;
    readonly digest: string;
    readonly version: string;
    readonly date: string;
    readonly runtime: string;
    readonly surface: string;
    readonly request: { readonly method: string; readonly path: string; readonly headers: Record<string, string> };
  };
  readonly outcome: string;
  readonly payload: { readonly status: number; readonly bodyBytes: number; readonly body: string };
}

function captures(engine: "milvus" | "qdrant"): Array<[string, Captured]> {
  return CATALOG[engine]
    .filter((name) => !DERIVED.includes(name))
    .map((name) => [name, read(`${engine}/${name}.json`) as Captured]);
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)],
  );
}

describe("the vector fixtures", () => {
  test("each engine's directory is exactly the catalog", () => {
    for (const engine of ["milvus", "qdrant"] as const) {
      const onDisk = readdirSync(path.join(DIR, engine))
        .map((file) => file.replace(/\.json$/, ""))
        .sort();
      expect({ engine, files: onDisk }).toEqual({ engine, files: [...CATALOG[engine]].sort() });
    }
  });

  test("every capture names the pinned build, the server version, the date and the runtime, and calls one surface", () => {
    for (const engine of ["milvus", "qdrant"] as const) {
      for (const [name, capture] of captures(engine)) {
        expect({
          name,
          engine: capture.$captured.engine,
          image: capture.$captured.image,
          digest: capture.$captured.digest,
          version: capture.$captured.version,
        }).toEqual({ name, engine, ...BUILDS[engine] });
        expect(capture.$captured.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(capture.$captured.runtime).toMatch(/^(bun|node) \d/);
        expect(capture.$captured.surface.length).toBeGreaterThan(0);
        expect(["pass", "fail", "empty-body"]).toContain(capture.outcome);
      }
    }
  });

  test("no file holds the credential the harness sent, a key or a certificate", () => {
    const token = "root:Milvus";
    for (const file of filesUnder(DIR)) {
      const text = readFileSync(file, "utf8");
      const where = path.relative(ROOT, file);
      expect({ where, token: text.includes(token) }).toEqual({ where, token: false });
      expect({ where, base64: text.includes(Buffer.from(token).toString("base64")) }).toEqual({ where, base64: false });
      expect({ where, value: /\\?"Milvus\\?"/.test(text) }).toEqual({ where, value: false });
      expect({ where, key: /-----BEGIN|PRIVATE KEY/.test(text) }).toEqual({ where, key: false });
    }
    for (const [name, capture] of captures("milvus")) {
      expect({ name, headers: capture.$captured.request.headers }).toEqual({
        name,
        headers: { authorization: "<token>" },
      });
    }
  });

  test("(3,4) against the origin answers 25.0 with Milvus L2, the squared distance, and 5.0 with Qdrant Euclid", () => {
    const milvus = parse((read("milvus/search-l2-origin.json") as Captured).payload.body) as {
      data: { distance: number }[];
    };
    const qdrant = parse((read("qdrant/search-euclid-origin.json") as Captured).payload.body) as {
      result: { points: { score: number }[] };
    };
    expect(milvus.data[0].distance).toBe(25);
    expect(qdrant.result.points[0].score).toBe(5);
  });

  test("a non-finite score: Milvus REST answers HTTP 200 with an empty body, Qdrant prints null", () => {
    const milvus = read("milvus/search-non-finite.json") as Captured;
    expect(milvus.outcome).toBe("empty-body");
    expect(milvus.payload).toEqual({ status: 200, bodyBytes: 0, body: "" });
    const qdrant = read("qdrant/search-non-finite.json") as Captured;
    expect(
      (parse(qdrant.payload.body) as { result: { points: { score: unknown }[] } }).result.points[0].score,
    ).toBeNull();
  });

  test("the README renders every generated block, and every command names the compose project and its services", () => {
    const readme = readFileSync(path.join(DIR, "README.md"), "utf8");
    for (const block of ["provenance", "cross-check", "catalog"]) {
      expect(readme).toMatch(new RegExp(`<!-- generated:${block} -->\\n\\|`));
    }
    const commands = readme.split("\n").filter((line) => line.startsWith("docker compose"));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toMatch(/^docker compose -p libredb-studio -f database-compose\.yml up -d (--wait )?[a-z]/);
    }
  });

  test("the expected scores: Infinity derived for Milvus from the manifest, null as Qdrant printed it", () => {
    const scores = read("expected-scores.json") as {
      milvus: { score: string; doubleSelfInnerProduct: number; cell: Record<string, number> };
      qdrant: { printed: unknown };
    };
    expect(scores.milvus.score).toBe("Infinity");
    expect(scores.milvus.cell).toEqual({ "1": 3.3999999521443642e38 });
    expect(scores.milvus.doubleSelfInnerProduct).toBeGreaterThan(3.4028234663852886e38);
    expect(scores.qdrant.printed).toBeNull();
  });
});

interface MilvusManifestJson {
  readonly server_version: string;
  readonly databases: Record<
    string,
    Record<string, { rows: number; loaded: boolean; num_partitions: number | null; properties: Record<string, string> }>
  >;
}

interface QdrantManifestJson {
  readonly collections: Record<
    string,
    { points: number; aliases: string[]; payload_keys?: Record<string, { points: number; types: string[] }> }
  >;
}

/** What every manifest records of the build it was printed from (vector-family spec 7.3), beside its contents. */
interface ManifestBuildJson {
  readonly image: string;
  readonly digest: string;
  readonly server_version: string;
  readonly date: string;
}

describe("the seeds' manifests", () => {
  test("each names the pinned build it was printed from and its date, which comes before the engine's first capture", () => {
    for (const engine of ["milvus", "qdrant"] as const) {
      const manifest = read(`${engine}/manifest.json`) as ManifestBuildJson;
      expect({ engine, image: manifest.image, digest: manifest.digest, version: manifest.server_version }).toEqual({
        engine,
        ...BUILDS[engine],
      });
      expect(manifest.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const first = captures(engine)
        .map(([, capture]) => capture.$captured.date)
        .sort()[0];
      expect({ engine, printedFirst: manifest.date <= first }).toEqual({ engine, printedFirst: true });
    }
  });

  test("Milvus holds the research's objects and the ones the fixtures add, each with its row count and load state", () => {
    const manifest = read("milvus/manifest.json") as MilvusManifestJson;
    const rows = Object.fromEntries(
      Object.entries(manifest.databases).flatMap(([database, collections]) =>
        Object.entries(collections).map(([name, collection]) => [
          `${database}.${name}`,
          [collection.rows, collection.loaded],
        ]),
      ),
    );
    expect(rows).toEqual({
      "default.docs_int64": [2000, true],
      "default.docs_varchar": [500, true],
      "default.edge_values": [5, true],
      "default.emb_list": [3, true],
      "default.fts": [200, true],
      "default.large_topk": [100, true],
      "default.pk_partitioned": [2000, true],
      "default.scratch": [0, true],
      "default.shadowed": [6, true],
      "default.unloaded_big": [50000, false],
      "default.wide_768": [1000, true],
      "probe_db.notes": [100, true],
    });
    expect(manifest.databases.default.pk_partitioned.num_partitions).toBe(1024);
    expect(manifest.databases.default.large_topk.properties).toEqual({ query_mode: "large_topk" });
  });

  test("Qdrant holds the research's objects, edge_values and payload_spread, with the payload spread the sample rules need", () => {
    const manifest = read("qdrant/manifest.json") as QdrantManifestJson;
    expect(Object.fromEntries(Object.entries(manifest.collections).map(([name, c]) => [name, c.points]))).toEqual({
      docs: 2000,
      edge_values: 3,
      empty_novec: 0,
      payload_spread: 20000,
      plain: 300,
      scratch: 0,
      small_dtypes: 200,
    });
    expect(manifest.collections.docs.aliases).toEqual(["docs_alias"]);
    expect(manifest.collections.plain.aliases).toEqual(["plain_alias"]);
    const keys = manifest.collections.payload_spread.payload_keys ?? {};
    expect(keys.attr_0).toEqual({ points: 400, types: ["string"] });
    expect(keys.legacy_code).toEqual({ points: 200, types: ["string"] });
    expect(keys.rare_flag).toEqual({ points: 20, types: ["bool"] });
    expect(keys.variant).toEqual({ points: 20000, types: ["integer", "string"] });
    expect(keys.price).toEqual({ points: 20000, types: ["float", "integer"] });
  });
});

interface ExpectedField {
  readonly name: string;
  readonly kind: string;
  readonly dtype: string;
  readonly dimension: number | null;
  readonly metric: string | null;
  readonly indexKind: string | null;
}

describe("the derived files", () => {
  const milvusFields = (read("milvus/expected-fields.json") as { fields: Record<string, ExpectedField[]> }).fields;
  const qdrantFields = (read("qdrant/expected-fields.json") as { fields: Record<string, ExpectedField[]> }).fields;

  test("every expected field uses the family's closed sets", () => {
    for (const field of [...Object.values(milvusFields), ...Object.values(qdrantFields)].flat()) {
      expect(["dense", "sparse", "multi"]).toContain(field.kind);
      expect(["float32", "float64", "float16", "bfloat16", "int8", "uint8", "binary"]).toContain(field.dtype);
      expect([
        "cosine",
        "euclidean",
        "euclidean_squared",
        "dot",
        "manhattan",
        "hamming",
        "jaccard",
        "other",
        null,
      ]).toContain(field.metric);
      expect(["hnsw", "flat", "ivf", "graph_other", "opaque", null]).toContain(field.indexKind);
    }
  });

  test("Milvus L2 is euclidean_squared and Qdrant Euclid is euclidean, never the other's", () => {
    const l2 = Object.values(milvusFields)
      .flat()
      .filter((field) => field.metric?.startsWith("euclidean"));
    expect(l2.length).toBeGreaterThan(0);
    for (const field of l2) expect(field.metric).toBe("euclidean_squared");
    const euclid = Object.values(qdrantFields)
      .flat()
      .filter((field) => field.metric?.startsWith("euclidean"));
    expect(euclid.length).toBeGreaterThan(0);
    for (const field of euclid) expect(field.metric).toBe("euclidean");
  });

  test("every vector type has its expected field: Milvus binary counts bits, a sparse vector has no dimension", () => {
    expect(milvusFields["default/docs_varchar"].map((field) => [field.name, field.dtype, field.dimension])).toEqual([
      ["f16", "float16", 8],
      ["bf16", "bfloat16", 8],
      ["bin", "binary", 16],
      ["sparse", "float32", null],
      ["i8", "int8", 8],
    ]);
    expect(milvusFields["default/fts"]).toEqual([
      expect.objectContaining({ name: "text_sparse", kind: "sparse", metric: "other", nativeMetric: "BM25" }),
    ]);
    expect(qdrantFields.docs.map((field) => [field.name, field.kind])).toEqual([
      ["text", "dense"],
      ["image", "dense"],
      ["colbert", "multi"],
      ["keywords", "sparse"],
    ]);
    expect(qdrantFields.empty_novec).toEqual([]);
  });

  test("Milvus sparse cells are index maps and Qdrant's are {indices, values}; a float16 overflow stays null", () => {
    const milvusCells = (read("milvus/expected-cells.json") as { cells: { kind: string; cell: unknown }[] }).cells;
    for (const cell of milvusCells.filter((entry) => entry.kind === "sparse")) {
      expect(Array.isArray(cell.cell)).toBe(false);
      expect(Object.keys(cell.cell as object)).not.toContain("indices");
    }
    const qdrantCells = (
      read("qdrant/expected-cells.json") as {
        cells: { collection: string; field: string; kind: string; match: { value: unknown }; cell: unknown }[];
      }
    ).cells;
    for (const cell of qdrantCells.filter((entry) => entry.kind === "sparse" && entry.cell !== null)) {
      const { indices, values } = cell.cell as { indices: number[]; values: number[] };
      expect(indices.length).toBe(values.length);
    }
    const overflow = qdrantCells.find(
      (entry) => entry.collection === "edge_values" && entry.field === "f16" && entry.match.value === 2,
    );
    expect(overflow?.cell).toEqual([null, 1, 2, 3]);
  });

  test("the committed expected cells are exactly what the manifests derive, signed zeros included", () => {
    const milvus = read("milvus/expected-cells.json") as { cells: unknown; excluded: unknown };
    const qdrant = read("qdrant/expected-cells.json") as { cells: unknown; excluded: unknown };
    const fromMilvus = expectedMilvusCells(read("milvus/manifest.json") as MilvusManifest);
    const fromQdrant = expectedQdrantCells(read("qdrant/manifest.json") as QdrantManifest);
    expect({ cells: milvus.cells, excluded: milvus.excluded }).toEqual({ ...fromMilvus });
    expect({ cells: qdrant.cells, excluded: qdrant.excluded }).toEqual({ ...fromQdrant });
    const edge = (
      milvus.cells as { collection: string; field: string; match: { value: unknown }; cell: number[] }[]
    ).find((entry) => entry.collection === "default/edge_values" && entry.field === "f32" && entry.match.value === 3);
    expect(Object.is(edge?.cell[0], -0)).toBe(true);
  });

  test("the excluded fields are named with their reasons", () => {
    const excluded = (name: string) =>
      (read(name) as { excluded: { collection: string; field: string }[] }).excluded.map(
        (entry) => `${entry.collection}.${entry.field}`,
      );
    expect(excluded("milvus/expected-cells.json")).toEqual(["default/fts.text_sparse"]);
    expect(excluded("qdrant/expected-cells.json").sort()).toEqual([
      "docs.text",
      "scratch.",
      "small_dtypes.f16",
      "small_dtypes.t4",
    ]);
  });
});

describe("the Milvus embedding list (spec 3.3)", () => {
  interface DescribeAnswer {
    readonly data: { readonly indexes: readonly { readonly fieldName: string; readonly metricType: string }[] };
  }
  const fields = (read("milvus/expected-fields.json") as { fields: Record<string, ExpectedField[]> }).fields;
  const nativeMetric = (field: ExpectedField) =>
    (field as ExpectedField & { nativeMetric: string | null }).nativeMetric;

  test("chunks[emb] is a float32 multivector of dimension 4, scored by the MAX_SIM metric its describe capture names", () => {
    const described = parse((read("milvus/describe-default-emb_list.json") as Captured).payload.body) as DescribeAnswer;
    const captured = described.data.indexes.find((index) => index.fieldName === "chunks[emb]")?.metricType;
    expect(captured).toStartWith("MAX_SIM");
    const field = fields["default/emb_list"].find((entry) => entry.name === "chunks[emb]") as ExpectedField;
    expect([field.kind, field.dtype, field.dimension, field.metric, nativeMetric(field)]).toEqual([
      "multi",
      "float32",
      4,
      "other",
      captured,
    ]);
  });

  test("every emb_list row has a multivector cell equal to the struct array REST answered, element by element", () => {
    const cells = (
      read("milvus/expected-cells.json") as {
        cells: { collection: string; field: string; kind: string; match: { value: unknown }; cell: number[][] }[];
      }
    ).cells.filter((entry) => entry.collection === "default/emb_list" && entry.kind === "multi");
    expect(cells.map((entry) => entry.match.value)).toEqual([1, 2, 3]);
    const rows = (
      parse((read("milvus/query-emb_list.json") as Captured).payload.body) as {
        data: { id: number; chunks: { emb: number[] }[] }[];
      }
    ).data;
    for (const cell of cells) {
      const row = rows.find((entry) => entry.id === cell.match.value);
      expect({ id: cell.match.value, cell: cell.cell }).toEqual({
        id: cell.match.value,
        cell: row?.chunks.map((element) => element.emb),
      });
    }
  });

  test("the MAX_SIM search of id 3's embedding list ranks id 3 first", () => {
    const capture = read("milvus/search-max-sim.json") as Captured;
    expect(capture.outcome).toBe("pass");
    const hits = (parse(capture.payload.body) as { data: { id: number; distance: number }[] }).data;
    expect(hits[0].id).toBe(3);
    expect(hits.map((hit) => hit.distance)).toEqual([...hits.map((hit) => hit.distance)].sort((a, b) => b - a));
  });
});

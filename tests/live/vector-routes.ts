/**
 * Writes tests/fixtures/vector/routes/ from the two pinned sources (tests/live/vector-route-tables.ts), refusing a
 * source whose sha256 is not the pinned one, so the files are a function of those two inputs alone.
 *
 * Run by hand, never by `bun run test`:
 *   bun tests/live/vector-routes.ts --tsv <rest-summary-v3.0.x.tsv> --openapi <qdrant v1.19.1 openapi.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  MILVUS_PREFIX,
  MILVUS_TSV_SHA256,
  milvusRoutesFromTsv,
  QDRANT_SPEC_SHA256,
  qdrantRoutesFromOpenApi,
  type RouteTable,
  sha256Hex,
} from "./vector-route-tables";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/vector/routes");
const BY = "tests/live/vector-routes.ts";
const MILVUS_SOURCE =
  "rest-summary-v3.0.x.tsv: one row per endpoint of Milvus's REST reference, milvus-io/web-content v3.0.x at 78d9def7";
const QDRANT_SOURCE = "github.com/qdrant/qdrant docs/redoc/master/openapi.json at tag v1.19.1";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} <file> is required`);
  return value;
}

function pinned(file: string, sha256: string): string {
  const text = readFileSync(file, "utf8");
  const found = sha256Hex(text);
  if (found !== sha256) throw new Error(`${file} has the sha256 ${found}, not the pinned ${sha256}: nothing written`);
  return text;
}

function write(name: string, table: RouteTable): void {
  writeFileSync(path.join(OUT, name), `${JSON.stringify(table, null, 2)}\n`);
}

const tsv = pinned(argument("--tsv"), MILVUS_TSV_SHA256);
const openapi = JSON.parse(pinned(argument("--openapi"), QDRANT_SPEC_SHA256)) as unknown;
const milvus = milvusRoutesFromTsv(tsv);
const qdrantV1 = qdrantRoutesFromOpenApi(openapi, "v1");
const qdrantFull = qdrantRoutesFromOpenApi(openapi, "full");
mkdirSync(OUT, { recursive: true });
write("milvus-v1.json", {
  $generated: { by: BY, source: MILVUS_SOURCE, sha256: MILVUS_TSV_SHA256, scope: "v1" },
  engine: "milvus",
  prefix: MILVUS_PREFIX,
  routes: milvus,
});
write("qdrant-v1.json", {
  $generated: { by: BY, source: QDRANT_SOURCE, sha256: QDRANT_SPEC_SHA256, scope: "v1" },
  engine: "qdrant",
  prefix: "/",
  routes: qdrantV1,
});
write("qdrant-full.json", {
  $generated: { by: BY, source: QDRANT_SOURCE, sha256: QDRANT_SPEC_SHA256, scope: "full" },
  engine: "qdrant",
  prefix: "/",
  routes: qdrantFull,
});
console.error(
  `wrote ${milvus.length} Milvus routes, ${qdrantV1.length} Qdrant v1 routes and ${qdrantFull.length} Qdrant routes`,
);

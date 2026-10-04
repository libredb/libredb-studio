/**
 * Writes tests/fixtures/qdrant/openapi-schemas.json from the two pinned sources (tests/live/qdrant-openapi-derive.ts),
 * refusing a source whose sha256 is not the pinned one, so the file is a function of those two inputs alone.
 *
 * Run by hand, never by `bun run test`; it runs whole whenever it is loaded and exports nothing:
 *   bun tests/live/qdrant-openapi.ts --openapi <qdrant v1.19.1 openapi.json> --local-model <local_model.rs at v1.19.1>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { QDRANT_LOCAL_MODEL_SHA256, qdrantFactsFile } from "./qdrant-openapi-derive";
import { QDRANT_SPEC_SHA256, sha256Hex } from "./vector-route-tables";

const OUT = path.resolve(import.meta.dirname, "../fixtures/qdrant");

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

const openapi = JSON.parse(pinned(argument("--openapi"), QDRANT_SPEC_SHA256)) as unknown;
const localModel = pinned(argument("--local-model"), QDRANT_LOCAL_MODEL_SHA256);
const facts = qdrantFactsFile(openapi, localModel);
mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, "openapi-schemas.json"), `${JSON.stringify(facts, null, 2)}\n`);
console.error(
  `wrote ${Object.keys(facts.operations).length} operations, ${Object.keys(facts.objects).length} objects, ` +
    `${Object.keys(facts.unions).length} unions, ${Object.keys(facts.enums).length} enumerations and ` +
    `${facts.localModels.length} local model names`,
);

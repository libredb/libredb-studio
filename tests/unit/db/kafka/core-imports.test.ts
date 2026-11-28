/**
 * Kafka's record of its core imports (docs/PROVIDER_IMPORTS.md, "Kafka's core imports"): every symbol Kafka's provider
 * directory imports from core has a row that says it leaves with the legacy class, every symbol the record sends
 * to an SDK subpath is imported from there and no longer from core, and every symbol the directory imports from the
 * SDK has a row that names the specifier it is imported from.
 * So the core modules the directory imports are exactly the modules of the rows that leave, which is what #2623's
 * oracle, the directory's `from "@/..."` specifiers, reads.
 * The mechanism is engine-free, in tests/unit/lib/db/provider-imports/legacy-homes.ts; this case is Kafka's and leaves
 * with Kafka's directory.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  directoryImports,
  homeRecordFindings,
  RECORD_FILE,
  tableRows,
} from "../../lib/db/provider-imports/legacy-homes";
import { isSourcePath } from "../../lib/db/provider-imports/scan";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const KAFKA_DIRECTORY = "src/lib/db/providers/stream/kafka/";
const HEADER = "| Module | Symbol | Kafka's contract-form home | Kafka imports it from |";
const REAL_TREE_TIMEOUT = 30_000;

describe("kafka's core imports", () => {
  test(
    "Kafka's provider imports from core only what leaves with the legacy class",
    () => {
      const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      const listed = new Set(output.split("\0").filter((path) => path !== "" && existsSync(join(ROOT, path))));
      const files = [...listed]
        .filter((path) => path.startsWith(KAFKA_DIRECTORY) && isSourcePath(path))
        .map((path) => ({ path, text: readFileSync(join(ROOT, path), "utf8") }));
      const rows = tableRows(readFileSync(join(ROOT, RECORD_FILE), "utf8"), HEADER);

      expect(files.length).toBeGreaterThan(0);
      expect(homeRecordFindings(rows, directoryImports(files, KAFKA_DIRECTORY, listed))).toEqual([]);
    },
    REAL_TREE_TIMEOUT,
  );
});

/**
 * The seams of the S3 provider directory: no file imports another provider's
 * directory, an AWS SDK package, `minio`, `fast-xml-parser` or any XML package; `node:crypto` is imported only by
 * sigv4.ts; `createNodeByteTransport` is named only by index.ts, as the default of `deps.createTransport`; no file
 * names `plaintextSecretRefusal`, whose sentence says a password would cross the network, which is false under SigV4;
 * and no file defines a byte-size formatter, because the shared `formatBytes` exists.
 * Proven both ways: the real sources pass, and each planted line fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const S3_DIR = join(ROOT, "src/lib/db/providers/objectstore/s3");
const PROVIDERS_DIR = join(ROOT, "src/lib/db/providers");

const SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;
const LIBRARY = /^(?:@aws-sdk\/|aws-sdk$|aws4|minio$|fast-xml-parser$)/;
const BYTE_FORMATTER = /\b(?:function\s+|const\s+|let\s+)(?:humanSize|formatBytes|formatSize)\b/;

/** Every .ts file under the directory, as a path relative to it ("index.ts", "console/execute.ts"). */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [relative(S3_DIR, path)] : [];
  });
}

function specifiers(source: string): string[] {
  return [...source.matchAll(SPECIFIER)].map((match) => match[1] ?? match[2] ?? match[3]);
}

/** Whether a specifier reaches a provider directory other than this one. */
function reachesAnotherProvider(file: string, specifier: string): boolean {
  let target: string;
  if (specifier.startsWith("@/")) target = join(ROOT, "src", specifier.slice(2));
  else if (specifier.startsWith(".")) target = resolve(dirname(join(S3_DIR, file)), specifier);
  else return false;
  return target.startsWith(`${PROVIDERS_DIR}/`) && target !== S3_DIR && !target.startsWith(`${S3_DIR}/`);
}

function findings(file: string, source: string): string[] {
  const found: string[] = [];
  for (const specifier of specifiers(source)) {
    if (reachesAnotherProvider(file, specifier))
      found.push(`${file} imports ${specifier}, another provider's directory`);
    const bare = !specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("node:");
    if (bare && (LIBRARY.test(specifier) || /xml/i.test(specifier)))
      found.push(`${file} imports ${specifier}, an S3 or XML library`);
    if (specifier === "node:crypto" && file !== "sigv4.ts")
      found.push(`${file} imports node:crypto, which only sigv4.ts may`);
  }
  if (file !== "index.ts" && /\bcreateNodeByteTransport\b/.test(source))
    found.push(
      `${file} names createNodeByteTransport, which only index.ts may, as the default of deps.createTransport`,
    );
  if (/\bplaintextSecretRefusal\b/.test(source))
    found.push(`${file} names plaintextSecretRefusal; S3 decides plain HTTP with isLoopbackHost`);
  if (BYTE_FORMATTER.test(source))
    found.push(`${file} defines a byte-size formatter; import formatBytes from @/lib/db/utils/pool-manager`);
  return found;
}

describe("the S3 provider directory's seams", () => {
  test("every source file passes", () => {
    const files = sourceFiles(S3_DIR);
    expect(files).toContain("constants.ts");
    expect(files.flatMap((file) => findings(file, readFileSync(join(S3_DIR, file), "utf8")))).toEqual([]);
  });

  test.each([
    [
      'import { OXIA_TYPE } from "@/lib/db/providers/keyvalue/oxia/constants";\n',
      "names.ts",
      "names.ts imports @/lib/db/providers/keyvalue/oxia/constants, another provider's directory",
    ],
    [
      'import { x } from "../../keyvalue/oxia/values";\n',
      "names.ts",
      "names.ts imports ../../keyvalue/oxia/values, another provider's directory",
    ],
    [
      'import { S3Client } from "@aws-sdk/client-s3";\n',
      "client.ts",
      "client.ts imports @aws-sdk/client-s3, an S3 or XML library",
    ],
    ['import { Client } from "minio";\n', "client.ts", "client.ts imports minio, an S3 or XML library"],
    [
      'import { XMLParser } from "fast-xml-parser";\n',
      "xml.ts",
      "xml.ts imports fast-xml-parser, an S3 or XML library",
    ],
    ['import sax from "sax-xml";\n', "xml.ts", "xml.ts imports sax-xml, an S3 or XML library"],
    [
      'import { createHash } from "node:crypto";\n',
      "client.ts",
      "client.ts imports node:crypto, which only sigv4.ts may",
    ],
    [
      'import { createNodeByteTransport } from "@/lib/db/http/node-transport";\n',
      "client.ts",
      "client.ts names createNodeByteTransport, which only index.ts may, as the default of deps.createTransport",
    ],
    [
      'import { plaintextSecretRefusal } from "@/lib/db/http/endpoint";\n',
      "connection-options.ts",
      "connection-options.ts names plaintextSecretRefusal; S3 decides plain HTTP with isLoopbackHost",
    ],
    [
      "function formatBytes(n: number) { return `${n} B`; }\n",
      "key-scan.ts",
      "key-scan.ts defines a byte-size formatter; import formatBytes from @/lib/db/utils/pool-manager",
    ],
  ])("a planted %p in %s fails by name", (planted, file, finding) => {
    expect(findings(file, planted)).toEqual([finding]);
  });

  test("the sibling modules of this directory and the shared code are not findings", () => {
    const source = [
      'import { objectPath } from "./encoding";',
      'import { s3Refusal } from "./console/guard";',
      'import { formatBytes } from "@/lib/db/utils/pool-manager";',
      'import { createHash } from "node:crypto";',
    ].join("\n");
    expect(findings("sigv4.ts", source)).toEqual([]);
    expect(findings("console/execute.ts", 'import { S3_TYPE } from "../constants";')).toEqual([]);
  });
});

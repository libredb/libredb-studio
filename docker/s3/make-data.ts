/**
 * The deterministic generator of the S3 seed's own sample files (docker/s3/README.md).
 *
 * It writes only what tests/fixtures/s3/preview/ (the committed preview fixtures, written by their generate.ts) does not
 * provide, and last docker/s3/data/SHA256SUMS, which also holds the derived digest of the multipart object the seed
 * assembles from one-mib.bin. It is the only writer of docker/s3/data/. Run it from the repository root:
 *
 *   bun docker/s3/make-data.ts
 *
 * utf8-boundary.txt follows the provider's text read cap, so a change of S3_PREVIEW_LIMITS.textFetchBytes that was
 * not regenerated fails tests/unit/db/s3/live-environment.test.ts.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { S3_PREVIEW_LIMITS } from "@/lib/db/providers/objectstore/s3/constants";

const ROOT = path.resolve(import.meta.dir, "../..");
const OUT = path.join(ROOT, "docker/s3/data");
const MIB = 1024 * 1024;
const TWO_MIB = 2 * MIB;
const encoder = new TextEncoder();

/** 1 MiB of a fixed pattern: byte i is (i * 31 + 7) mod 256. */
function oneMib(): Uint8Array {
  const bytes = new Uint8Array(MIB);
  for (let i = 0; i < MIB; i++) bytes[i] = (i * 31 + 7) & 0xff;
  return bytes;
}

/** 4,096 bytes, 0x00 to 0xff repeated. */
function noext(): Uint8Array {
  return Uint8Array.from({ length: 4096 }, (_, i) => i & 0xff);
}

/** One JSON array of at most 2 MiB, valid as a whole, larger than the preview reads. */
function truncatedJson(): Uint8Array {
  const parts = ["["];
  let length = 1;
  for (let i = 0; ; i++) {
    const entry = `${i === 0 ? "" : ","}{"i":${i},"s":"row ${i}"}`;
    if (length + entry.length + 1 > TWO_MIB) break;
    parts.push(entry);
    length += entry.length;
  }
  parts.push("]");
  return encoder.encode(parts.join(""));
}

/** NDJSON lines up to 2 MiB, so the preview's read cuts the last line it reaches. */
function rowsPartial(): Uint8Array {
  const lines: string[] = [];
  let length = 0;
  for (let i = 0; ; i++) {
    const line = `{"i":${i},"s":"row ${i}"}\n`;
    if (length + line.length > TWO_MIB) break;
    lines.push(line);
    length += line.length;
  }
  return encoder.encode(lines.join(""));
}

/** gzip, level 9, no file name and no time, of 64 MiB of the 8-byte line {"a":0}\n. */
function bomb(): Uint8Array {
  const line = encoder.encode('{"a":0}\n');
  const plain = new Uint8Array(64 * MIB);
  for (let at = 0; at < plain.length; at += line.length) plain.set(line, at);
  return gzipSync(plain, { level: 9 });
}

/** Text whose 4-byte character starts 2 bytes before the text read cap. */
function utf8Boundary(cap: number): Uint8Array {
  return encoder.encode(`${"a".repeat(cap - 2)}\u{1F600}\nend\n`);
}

/** The committed preview fixture fx-zstd.parquet without its last 512 bytes, read and never regenerated. */
function truncatedParquet(): Uint8Array {
  const whole = readFileSync(path.join(ROOT, "tests/fixtures/s3/preview/fx-zstd.parquet"));
  return new Uint8Array(whole.subarray(0, whole.length - 512));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const one = oneMib();
const files: Readonly<Record<string, Uint8Array>> = {
  "bomb.ndjson.gz": bomb(),
  noext: noext(),
  "one-mib.bin": one,
  "rows-partial.ndjson": rowsPartial(),
  "truncated.json": truncatedJson(),
  "truncated.parquet": truncatedParquet(),
  "utf8-boundary.txt": utf8Boundary(S3_PREVIEW_LIMITS.textFetchBytes),
};
const six = new Uint8Array(one.length * 6);
for (let part = 0; part < 6; part++) six.set(one, part * one.length);

mkdirSync(OUT, { recursive: true });
const lines: string[] = [];
for (const name of Object.keys(files).sort()) {
  writeFileSync(path.join(OUT, name), files[name]);
  lines.push(`${sha256(files[name])}  ${name}`);
}
lines.push(`${sha256(six)}  derived/multipart.bin`);
writeFileSync(path.join(OUT, "SHA256SUMS"), `${lines.join("\n")}\n`);
console.log(`make-data.ts: ${Object.keys(files).length} files and SHA256SUMS in docker/s3/data`);

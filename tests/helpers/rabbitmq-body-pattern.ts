/**
 * The fixed body pattern of the RabbitMQ fixture's large messages: SHA-256 counter blocks, block i being
 * SHA-256(`<label>:<i>`), cut to the size. The seed publishes these bytes, and the evidence harness computes each
 * body's expected SHA-256 from the label and the size alone, so the digest proven over the provider's no-copy path
 * needs no seed output.
 */
import { createHash } from "node:crypto";

const BLOCK = 32;

function block(label: string, index: number): Buffer {
  return createHash("sha256").update(`${label}:${index}`).digest();
}

/** The pattern's first `size` bytes. */
export function patternBytes(label: string, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index * BLOCK < size; index++) {
    out.set(block(label, index).subarray(0, Math.min(BLOCK, size - index * BLOCK)), index * BLOCK);
  }
  return out;
}

/** The hex SHA-256 of `patternBytes(label, size)`, computed block by block without holding the body. */
export function patternSha256(label: string, size: number): string {
  const digest = createHash("sha256");
  for (let index = 0; index * BLOCK < size; index++) {
    digest.update(block(label, index).subarray(0, Math.min(BLOCK, size - index * BLOCK)));
  }
  return digest.digest("hex");
}

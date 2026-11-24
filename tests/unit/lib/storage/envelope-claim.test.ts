/**
 * `isEnvelopeClaim`, the shape rule (D4) that tells a stored envelope from plaintext without the storage key: a value
 * whose text before the first colon is `v` and digits claims to be an envelope, whatever follows.
 */
import { describe, expect, test } from "bun:test";
import { isEnvelopeClaim } from "@/lib/storage/envelope-claim";

describe("isEnvelopeClaim", () => {
  test("a value whose text before the first colon is v and digits is an envelope claim", () => {
    for (const value of ["v1:a:b", "v2:a:b", "v2:x", "v9:", "v10:a:b:c", "v1"]) {
      expect({ value, claim: isEnvelopeClaim(value) }).toEqual({ value, claim: true });
    }
  });

  test("plaintext with colons and no version tag is not", () => {
    for (const value of ["", "host:5432:db", "postgres://u:p@h/db", "V1:a:b", "v:a:b", "va1:b", " v1:a:b", "x"]) {
      expect({ value, claim: isEnvelopeClaim(value) }).toEqual({ value, claim: false });
    }
  });
});

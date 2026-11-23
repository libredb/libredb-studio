/**
 * The manifest schema is one file, loaded by its digest (docs/providers/CONTRACT.md, clause M-1).
 *
 * `MANIFEST_SCHEMA_SHA256` is generated from the file's bytes, and `compileManifestValidator` hashes the bytes it is
 * given before it reads them, so a host, the kit and a test all validate against exactly the schema this SDK was
 * built with, or fail naming both digests.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  compileManifestValidator,
  MANIFEST_SCHEMA_SHA256,
  ManifestSchemaDigestError,
} from "@libredb/provider-sdk/manifest";
import * as packageRoot from "@libredb/provider-sdk";
import { decodeValue, encodeValue, ValueCodecError } from "@libredb/provider-sdk/values";

const SCHEMA_BYTES = readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"));

describe("the manifest schema digest", () => {
  test("MANIFEST_SCHEMA_SHA256 is the SHA-256 of the schema file's bytes", () => {
    expect(MANIFEST_SCHEMA_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(SCHEMA_BYTES).digest("hex")).toBe(MANIFEST_SCHEMA_SHA256);
  });

  test("the schema file's bytes compile into a validator", () => {
    const validator = compileManifestValidator(SCHEMA_BYTES);

    expect(validator.contract).toBe("0.1");
  });

  test("a schema whose bytes differ is refused before it is parsed, naming both digests", () => {
    // One character changed, and the result is no longer JSON: a parse would throw a SyntaxError, so a
    // ManifestSchemaDigestError proves the digest is checked first.
    const changed = Buffer.from(SCHEMA_BYTES);
    changed[0] = "[".charCodeAt(0);
    changed[changed.length - 2] = "{".charCodeAt(0);
    const actual = createHash("sha256").update(changed).digest("hex");

    let thrown: unknown;
    try {
      compileManifestValidator(changed);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ManifestSchemaDigestError);
    const error = thrown as ManifestSchemaDigestError;
    expect(error.name).toBe("ManifestSchemaDigestError");
    expect(error.expected).toBe(MANIFEST_SCHEMA_SHA256);
    expect(error.actual).toBe(actual);
    expect(error.message).toContain(MANIFEST_SCHEMA_SHA256);
    expect(error.message).toContain(actual);
  });

  test("the package root exports the manifest surface", () => {
    expect(packageRoot.compileManifestValidator).toBe(compileManifestValidator);
    expect(packageRoot.MANIFEST_SCHEMA_SHA256).toBe(MANIFEST_SCHEMA_SHA256);
  });

  test("the package root exports the values surface", () => {
    expect(packageRoot.encodeValue).toBe(encodeValue);
    expect(packageRoot.decodeValue).toBe(decodeValue);
    expect(packageRoot.ValueCodecError).toBe(ValueCodecError);
  });
});

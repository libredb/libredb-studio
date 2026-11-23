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
import { ERROR_KINDS, PROVIDER_ERROR_KINDS, SQLSTATE_PATTERN } from "@libredb/provider-sdk/errors";
import {
  BATCH_MAX_BYTES,
  CALL_REFUSAL_RULES,
  CONSOLE_FACETS,
  checkExecuteRequest,
  checkProviderModule,
  checkRefinement,
  defineProvider,
  encodedRowBytes,
  envReader,
  EXECUTE_REQUEST_FIELDS,
  freezeContext,
  freezeData,
  PAGE_MAX_BYTES,
  pumpPage,
  rowsSource,
  sessionCalls,
} from "@libredb/provider-sdk/calls";

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

  test("the package root exports the errors surface", () => {
    expect(packageRoot.ERROR_KINDS).toBe(ERROR_KINDS);
    expect(packageRoot.PROVIDER_ERROR_KINDS).toBe(PROVIDER_ERROR_KINDS);
    expect(packageRoot.SQLSTATE_PATTERN).toBe(SQLSTATE_PATTERN);
  });

  test("the package root exports the calls surface", () => {
    expect(packageRoot.defineProvider).toBe(defineProvider);
    expect(packageRoot.checkProviderModule).toBe(checkProviderModule);
    expect(packageRoot.envReader).toBe(envReader);
    expect(packageRoot.CONSOLE_FACETS).toBe(CONSOLE_FACETS);
    expect(packageRoot.EXECUTE_REQUEST_FIELDS).toBe(EXECUTE_REQUEST_FIELDS);
    expect(packageRoot.checkExecuteRequest).toBe(checkExecuteRequest);
    expect(packageRoot.checkRefinement).toBe(checkRefinement);
    expect(packageRoot.sessionCalls).toBe(sessionCalls);
    expect(packageRoot.CALL_REFUSAL_RULES).toBe(CALL_REFUSAL_RULES);
    expect(packageRoot.freezeContext).toBe(freezeContext);
    expect(packageRoot.freezeData).toBe(freezeData);
    expect(packageRoot.pumpPage).toBe(pumpPage);
    expect(packageRoot.rowsSource).toBe(rowsSource);
    expect(packageRoot.encodedRowBytes).toBe(encodedRowBytes);
    expect(packageRoot.BATCH_MAX_BYTES).toBe(BATCH_MAX_BYTES);
    expect(packageRoot.PAGE_MAX_BYTES).toBe(PAGE_MAX_BYTES);
  });
});

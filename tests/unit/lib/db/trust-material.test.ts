import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseConfigError } from "@/lib/db/errors";
import { forgetTrustMaterial, trustMaterial, trustMaterialSetting } from "@/lib/db/trust-material";
import { logger } from "@/lib/logger";
import { setExtraCaCerts } from "../../../helpers/extra-ca-certs";

/**
 * NODE_EXTRA_CA_CERTS names the operator's CA bundle. Node.js adds its certificates to every TLS connection it opens
 * without a `ca` of its own, and core reads the same file once per process and keeps its certificate blocks, the trust
 * material, for the providers whose TLS library does not read Node's store (FND-2 slice 4). The first read decides for
 * the life of the process, as Node's own read at start does.
 */
describe("the trust material, read once per process from the file NODE_EXTRA_CA_CERTS names (FND-2 slice 4)", () => {
  const original = process.env.NODE_EXTRA_CA_CERTS;
  const slot = Symbol.for("libredb-studio.trust-material");
  let dir: string;
  let info: ReturnType<typeof spyOn>;

  /** A certificate block with a body made at run time, so no fixture is committed. */
  const block = (): string =>
    ["-----BEGIN CERTIFICATE-----", `MIIB${crypto.randomUUID().replaceAll("-", "")}`, "-----END CERTIFICATE-----"].join(
      "\n",
    );

  function bundle(content: string): string {
    const file = join(dir, "ca-bundle.crt");
    writeFileSync(file, content);
    setExtraCaCerts(file);
    return file;
  }

  /** The refusal `trustMaterial()` throws, read with a plain call. */
  function refusal(): Error {
    try {
      trustMaterial();
    } catch (error) {
      return error as Error;
    }
    throw new Error("expected a refusal");
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-trust-"));
    forgetTrustMaterial();
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    setExtraCaCerts(original);
    rmSync(dir, { recursive: true, force: true });
  });

  test("unset, it is no certificate, and nothing is logged", () => {
    setExtraCaCerts(undefined);
    expect(trustMaterial()).toEqual({ certificates: [] });
    expect(info).not.toHaveBeenCalled();
  });

  test("empty, it is no certificate", () => {
    setExtraCaCerts("");
    expect(trustMaterial()).toEqual({ certificates: [] });
    expect(info).not.toHaveBeenCalled();
  });

  test("a bundle's certificate blocks are kept in the file's order, and the text between them is not", () => {
    const first = block();
    const second = block();
    bundle(
      `# the operator's private CA\n${first}\nsubject=CN=between\n-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n${second}\n`,
    );
    expect(trustMaterial()).toEqual({ certificates: [first, second] });
  });

  test("a bundle that is read is reported once, naming the variable, the file and how many certificates it holds", () => {
    const file = bundle(`${block()}\n${block()}\n`);
    trustMaterial();
    trustMaterialSetting();
    trustMaterial();
    expect(info.mock.calls).toEqual([
      [
        "Studio read 2 CA certificates from NODE_EXTRA_CA_CERTS",
        { route: "trust-material", variable: "NODE_EXTRA_CA_CERTS", path: file, certificates: 2 },
      ],
    ]);
  });

  test("the first read decides for the life of the process, and the outcome lives on globalThis", () => {
    const first = block();
    const file = bundle(`${first}\n`);
    const material = trustMaterial();
    // Direct writes, not the helper: the point is that a change after the first read moves nothing.
    writeFileSync(file, `${block()}\n`);
    process.env.NODE_EXTRA_CA_CERTS = join(dir, "absent.crt");
    expect(trustMaterial()).toBe(material);
    expect(trustMaterial()).toEqual({ certificates: [first] });
    expect((globalThis as Record<symbol, unknown>)[slot]).toEqual({ material, path: file });
  });

  test("a path that cannot be read is refused with its code, never its content", () => {
    const missing = join(dir, "absent.crt");
    setExtraCaCerts(missing);
    expect(trustMaterialSetting()).toEqual({ invalid: { path: missing, reason: "the file cannot be read (ENOENT)" } });

    setExtraCaCerts(dir);
    expect(trustMaterialSetting()).toEqual({ invalid: { path: dir, reason: "the file cannot be read (EISDIR)" } });
    expect(info).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a file that cannot be read for its permissions is refused with EACCES",
    () => {
      const file = bundle(`${block()}\n`);
      chmodSync(file, 0o000);
      expect(trustMaterialSetting()).toEqual({ invalid: { path: file, reason: "the file cannot be read (EACCES)" } });
    },
  );

  test("an empty or whitespace-only file is refused", () => {
    const empty = bundle("");
    expect(trustMaterialSetting()).toEqual({ invalid: { path: empty, reason: "the file is empty" } });
    const blank = bundle(" \n\t\n");
    expect(trustMaterialSetting()).toEqual({ invalid: { path: blank, reason: "the file is empty" } });
  });

  test("a file with no certificate block is refused, and the reason carries none of its content", () => {
    const file = bundle("not a certificate");
    const setting = trustMaterialSetting();
    expect(setting).toEqual({
      invalid: { path: file, reason: "the file holds no -----BEGIN CERTIFICATE----- block" },
    });
    expect(refusal().message).not.toContain("not a certificate");
  });

  test("a certificate block with no END line is refused", () => {
    const reason = "a -----BEGIN CERTIFICATE----- block in the file has no -----END CERTIFICATE----- line";
    const unclosedLast = bundle(`${block()}\n-----BEGIN CERTIFICATE-----\nMIIB\n`);
    expect(trustMaterialSetting()).toEqual({ invalid: { path: unclosedLast, reason } });
    // An END line that follows a second BEGIN closes the second block, not the first.
    const unclosedFirst = bundle(`-----BEGIN CERTIFICATE-----\nMIIB\n${block()}\n`);
    expect(trustMaterialSetting()).toEqual({ invalid: { path: unclosedFirst, reason } });
  });

  test("a marker counts only alone on its line, so a comment that quotes one is text between blocks", () => {
    const first = block();
    const second = block();
    bundle(
      `# Append each CA below as a -----BEGIN CERTIFICATE----- block\n${first}\n${second}\n# each CA above ends in an -----END CERTIFICATE----- line\n`,
    );
    expect(trustMaterial()).toEqual({ certificates: [first, second] });
  });

  test("a marker line may end in blanks and a carriage return, and the block keeps the file's text", () => {
    const body = `MIIB${crypto.randomUUID().replaceAll("-", "")}`;
    const crlf = `-----BEGIN CERTIFICATE-----\r\n${body}\r\n-----END CERTIFICATE-----`;
    const padded = `-----BEGIN CERTIFICATE-----  \n${body}\n-----END CERTIFICATE-----`;
    bundle(`${crlf}\r\n${padded}\t\n`);
    expect(trustMaterial()).toEqual({ certificates: [crlf, padded] });
  });

  test("a file whose only BEGIN marker is quoted inside a line holds no certificate block", () => {
    const file = bundle("# put a -----BEGIN CERTIFICATE----- block here\n");
    expect(trustMaterialSetting()).toEqual({
      invalid: { path: file, reason: "the file holds no -----BEGIN CERTIFICATE----- block" },
    });
  });

  test("a block under the legacy X509 CERTIFICATE label is refused by name, not dropped", () => {
    const legacy = block()
      .replace("BEGIN CERTIFICATE", "BEGIN X509 CERTIFICATE")
      .replace("END CERTIFICATE", "END X509 CERTIFICATE");
    const file = bundle(`${block()}\n${legacy}\n`);
    expect(trustMaterialSetting()).toEqual({
      invalid: {
        path: file,
        reason:
          "the file holds a -----BEGIN X509 CERTIFICATE----- block, which Node.js trusts and Studio does not take; " +
          "relabel it -----BEGIN CERTIFICATE----- and -----END CERTIFICATE-----",
      },
    });
  });

  test("a refused setting stays refused, and a file fixed later does not rescue it", () => {
    const file = bundle("");
    expect(() => trustMaterial()).toThrow("Invalid NODE_EXTRA_CA_CERTS: the file is empty");
    // A direct write, not the helper: the refusal is kept as the material is.
    writeFileSync(file, `${block()}\n`);
    expect(() => trustMaterial()).toThrow("Invalid NODE_EXTRA_CA_CERTS: the file is empty");
    expect(trustMaterialSetting()).toEqual({ invalid: { path: file, reason: "the file is empty" } });
    expect(info).not.toHaveBeenCalled();
  });

  test("trustMaterial() throws a DatabaseConfigError naming the variable and the reason, on every call", () => {
    const missing = join(dir, "absent.crt");
    setExtraCaCerts(missing);
    const first = refusal();
    const second = refusal();
    for (const error of [first, second]) {
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(error.message).toBe("Invalid NODE_EXTRA_CA_CERTS: the file cannot be read (ENOENT)");
      expect(error.message).not.toContain(missing);
    }
  });

  test("forgetting the outcome makes the next read decide as a new process", () => {
    const file = bundle("");
    expect(() => trustMaterial()).toThrow(DatabaseConfigError);
    const fixed = block();
    writeFileSync(file, `${fixed}\n`);
    forgetTrustMaterial();
    expect(trustMaterial()).toEqual({ certificates: [fixed] });
    expect((globalThis as Record<symbol, unknown>)[slot]).toBeDefined();
    forgetTrustMaterial();
    expect((globalThis as Record<symbol, unknown>)[slot]).toBeUndefined();
  });

  test("the material and its list are frozen", () => {
    bundle(`${block()}\n`);
    const material = trustMaterial();
    expect(Object.isFrozen(material)).toBe(true);
    expect(Object.isFrozen(material.certificates)).toBe(true);
    setExtraCaCerts(undefined);
    const none = trustMaterial();
    expect(Object.isFrozen(none)).toBe(true);
    expect(Object.isFrozen(none.certificates)).toBe(true);
  });
});

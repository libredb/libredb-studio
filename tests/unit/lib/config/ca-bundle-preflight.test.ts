import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyExtraCaCertsAtBoot } from "@/lib/config/ca-bundle-preflight";

/**
 * Node reads NODE_EXTRA_CA_CERTS once at start and, when the file is missing or
 * holds nothing it can use, only prints a warning and trusts nothing extra: every
 * TLS connection to a database or identity provider behind the private CA then
 * fails later, far from the cause. The preflight refuses to boot instead, so the
 * container restarts until the bundle is there (on OpenShift the Cluster Network
 * Operator fills the trusted-CA ConfigMap after the pod may have started).
 */
describe("config/ca-bundle-preflight verifyExtraCaCertsAtBoot", () => {
  const original = process.env.NODE_EXTRA_CA_CERTS;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-ca-"));
  });

  afterEach(() => {
    if (original === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = original;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the check with process.exit and console.error stubbed; returns what it did. */
  function run(): { result: boolean; exitCalls: Array<number | undefined>; banner: string } {
    const originalExit = process.exit;
    const exitCalls: Array<number | undefined> = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code);
    }) as unknown as typeof process.exit;
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = verifyExtraCaCertsAtBoot();
      // Read the recorded calls before mockRestore(): bun clears them on restore.
      return { result, exitCalls, banner: errorSpy.mock.calls.flat().join("\n") };
    } finally {
      process.exit = originalExit;
      errorSpy.mockRestore();
    }
  }

  function bundle(content: string): string {
    const file = join(dir, "ca-bundle.crt");
    writeFileSync(file, content);
    process.env.NODE_EXTRA_CA_CERTS = file;
    return file;
  }

  test("checks nothing when NODE_EXTRA_CA_CERTS is unset", () => {
    delete process.env.NODE_EXTRA_CA_CERTS;
    const { result, exitCalls, banner } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
  });

  test("checks nothing when NODE_EXTRA_CA_CERTS is empty", () => {
    process.env.NODE_EXTRA_CA_CERTS = "";
    const { result, exitCalls } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
  });

  test("refuses a path that does not exist", () => {
    const missing = join(dir, "absent.crt");
    process.env.NODE_EXTRA_CA_CERTS = missing;
    const { result, exitCalls, banner } = run();
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("NODE_EXTRA_CA_CERTS");
    expect(banner).toContain(missing);
    expect(banner).toContain("ENOENT");
  });

  test("refuses a path that is a directory", () => {
    process.env.NODE_EXTRA_CA_CERTS = dir;
    const { exitCalls, banner } = run();
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("EISDIR");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses an unreadable file", () => {
    const file = bundle("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    chmodSync(file, 0o000);
    const { exitCalls, banner } = run();
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("EACCES");
  });

  test("refuses an empty file", () => {
    const file = bundle("");
    const { exitCalls, banner } = run();
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(file);
    expect(banner).toContain("empty");
  });

  test("refuses a whitespace-only file", () => {
    bundle(" \n\t\n");
    const { exitCalls, banner } = run();
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("empty");
  });

  test("refuses a file with no PEM certificate block, without printing its content", () => {
    bundle("not a certificate");
    const { result, exitCalls, banner } = run();
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain("-----BEGIN CERTIFICATE-----");
    expect(banner).not.toContain("not a certificate");
  });

  test("accepts a bundle", () => {
    bundle("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    const { result, exitCalls, banner } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
  });
});

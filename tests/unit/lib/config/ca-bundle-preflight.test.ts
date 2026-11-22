import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyExtraCaCertsAtBoot } from "@/lib/config/ca-bundle-preflight";
import { forgetTrustMaterial, trustMaterial } from "@/lib/db/trust-material";
import { logger } from "@/lib/logger";

/**
 * Node reads NODE_EXTRA_CA_CERTS once at start and, when the file is missing or
 * holds nothing it can use, only prints a warning and trusts nothing extra: every
 * TLS connection to a database or identity provider behind the private CA then
 * fails later, far from the cause. The preflight refuses to boot instead, so the
 * container restarts until the bundle is there (on OpenShift the Cluster Network
 * Operator fills the trusted-CA ConfigMap after the pod may have started).
 *
 * The preflight's read is core's read of the trust material (`src/lib/db/trust-material.ts`), kept for the life of the
 * process, so every case forgets the kept outcome first, as a new process would start.
 */
describe("config/ca-bundle-preflight verifyExtraCaCertsAtBoot", () => {
  const original = process.env.NODE_EXTRA_CA_CERTS;
  let dir: string;
  let info: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "libredb-ca-"));
    forgetTrustMaterial();
    info = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    info.mockRestore();
    if (original === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = original;
    forgetTrustMaterial();
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

  test("the boot read is the read core keeps: the certificates of the accepted bundle, whatever the file says later", () => {
    const certificate = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    const file = bundle(`${certificate}\n`);
    const { result, exitCalls } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    writeFileSync(file, "");
    expect(trustMaterial()).toEqual({ certificates: [certificate] });
  });

  test("refuses a certificate block with no END line", () => {
    const file = bundle(
      "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIB\n",
    );
    const { result, exitCalls, banner } = run();
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(file);
    expect(banner).toContain("a -----BEGIN CERTIFICATE----- block in the file has no -----END CERTIFICATE----- line");
    // Node.js trusts the complete blocks before the broken one, so the banner claims neither "no bundle" nor "no CA".
    expect(banner).toContain("NODE_EXTRA_CA_CERTS names a file Studio does not accept as a certificate bundle");
    expect(banner).toContain("Node would only warn, and trust none or only part of it");
    expect(banner).not.toContain("names no certificate bundle");
  });

  test("refuses a block under the legacy X509 CERTIFICATE label, naming the label to write instead", () => {
    const file = bundle("-----BEGIN X509 CERTIFICATE-----\nMIIB\n-----END X509 CERTIFICATE-----\n");
    const { result, exitCalls, banner } = run();
    expect(result).toBe(false);
    expect(exitCalls).toEqual([1]);
    expect(banner).toContain(file);
    expect(banner).toContain(
      "the file holds a -----BEGIN X509 CERTIFICATE----- block, which Node.js trusts and Studio does not take; relabel it -----BEGIN CERTIFICATE----- and -----END CERTIFICATE-----",
    );
  });

  test("accepts a bundle whose comment quotes the BEGIN marker", () => {
    bundle(
      "# append each CA as a -----BEGIN CERTIFICATE----- block\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    );
    const { result, exitCalls, banner } = run();
    expect(result).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(banner).toBe("");
  });
});

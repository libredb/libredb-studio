import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pemCertificates, readCertificateFile, readTokenFile, tokenFileReady } from "@/lib/openshift-auth/files";
import { MISSING_POSIX_FILE_MODES, testIf } from "../../../helpers/posix-tools";
import { loadTlsFixtures } from "../../../helpers/tls-fixtures";

const { ca, otherCa } = loadTlsFixtures();
const MALFORMED = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "openshift-files-"));
  writeFileSync(join(dir, "bundle.crt"), `${ca}\n${MALFORMED}\n${otherCa}`);
  writeFileSync(join(dir, "malformed.crt"), MALFORMED);
  writeFileSync(join(dir, "token"), "  sha256~not-a-real-token-1\n");
  writeFileSync(join(dir, "blank"), " \n");
  writeFileSync(join(dir, "empty"), "");
  writeFileSync(join(dir, "unreadable"), "sha256~not-a-real-token-2");
  chmodSync(join(dir, "unreadable"), 0o000);
  mkdirSync(join(dir, "a-directory"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("pemCertificates", () => {
  test("keeps every block that parses as a certificate and drops a malformed one", () => {
    expect(pemCertificates(`${ca}\n${MALFORMED}\n${otherCa}`)).toEqual([ca.trim(), otherCa.trim()]);
    expect(pemCertificates("no certificate here")).toEqual([]);
  });
});

describe("readCertificateFile", () => {
  test("answers the certificates, or null for a missing, unreadable or certificate-free file", () => {
    expect(readCertificateFile(join(dir, "bundle.crt"))).toHaveLength(2);
    expect(readCertificateFile(join(dir, "malformed.crt"))).toBeNull();
    expect(readCertificateFile(join(dir, "missing.crt"))).toBeNull();
    expect(readCertificateFile(join(dir, "a-directory"))).toBeNull();
  });
});

describe("tokenFileReady", () => {
  test("is true only for a readable, non-empty regular file", () => {
    expect(tokenFileReady(join(dir, "token"))).toBe(true);
    expect(tokenFileReady(join(dir, "empty"))).toBe(false);
    expect(tokenFileReady(join(dir, "missing"))).toBe(false);
    expect(tokenFileReady(join(dir, "a-directory"))).toBe(false);
  });

  // POSIX only: NTFS has no mode bits, so chmod 000 there sets the read-only flag and the file stays readable.
  testIf(MISSING_POSIX_FILE_MODES, "is false for a file its mode makes unreadable", () => {
    // Root reads any file, so the mode bit decides only for other users.
    if (process.getuid?.() !== 0) expect(tokenFileReady(join(dir, "unreadable"))).toBe(false);
  });
});

describe("readTokenFile", () => {
  test("answers the trimmed content, or null for a blank, missing or unreadable file", () => {
    expect(readTokenFile(join(dir, "token"))).toBe("sha256~not-a-real-token-1");
    expect(readTokenFile(join(dir, "blank"))).toBeNull();
    expect(readTokenFile(join(dir, "missing"))).toBeNull();
    expect(readTokenFile(join(dir, "a-directory"))).toBeNull();
  });
});

/**
 * The two files openshift sign-in reads: the projected ServiceAccount token it presents as its client secret, and the
 * PEM certificates it trusts. Each is read on every use, so a rotated token or CA applies at once. Nothing here logs,
 * and no error carries a file's content.
 */

import { X509Certificate } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Every block of `text` that parses as a certificate; a malformed block is left out. */
export function pemCertificates(text: string): string[] {
  return (text.match(PEM_BLOCK) ?? []).filter((block) => {
    try {
      return new X509Certificate(block).raw.length > 0;
    } catch {
      return false;
    }
  });
}

/** The certificates of a PEM file, or null when it cannot be read or holds none. */
export function readCertificateFile(path: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const certificates = pemCertificates(text);
  return certificates.length === 0 ? null : certificates;
}

/** The token file is a readable regular file that is not empty, checked without reading its content. */
export function tokenFileReady(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    const stat = statSync(path);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** The client secret: the token file's content, trimmed, or null when it cannot be read or is blank. */
export function readTokenFile(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    return token === "" ? null : token;
  } catch {
    return null;
  }
}

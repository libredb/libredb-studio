/**
 * Zero-config first run (#109): when auth env vars are absent, generate
 * credentials once, persist them in the data directory, and inject them into
 * process.env BEFORE any secret reader runs (auth.ts, proxy.ts, oidc.ts,
 * local-auth.ts all read process.env lazily). Called from instrumentation.ts.
 * Explicitly set env vars always win; only missing fields are generated.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "@/lib/data-dir";

export const BOOTSTRAP_FILE_NAME = "auth-bootstrap.json";

interface BootstrapFile {
  jwtSecret?: string;
  adminPassword?: string;
  createdAt?: string;
}

/**
 * Zero-config bootstrap is on unless AUTH_BOOTSTRAP opts out: "off", "false",
 * or "0", case-insensitive ("false"/"0" match the LIBREDB_EMBEDDED_SAMPLE
 * convention). Any other non-empty, non-affirmative value is treated as a
 * misconfiguration: warn and stay on, so a typo never silently flips the
 * security posture in either direction.
 */
export function isBootstrapEnabled(): boolean {
  const raw = process.env.AUTH_BOOTSTRAP;
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  if (normalized !== "on" && normalized !== "true" && normalized !== "1") {
    console.warn(
      `LibreDB Studio: unrecognized AUTH_BOOTSTRAP value "${raw}"; bootstrap stays on (use "off" to disable)`,
    );
  }
  return true;
}

export function resolveBootstrapPath(): string {
  // Resolve to an absolute path so the banner and log lines name a location
  // the operator can copy verbatim (the data dir default is CWD-relative).
  return path.resolve(getDataDir(), BOOTSTRAP_FILE_NAME);
}

function readBootstrapFile(filePath: string): BootstrapFile {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // Wrong-shape JSON (null, an array, a primitive) must be rejected here, in
    // the same try block as JSON.parse, so the catch below treats it exactly
    // like a corrupt file: rename to .bak and regenerate. Without this check,
    // `null` throws later on property access (permanent fail-open) and `[]`
    // silently drops assigned fields on write (new credentials every boot).
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("bootstrap file does not contain a JSON object");
    }
    const { jwtSecret, adminPassword } = parsed as BootstrapFile;
    // Mirror the >= 32 chars minimum enforced by auth.ts getJwtSecret(): a
    // hand-edited short secret must regenerate here instead of being injected
    // and wedging every login on a misleading "JWT_SECRET too short" 503.
    if (jwtSecret !== undefined && (typeof jwtSecret !== "string" || jwtSecret.length < 32)) {
      throw new Error("bootstrap file jwtSecret is not a string of at least 32 chars");
    }
    if (adminPassword !== undefined && typeof adminPassword !== "string") {
      throw new Error("bootstrap file adminPassword is not a string");
    }
    return parsed as BootstrapFile;
  } catch {
    // Unreadable state: keep the evidence, regenerate. Sessions signed with a
    // lost secret become invalid; that is logged by the caller's banner path.
    // Windows rename throws if the destination exists (see seedSampleFile), so
    // clear any older .bak first — the newest evidence wins.
    fs.rmSync(`${filePath}.bak`, { force: true });
    fs.renameSync(filePath, `${filePath}.bak`);
    console.warn(`LibreDB Studio: corrupt ${filePath} moved to .bak; regenerating credentials`);
    return {};
  }
}

function writeBootstrapFile(filePath: string, data: BootstrapFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Temp + atomic rename so a crash never leaves a partial credentials file
  // (same pattern as seedSampleFile in libredb-sample.ts).
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch {
    // POSIX rename overwrites, but Windows throws if the destination exists
    // (see seedSampleFile). Fall back to copy-over instead of delete-and-retry
    // so a failure here can never destroy the only copy of the credentials
    // file; a torn copy is repaired by the corrupt-file recovery on next boot.
    try {
      fs.copyFileSync(tempPath, filePath);
      try {
        fs.chmodSync(filePath, 0o600); // copyFileSync does not carry the temp's mode
      } catch {
        // Best-effort hardening: the credentials were written successfully, so
        // an unsupported/failed chmod must not abort bootstrap. Warn instead.
        console.warn(`LibreDB Studio: could not restrict permissions on ${filePath}`);
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function printFirstRunBanner(filePath: string, adminPassword: string): void {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@libredb.org"; // mirrors local-auth.ts default
  console.log(
    [
      "",
      "============================================================",
      " LibreDB Studio first run: generated admin credentials",
      ` Email:    ${adminEmail}`,
      ` Password: ${adminPassword}`,
      ` Stored in ${filePath} (delete the file to regenerate)`,
      "============================================================",
      "",
    ].join("\n"),
  );
}

export function bootstrapAuth(): void {
  if (!isBootstrapEnabled()) return;

  const needSecret = !process.env.JWT_SECRET;
  const needPassword = !process.env.ADMIN_PASSWORD && process.env.NEXT_PUBLIC_AUTH_PROVIDER !== "oidc";
  if (!needSecret && !needPassword) return;

  try {
    const filePath = resolveBootstrapPath();
    const stored = readBootstrapFile(filePath);
    let secretGenerated = false;
    let passwordGenerated = false;

    if (needSecret && !stored.jwtSecret) {
      stored.jwtSecret = randomBytes(48).toString("base64");
      secretGenerated = true;
    }
    if (needPassword && !stored.adminPassword) {
      stored.adminPassword = randomBytes(12).toString("base64url");
      passwordGenerated = true;
    }

    if (secretGenerated || passwordGenerated) {
      stored.createdAt = stored.createdAt || new Date().toISOString();
      writeBootstrapFile(filePath, stored); // throws on read-only fs -> fail open below
    }

    if (needSecret && stored.jwtSecret) process.env.JWT_SECRET = stored.jwtSecret;
    if (needPassword && stored.adminPassword) {
      process.env.ADMIN_PASSWORD = stored.adminPassword;
      if (passwordGenerated) printFirstRunBanner(filePath, stored.adminPassword);
      else console.log(`LibreDB Studio: using generated admin credentials from ${filePath}`);
    }
  } catch (error) {
    // Fail open: leave env untouched so login surfaces the clear 503 (PR #106).
    console.warn(`LibreDB Studio: auth bootstrap skipped (${error instanceof Error ? error.message : String(error)})`);
  }
}

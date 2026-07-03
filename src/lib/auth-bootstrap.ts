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

export function resolveBootstrapPath(): string {
  return path.join(getDataDir(), BOOTSTRAP_FILE_NAME);
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
    if (jwtSecret !== undefined && typeof jwtSecret !== "string") {
      throw new Error("bootstrap file jwtSecret is not a string");
    }
    if (adminPassword !== undefined && typeof adminPassword !== "string") {
      throw new Error("bootstrap file adminPassword is not a string");
    }
    return parsed as BootstrapFile;
  } catch {
    // Unreadable state: keep the evidence, regenerate. Sessions signed with a
    // lost secret become invalid; that is logged by the caller's banner path.
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
  fs.renameSync(tempPath, filePath);
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
  if (process.env.AUTH_BOOTSTRAP === "off") return;

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

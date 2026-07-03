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
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as BootstrapFile;
}

function writeBootstrapFile(filePath: string, data: BootstrapFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Temp + atomic rename so a crash never leaves a partial credentials file
  // (same pattern as seedSampleFile in libredb-sample.ts).
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export function bootstrapAuth(): void {
  if (process.env.AUTH_BOOTSTRAP === "off") return;

  const needSecret = !process.env.JWT_SECRET;
  const needPassword = !process.env.ADMIN_PASSWORD && process.env.NEXT_PUBLIC_AUTH_PROVIDER !== "oidc";

  if (!needSecret && !needPassword) return;

  const filePath = resolveBootstrapPath();
  const stored = readBootstrapFile(filePath);
  let generated = false;

  if (needSecret && !stored.jwtSecret) {
    stored.jwtSecret = randomBytes(48).toString("base64");
    generated = true;
  }
  if (needPassword && !stored.adminPassword) {
    stored.adminPassword = randomBytes(12).toString("base64url");
    generated = true;
  }

  if (generated) {
    stored.createdAt = stored.createdAt || new Date().toISOString();
    writeBootstrapFile(filePath, stored);
  }

  if (needSecret && stored.jwtSecret) process.env.JWT_SECRET = stored.jwtSecret;
  if (needPassword && stored.adminPassword) process.env.ADMIN_PASSWORD = stored.adminPassword;
}

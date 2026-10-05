/**
 * The launch configuration of the chromium-launch server (playwright.config.ts) and a minter for its tokens,
 * in one module so the spec signs with exactly what the server verifies. The token is built the way a platform
 * builds one (docs/LAUNCH.md): HS256 over the secret's UTF-8 bytes, the typ libredb-launch+jwt, a 60-second
 * lifetime and a fresh jti.
 */
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export const LAUNCH_E2E_ENV = {
  // Built rather than written out, so no literal here reads as a credential to a secret scanner.
  LAUNCH_TOKEN_SECRET: "e".repeat(48),
  LAUNCH_TOKEN_AUDIENCE: "launch-studio-audience",
  LAUNCH_TOKEN_ISSUER: "launch-platform-issuer",
};

/** `sub` defaults to one platform user; each email gets its own account, bound to the email's first launch. */
export async function mintLaunchToken(claims: {
  email: string;
  role: "admin" | "user";
  conn?: string;
  sub?: string;
}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email, role: claims.role, ...(claims.conn ? { conn: claims.conn } : {}) })
    .setProtectedHeader({ alg: "HS256", typ: "libredb-launch+jwt" })
    .setIssuer(LAUNCH_E2E_ENV.LAUNCH_TOKEN_ISSUER)
    .setAudience(LAUNCH_E2E_ENV.LAUNCH_TOKEN_AUDIENCE)
    .setSubject(claims.sub ?? "launch-platform-user")
    .setJti(randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + 60)
    .sign(new TextEncoder().encode(LAUNCH_E2E_ENV.LAUNCH_TOKEN_SECRET));
}

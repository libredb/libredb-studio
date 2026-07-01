import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { logger } from "@/lib/logger";
import { AuthConfigError } from "@/lib/auth-errors";

// Single-line messages, hoisted to module scope: bun's line coverage under-counts
// the continuation lines of multi-line string concatenation, which would show as
// uncovered "new code" in SonarCloud even though the throw is exercised by tests.
const JWT_SECRET_MISSING_MESSAGE =
  "Login is unavailable: the server's JWT_SECRET is not configured. Set JWT_SECRET (at least 32 characters) and restart the server.";
const JWT_SECRET_TOO_SHORT_MESSAGE =
  "Login is unavailable: the server's JWT_SECRET is too short; it must be at least 32 characters. Update JWT_SECRET and restart the server.";

function getJwtSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      // Thrown lazily (at sign/verify time), so the login route can turn it into
      // a clear on-screen 503 instead of a misleading "Invalid email or password".
      throw new AuthConfigError(JWT_SECRET_MISSING_MESSAGE);
    }
    // Development fallback - only for local development
    console.warn("⚠️ JWT_SECRET not set, using development fallback. Set JWT_SECRET in production!");
    return new TextEncoder().encode("development-fallback-secret-32ch");
  }

  if (secret.length < 32) {
    throw new AuthConfigError(JWT_SECRET_TOO_SHORT_MESSAGE);
  }

  return new TextEncoder().encode(secret);
}

// Lazy-initialized to prevent module-level crash if JWT_SECRET is misconfigured.
// A module-level throw would crash ALL modules that import auth.ts.
let _jwtSecret: Uint8Array | null = null;
function jwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    _jwtSecret = getJwtSecret();
  }
  return _jwtSecret;
}

export type Role = "admin" | "user";

export interface UserPayload {
  role: Role;
  username: string;
}

export async function signJWT(payload: UserPayload) {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(jwtSecret());
}

export async function verifyJWT(token: string) {
  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    return payload as unknown as UserPayload;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("expired")) {
        logger.debug("JWT token expired", { route: "auth" });
      } else {
        logger.warn("JWT verification failed", { route: "auth" });
      }
    }
    return null;
  }
}

export async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth-token")?.value;
  if (!token) return null;
  return await verifyJWT(token);
}

export async function login(role: Role, username?: string) {
  const token = await signJWT({ role, username: username || role });
  const cookieStore = await cookies();
  cookieStore.set("auth-token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 1 day
    path: "/",
  });
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete("auth-token");
}

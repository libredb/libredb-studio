import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { logger } from "@/lib/logger";
import { getJwtSecret } from "@/lib/config/auth-env";

// getJwtSecret throws AuthConfigError lazily (at sign/verify time), so the login
// route can turn it into a clear on-screen 503 instead of a misleading
// "Invalid email or password".
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

/** Hosts whose traffic never leaves the machine (port is stripped before the check). */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // Strip the port, then the brackets of an IPv6 literal ("[::1]:3000" -> "::1").
  const hostname = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Whether the session cookie should carry the Secure flag.
 *
 * Secure in production, as before, with one exception: a request that arrived on
 * a loopback host over plain http. Marking that cookie Secure protects nothing
 * (the traffic never leaves the machine) and actively breaks the desktop shell,
 * because libsoup - the cookie store behind WebKitGTK - discards a Secure cookie
 * delivered over http instead of ignoring the flag the way Chromium does on
 * localhost (issue #232). A proxy that terminated TLS and forwarded to loopback
 * still gets Secure, via x-forwarded-proto.
 */
async function shouldMarkCookieSecure(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production") return false;
  try {
    const headerStore = await headers();
    if (!isLoopbackHost(headerStore.get("host"))) return true;
    const forwardedProto = headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return forwardedProto === "https";
  } catch {
    // No request scope (headers() throws): keep the stricter default.
    return true;
  }
}

export async function login(role: Role, username?: string) {
  const token = await signJWT({ role, username: username || role });
  const cookieStore = await cookies();
  cookieStore.set("auth-token", token, {
    httpOnly: true,
    secure: await shouldMarkCookieSecure(),
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 1 day
    path: "/",
  });
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete("auth-token");
}

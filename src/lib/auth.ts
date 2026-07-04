import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
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

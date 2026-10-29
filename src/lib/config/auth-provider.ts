/**
 * The one reader of NEXT_PUBLIC_AUTH_PROVIDER, the sign-in mode.
 *
 * Read from the environment on every call, never frozen at build time: the chart sets the variable on the container,
 * so an image built without it and started in `openshift` mode must take the openshift branch. The value is trimmed and
 * case-sensitive; unset or empty means `local`, and anything outside the three modes is `invalid`, which the boot
 * preflight refuses and every runtime reader turns into an error, so a typo never falls back to local sign-in with a
 * generated admin password.
 *
 * Imports only AuthConfigError: the proxy imports this module, so it carries no Node built-in and no openid-client.
 */

import { AuthConfigError } from "@/lib/auth-errors";

export type AuthProvider = "local" | "oidc" | "openshift";
export type AuthProviderSetting = AuthProvider | "invalid";

export const AUTH_PROVIDER_INVALID_MESSAGE = `NEXT_PUBLIC_AUTH_PROVIDER must be local, oidc or openshift, or unset for local`;

/** The mode for boot checks, the bootstrap and the MCP and agent holds: never throws, `invalid` for an unknown value. */
export function authProviderSetting(): AuthProviderSetting {
  const value = process.env.NEXT_PUBLIC_AUTH_PROVIDER?.trim();
  if (!value) return "local";
  if (value === "local" || value === "oidc" || value === "openshift") return value;
  return "invalid";
}

/** The mode for every runtime reader: throws AuthConfigError on an unknown value, so a Studio that skipped the preflight fails closed. */
export function authProvider(): AuthProvider {
  const setting = authProviderSetting();
  if (setting === "invalid") throw new AuthConfigError(AUTH_PROVIDER_INVALID_MESSAGE);
  return setting;
}

/** The raw value, for refusal messages only (the preflights quote it through their own `shown()`). */
export function authProviderValue(): string | undefined {
  return process.env.NEXT_PUBLIC_AUTH_PROVIDER;
}

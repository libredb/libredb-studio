"use client";

import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";

export default function AuthenticatorSettingsPage() {
  // The proxy sends a visitor without a session to /login, as it does for /settings/mcp.
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 text-sm text-fg-secondary">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-fg-bright">Authenticator</h1>
        <p>A second factor for your own sign-in: a 6-digit code from an authenticator app after your password.</p>
      </header>
      <AuthenticatorSettings />
    </main>
  );
}

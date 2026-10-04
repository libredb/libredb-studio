"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";
import { PasskeySettings } from "@/components/auth/PasskeySettings";
import { useAuth } from "@/hooks/use-auth";

export default function AuthenticatorSettingsPage() {
  // Advanced when the authenticator changes, so the passkey section re-reads whether a code is needed.
  const [factorVersion, setFactorVersion] = useState(0);
  // The proxy sends a visitor without a session to /login, as it does for /settings/mcp. A session it
  // still lets through but the server refuses (a passkey removed elsewhere, a disabled account) is
  // sent there by useAuth, which reads /api/auth/me as the editor does.
  useAuth();
  return (
    <main className="min-h-screen bg-surface">
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
        >
          <ArrowLeft className="size-3.5" />
          Back to the editor
        </Link>
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-fg">Sign-in security</h1>
          <p className="text-sm text-fg-muted">
            Passkeys and the authenticator app for your own sign-in to this server.
          </p>
        </header>
        <AuthenticatorSettings onChange={() => setFactorVersion((value) => value + 1)} />
        <PasskeySettings reloadSignal={factorVersion} />
      </div>
    </main>
  );
}

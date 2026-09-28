"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";

export default function AuthenticatorSettingsPage() {
  // The proxy sends a visitor without a session to /login, as it does for /settings/mcp.
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
          <h1 className="text-xl font-semibold tracking-tight text-fg">Authenticator</h1>
          <p className="text-sm text-fg-muted">Settings for your own sign-in to this server.</p>
        </header>
        <AuthenticatorSettings />
      </div>
    </main>
  );
}

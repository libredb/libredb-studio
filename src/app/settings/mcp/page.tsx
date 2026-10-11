"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { McpSettings } from "@/components/mcp/McpSettings";
import { useAuth } from "@/hooks/use-auth";

export default function McpSettingsPage() {
  // The proxy sends a visitor without a session to /login, as it does for /monitoring. A session it
  // still lets through but the server refuses (a disabled account, a reset password) is sent
  // there by useAuth, which reads /api/auth/me as the editor does.
  useAuth();
  return (
    <div className="mx-auto max-w-3xl px-6 pt-6">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-fg-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" />
        Back to the editor
      </Link>
      <McpSettings />
    </div>
  );
}

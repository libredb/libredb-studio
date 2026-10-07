"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { McpSettings } from "@/components/mcp/McpSettings";

export default function McpSettingsPage() {
  // The proxy sends a visitor without a session to /login, as it does for /monitoring.
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

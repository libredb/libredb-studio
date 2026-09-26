"use client";

import { McpSettings } from "@/components/mcp/McpSettings";

export default function McpSettingsPage() {
  // The proxy sends a visitor without a session to /login, as it does for /monitoring.
  return <McpSettings />;
}

"use client";

import React from "react";
import type { DatabaseConnection } from "@/lib/types";
import { connectionPulseTitle, type ConnectionPulse } from "@/hooks/use-connection-pulse";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Database, Gauge, KeyRound, LogOut, Settings, ShieldCheck, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { GitHubRepoLink } from "@/components/github-repo-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { ReadOnlyMarker, showsReadOnlyMarker } from "@/components/read-only-marker";

/** What the pulse indicator reads for each state. Only Online animates: the others are not live. */
const PULSE_TEXT: Record<ConnectionPulse, string> = {
  healthy: "Online",
  degraded: "Slow",
  error: "Error",
  "not-checked": "Not checked",
};

interface StudioDesktopHeaderProps {
  activeConnection: DatabaseConnection | null;
  connectionPulse: ConnectionPulse | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  onLogout: () => void;
}

export const StudioDesktopHeader = React.memo(function StudioDesktopHeader({
  activeConnection,
  connectionPulse,
  user,
  isAdmin,
  onLogout,
}: StudioDesktopHeaderProps) {
  const router = useRouter();

  return (
    <header className="hidden md:flex h-14 border-b border-hairline items-center justify-between px-4 bg-surface/80 backdrop-blur-xl sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-brand-tint/10 border border-brand-tint/20">
          <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-brand" />
        </div>
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-xs font-medium text-fg truncate max-w-[120px]">
              {activeConnection ? activeConnection.name : "Quick Access"}
            </h1>
            {activeConnection && showsReadOnlyMarker(activeConnection) && <ReadOnlyMarker />}
          </div>
          {activeConnection && (
            <p className="text-xs text-fg-muted font-mono uppercase leading-none mt-0.5">
              {activeConnection.type}
              {activeConnection.environment && activeConnection.environment !== "other" && (
                <span className="ml-1 font-medium" style={{ color: activeConnection.color || "#22c55e" }}>
                  • {activeConnection.environment}
                </span>
              )}
              {/* A connection Studio does not check (resumesBilledCompute) has not been seen online. */}
              {!activeConnection.environment && connectionPulse !== "not-checked" && (
                <span>
                  {" "}
                  • <span className="text-success/80">Online</span>
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        {connectionPulse && (
          <div
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-fill mr-2"
            title={connectionPulseTitle(connectionPulse)}
          >
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                connectionPulse === "healthy" && "bg-success-tint animate-pulse",
                connectionPulse === "degraded" && "bg-warning-tint",
                connectionPulse === "error" && "bg-danger-tint",
                connectionPulse === "not-checked" && "bg-fg-subtle",
              )}
            />
            <span className="text-xs font-medium text-fg-muted">{PULSE_TEXT[connectionPulse]}</span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs font-medium gap-2 text-fg-muted hover:text-hue-purple hover:bg-hue-purple-tint/10"
          onClick={() => router.push("/monitoring")}
        >
          <Gauge strokeWidth={1.5} className="w-3 h-3" /> Monitoring
        </Button>

        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-2 hover:bg-fill px-2" aria-label="User menu">
                <User strokeWidth={1.5} className="w-3 h-3 text-brand" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 bg-raised border-hairline-strong text-fg-secondary">
              {isAdmin && (
                <DropdownMenuItem onClick={() => router.push("/admin")} className="cursor-pointer">
                  <Settings strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Admin Dashboard
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => router.push("/monitoring")} className="cursor-pointer">
                <Gauge strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Monitoring
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push("/settings/mcp")} className="cursor-pointer">
                <KeyRound strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> MCP
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push("/settings/authenticator")} className="cursor-pointer">
                <ShieldCheck strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Sign-in security
              </DropdownMenuItem>
              <div className="border-t border-hairline my-1" />
              <DropdownMenuItem onClick={onLogout} className="text-danger cursor-pointer">
                <LogOut strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {/* Renders nothing when a host (platform) owns the theme — see ThemeToggle. */}
        <ThemeToggle className="mr-1" />
        <GitHubRepoLink className="text-fg-tertiary hover:text-fg-bright mr-2" />
        <span className="text-xs text-fg-muted font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
      </div>
    </header>
  );
});

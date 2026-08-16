"use client";

import React from "react";
import type { DatabaseConnection } from "@/lib/types";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Database, Gauge, LogOut, Settings, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { GitHubRepoLink } from "@/components/github-repo-link";
import { ThemeToggle } from "@/components/theme-toggle";

interface StudioDesktopHeaderProps {
  activeConnection: DatabaseConnection | null;
  connectionPulse: "healthy" | "degraded" | "error" | null;
  user: { role?: string } | null;
  isAdmin: boolean;
  onLogout: () => void;
}

export function StudioDesktopHeader({
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
        <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <Database strokeWidth={1.5} className="w-3.5 h-3.5 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xs font-medium text-fg truncate max-w-[120px]">
            {activeConnection ? activeConnection.name : "Quick Access"}
          </h1>
          {activeConnection && (
            <p className="text-xs text-fg-muted font-mono uppercase leading-none mt-0.5">
              {activeConnection.type}
              {activeConnection.environment && activeConnection.environment !== "other" && (
                <span className="ml-1 font-medium" style={{ color: activeConnection.color || "#22c55e" }}>
                  • {activeConnection.environment}
                </span>
              )}
              {!activeConnection.environment && (
                <span>
                  {" "}
                  • <span className="text-emerald-500/80">Online</span>
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
            title={`Connection: ${connectionPulse}`}
          >
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                connectionPulse === "healthy" && "bg-emerald-500 animate-pulse",
                connectionPulse === "degraded" && "bg-amber-500",
                connectionPulse === "error" && "bg-red-500",
              )}
            />
            <span className="text-xs font-medium text-fg-muted">
              {connectionPulse === "healthy" ? "Online" : connectionPulse === "degraded" ? "Slow" : "Error"}
            </span>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-3 text-xs font-medium gap-2 text-fg-muted hover:text-purple-400 hover:bg-purple-500/10"
          onClick={() => router.push("/monitoring")}
        >
          <Gauge strokeWidth={1.5} className="w-3 h-3" /> Monitoring
        </Button>

        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 gap-2 hover:bg-fill px-2">
                <User strokeWidth={1.5} className="w-3 h-3 text-blue-400" />
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
              <div className="border-t border-hairline my-1" />
              <DropdownMenuItem onClick={onLogout} className="text-red-400 cursor-pointer">
                <LogOut strokeWidth={1.5} className="w-3.5 h-3.5 mr-2" /> Logout
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Settings
          strokeWidth={1.5}
          className="w-3.5 h-3.5 text-fg-tertiary cursor-pointer hover:text-fg-bright transition-colors mx-2"
        />
        {/* Renders nothing when a host (platform) owns the theme — see ThemeToggle. */}
        <ThemeToggle className="mr-1" />
        <GitHubRepoLink className="text-fg-tertiary hover:text-fg-bright mr-2" />
        <span className="text-xs text-fg-muted font-mono">v{process.env.NEXT_PUBLIC_APP_VERSION}</span>
      </div>
    </header>
  );
}

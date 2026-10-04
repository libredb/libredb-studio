"use client";

import { Fingerprint, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PublicAccount } from "@/lib/local-accounts";

/** Small, flat pieces the Accounts screen and its dialogs share. */

export function RoleBadge({ role }: { role: PublicAccount["role"] }) {
  return role === "admin" ? (
    <Badge variant="outline" className="border-brand-tint/25 bg-brand-tint/10 text-brand">
      Admin
    </Badge>
  ) : (
    <Badge variant="outline" className="border-hairline-strong text-fg-tertiary">
      User
    </Badge>
  );
}

export function StatusBadge({ disabled }: { disabled: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 border-hairline-strong", disabled ? "text-fg-muted" : "text-fg-secondary")}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", disabled ? "bg-fg-subtle" : "bg-success-solid")} />
      {disabled ? "Disabled" : "Active"}
    </Badge>
  );
}

/** Two-factor as a quiet mark: a shield when it is on, a muted "Off" when it is not. */
export function TwoFactorStatus({ enabled, className }: { enabled: boolean; className?: string }) {
  return enabled ? (
    <span className={cn("inline-flex items-center gap-1.5 text-xs text-fg-secondary", className)}>
      <ShieldCheck aria-hidden className="size-3.5 text-success" />
      On
    </span>
  ) : (
    <span className={cn("text-xs text-fg-subtle", className)}>Off</span>
  );
}

/** "1 passkey", "2 passkeys": the count as the dialogs and the mobile badge say it. */
export function passkeyPhrase(count: number): string {
  return `${count} ${count === 1 ? "passkey" : "passkeys"}`;
}

/** The Passkeys column: the count, or a muted "None". */
export function PasskeyCount({ count }: { count: number }) {
  return count > 0 ? (
    <span className="text-xs text-fg-secondary tabular-nums">{count}</span>
  ) : (
    <span className="text-xs text-fg-subtle">None</span>
  );
}

/** The folded mobile row's mark for an account that has passkeys. */
export function PasskeyBadge({ count }: { count: number }) {
  return (
    <Badge variant="outline" className="gap-1 border-hairline-strong text-fg-tertiary">
      <Fingerprint aria-hidden className="size-3" />
      {passkeyPhrase(count)}
    </Badge>
  );
}

export function YouTag() {
  return (
    <span className="inline-flex shrink-0 items-center rounded border border-hairline-strong px-1.5 text-[0.6875rem] leading-4 font-medium text-fg-muted">
      You
    </span>
  );
}

export function MonoEmail({ value }: { value: string }) {
  return <span className="font-mono break-all text-fg">{value}</span>;
}

export function formatCreated(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** "8 accounts · 2 admins · 2 disabled", for the toolbar's count line. */
export function accountSummary(accounts: PublicAccount[]): string {
  const admins = accounts.filter((account) => account.role === "admin").length;
  const disabled = accounts.filter((account) => account.disabled).length;
  const parts = [
    `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`,
    `${admins} ${admins === 1 ? "admin" : "admins"}`,
  ];
  if (disabled > 0) parts.push(`${disabled} disabled`);
  return parts.join(" · ");
}

"use client";

import { Ellipsis, KeyRound, ShieldOff, Trash2, UserCheck, UserCog, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { PublicAccount } from "@/lib/local-accounts";
import type { AccountActions } from "./account-dialogs";
import { formatCreated, RoleBadge, StatusBadge, TwoFactorStatus, YouTag } from "./account-parts";
import { accessAction, roleAction } from "./use-accounts";

/**
 * The accounts as one table: badges for role and status, a quiet two-factor mark, and every row
 * action behind a single "..." menu. Below md the secondary columns fold under the email, so the
 * table never scrolls sideways and a long email truncates instead.
 */

const HEAD = "h-10 text-xs font-medium text-fg-muted uppercase";

function RowMenu({ account, actions }: { account: PublicAccount; actions: AccountActions }) {
  const role = roleAction(account);
  const access = accessAction(account);
  return (
    // Not modal: most items hand over to a dialog, and that dialog is the one layer that should trap focus.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`Actions for ${account.email}`}
          className="text-fg-muted hover:text-fg"
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 border-hairline-strong bg-raised text-fg-secondary">
        <DropdownMenuLabel className="truncate text-xs font-normal text-fg-muted">{account.email}</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-hairline" />
        <DropdownMenuItem data-testid={`role-${account.email}`} onSelect={() => actions.request(account, role)}>
          <UserCog />
          {role === "make-admin" ? "Make admin" : "Make user"}
        </DropdownMenuItem>
        <DropdownMenuItem data-testid={`password-${account.email}`} onSelect={() => actions.openPassword(account)}>
          <KeyRound />
          Set password
        </DropdownMenuItem>
        {account.totpEnabled ? (
          <DropdownMenuItem
            data-testid={`clear-totp-${account.email}`}
            onSelect={() => actions.request(account, "clear-totp")}
          >
            <ShieldOff />
            Clear two-factor
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem data-testid={`disabled-${account.email}`} onSelect={() => actions.request(account, access)}>
          {access === "enable" ? <UserCheck /> : <UserX />}
          {access === "enable" ? "Enable account" : "Disable account"}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-hairline" />
        <DropdownMenuItem
          data-testid={`delete-${account.email}`}
          onSelect={() => actions.request(account, "delete")}
          className="text-danger focus:bg-danger-tint/10 focus:text-danger"
        >
          <Trash2 className="text-danger" />
          Delete account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AccountsTableSkeleton() {
  return (
    <div aria-busy="true" className="overflow-hidden rounded-xl border border-hairline bg-panel">
      <span className="sr-only">Loading accounts</span>
      <div className="h-10 border-b border-hairline" />
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="flex items-center gap-6 border-b border-hairline px-4 py-3.5 last:border-0">
          <Skeleton className="h-4 w-48 bg-fill-strong sm:w-64" />
          <Skeleton className="hidden h-5 w-14 rounded-full bg-fill-strong md:block" />
          <Skeleton className="hidden h-5 w-16 rounded-full bg-fill-strong md:block" />
          <Skeleton className="ml-auto size-6 bg-fill-strong" />
        </div>
      ))}
    </div>
  );
}

export function AccountsTable({
  accounts,
  isMe,
  actions,
}: {
  accounts: PublicAccount[];
  isMe: (account: PublicAccount) => boolean;
  actions: AccountActions;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="border-hairline hover:bg-transparent">
          <TableHead className={cn(HEAD, "pl-4")}>Email</TableHead>
          <TableHead className={cn(HEAD, "hidden md:table-cell")}>Role</TableHead>
          <TableHead className={cn(HEAD, "hidden md:table-cell")}>Status</TableHead>
          <TableHead className={cn(HEAD, "hidden md:table-cell")}>Two-factor</TableHead>
          <TableHead className={cn(HEAD, "hidden lg:table-cell")}>Created</TableHead>
          <TableHead className="w-12 pr-3">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((account) => (
          <TableRow key={account.email} className="border-hairline hover:bg-fill-subtle">
            <TableCell className="w-full max-w-0 py-3 pl-4">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn("truncate font-medium", account.disabled ? "text-fg-muted" : "text-fg")}
                  title={account.email}
                >
                  {account.email}
                </span>
                {isMe(account) ? <YouTag /> : null}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 md:hidden">
                <RoleBadge role={account.role} />
                <StatusBadge disabled={account.disabled} />
                {account.totpEnabled ? <TwoFactorStatus enabled className="ml-1" /> : null}
              </div>
            </TableCell>
            <TableCell className="hidden py-3 md:table-cell">
              <RoleBadge role={account.role} />
            </TableCell>
            <TableCell className="hidden py-3 md:table-cell">
              <StatusBadge disabled={account.disabled} />
            </TableCell>
            <TableCell className="hidden py-3 md:table-cell">
              <TwoFactorStatus enabled={account.totpEnabled} />
            </TableCell>
            <TableCell className="hidden py-3 text-xs text-fg-muted tabular-nums lg:table-cell">
              {formatCreated(account.createdAt)}
            </TableCell>
            <TableCell className="py-3 pr-3 text-right">
              <RowMenu account={account} actions={actions} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

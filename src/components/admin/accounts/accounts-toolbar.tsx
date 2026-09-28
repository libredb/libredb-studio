"use client";

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PublicAccount } from "@/lib/local-accounts";

/** Search by email, one filter, and the count line above the Accounts table. */

export type AccountFilter = "all" | "admin" | "user" | "disabled" | "totp-on" | "totp-off";

const FILTERS: Record<AccountFilter, { label: string; test: (account: PublicAccount) => boolean }> = {
  all: { label: "All accounts", test: () => true },
  admin: { label: "Admins", test: (account) => account.role === "admin" },
  user: { label: "Users", test: (account) => account.role === "user" },
  disabled: { label: "Disabled", test: (account) => account.disabled },
  "totp-on": { label: "Two-factor on", test: (account) => account.totpEnabled },
  "totp-off": { label: "Two-factor off", test: (account) => !account.totpEnabled },
};

const FILTER_KEYS = Object.keys(FILTERS) as AccountFilter[];

export function filterAccounts(accounts: PublicAccount[], query: string, filter: AccountFilter): PublicAccount[] {
  const needle = query.trim().toLowerCase();
  return accounts.filter((account) => FILTERS[filter].test(account) && account.email.toLowerCase().includes(needle));
}

const CONTROL = "h-9 border-hairline-strong bg-panel";

export function AccountsToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  count,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  filter: AccountFilter;
  onFilterChange: (filter: AccountFilter) => void;
  count: string;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative sm:w-72">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle"
        />
        <Input
          type="search"
          aria-label="Search accounts by email"
          placeholder="Search by email"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          className={`${CONTROL} pl-9`}
        />
      </div>
      <Select value={filter} onValueChange={(value) => onFilterChange(value as AccountFilter)}>
        <SelectTrigger aria-label="Filter accounts" className={`${CONTROL} w-full sm:w-48`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="border-hairline-strong bg-raised text-fg-secondary">
          {FILTER_KEYS.map((key) => (
            <SelectItem key={key} value={key}>
              {FILTERS[key].label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p aria-live="polite" className="text-xs text-fg-muted sm:ml-auto">
        {count}
      </p>
    </div>
  );
}

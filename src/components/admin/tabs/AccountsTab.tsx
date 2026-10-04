"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useAccountActions } from "@/components/admin/accounts/account-dialogs";
import { accountSummary } from "@/components/admin/accounts/account-parts";
import {
  AccountsEmpty,
  AccountsError,
  AccountsNoMatch,
  AccountsUnavailable,
} from "@/components/admin/accounts/account-states";
import { AccountsTable, AccountsTableSkeleton } from "@/components/admin/accounts/accounts-table";
import { AccountsToolbar, filterAccounts, type AccountFilter } from "@/components/admin/accounts/accounts-toolbar";
import { useAccounts } from "@/components/admin/accounts/use-accounts";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";
import { PasskeySettings } from "@/components/auth/PasskeySettings";
import { Button } from "@/components/ui/button";

/**
 * The admin Accounts screen (#784): the local email and password accounts as one table with a
 * search and a filter above it, and the signed-in admin's own authenticator and passkeys below.
 * Both need the account registry, so they are hidden with it.
 */
export function AccountsTab() {
  const controller = useAccounts();
  const actions = useAccountActions(controller);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  // Advanced when the authenticator changes, so the passkey section re-reads whether a code is needed.
  // The table's version joins it, so a change to the admin's own row there reaches the passkey section too.
  const [factorVersion, setFactorVersion] = useState(0);
  const { view } = controller;

  let content: React.ReactNode;
  if (view.kind === "loading") {
    content = <AccountsTableSkeleton />;
  } else if (view.kind === "unavailable") {
    content = <AccountsUnavailable message={view.message} />;
  } else if (view.kind === "error") {
    content = <AccountsError message={view.message} onRetry={controller.retry} />;
  } else if (view.accounts.length === 0) {
    content = <AccountsEmpty onAdd={actions.openCreate} />;
  } else {
    const visible = filterAccounts(view.accounts, query, filter);
    const narrowed = query.trim() !== "" || filter !== "all";
    content = (
      <div className="space-y-3">
        <AccountsToolbar
          query={query}
          onQueryChange={setQuery}
          filter={filter}
          onFilterChange={setFilter}
          count={narrowed ? `${visible.length} of ${view.accounts.length} accounts` : accountSummary(view.accounts)}
        />
        <div className="overflow-hidden rounded-xl border border-hairline bg-panel">
          {visible.length === 0 ? (
            <AccountsNoMatch
              onClear={() => {
                setQuery("");
                setFilter("all");
              }}
            />
          ) : (
            <AccountsTable accounts={visible} isMe={controller.isMe} actions={actions} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <section aria-labelledby="accounts-heading" className="space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h2 id="accounts-heading" className="text-lg font-semibold tracking-tight text-fg">
              Accounts
            </h2>
            <p className="text-sm text-fg-muted">
              Local email and password sign-ins. Each account keeps its own saved connections.
            </p>
          </div>
          {view.kind === "ready" ? (
            <Button
              type="button"
              onClick={actions.openCreate}
              className="self-start bg-brand-solid text-white hover:bg-brand-solid-hover sm:self-auto"
            >
              <Plus />
              Add account
            </Button>
          ) : null}
        </div>
        {content}
      </section>
      {view.kind === "unavailable" ? null : (
        <>
          <AuthenticatorSettings onChange={() => setFactorVersion((value) => value + 1)} />
          <PasskeySettings reloadSignal={factorVersion + controller.version} onChange={controller.refresh} />
        </>
      )}
      {actions.dialogs}
    </div>
  );
}

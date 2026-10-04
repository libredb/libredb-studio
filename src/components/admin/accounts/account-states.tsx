"use client";

import { CircleAlert, DatabaseZap, Plus, RotateCw, SearchX, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";

/** The states of the Accounts screen that have no rows to show. */

const FRAME = "rounded-xl border border-solid border-hairline bg-panel";
const MEDIA = "bg-fill text-fg-muted";

export function AccountsUnavailable({ message }: { message: string }) {
  return (
    <Empty className={FRAME}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className={MEDIA}>
          <DatabaseZap />
        </EmptyMedia>
        <EmptyTitle className="text-base text-fg">The account registry is off</EmptyTitle>
        <EmptyDescription className="text-fg-muted" data-testid="accounts-unavailable">
          {message}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function AccountsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Empty className={FRAME}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-danger-tint/10 text-danger">
          <CircleAlert />
        </EmptyMedia>
        <EmptyTitle className="text-base text-fg">Accounts could not be loaded</EmptyTitle>
        <EmptyDescription className="text-fg-muted" data-testid="accounts-error">
          {message}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="sm" className="border-hairline-strong" onClick={onRetry}>
          <RotateCw />
          Try again
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function AccountsEmpty({ onAdd }: { onAdd: () => void }) {
  return (
    <Empty className={FRAME}>
      <EmptyHeader>
        <EmptyMedia variant="icon" className={MEDIA}>
          <Users />
        </EmptyMedia>
        <EmptyTitle className="text-base text-fg">No accounts yet</EmptyTitle>
        <EmptyDescription className="text-fg-muted">
          Add an account for each person who signs in with an email and password.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button
          type="button"
          size="sm"
          className="bg-brand-solid text-white hover:bg-brand-solid-hover"
          onClick={onAdd}
        >
          <Plus />
          Add account
        </Button>
      </EmptyContent>
    </Empty>
  );
}

/** The search or the filter hides every row; the list itself is not empty. */
export function AccountsNoMatch({ onClear }: { onClear: () => void }) {
  return (
    <Empty className="py-10 md:py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon" className={MEDIA}>
          <SearchX />
        </EmptyMedia>
        <EmptyTitle className="text-base text-fg">No matching accounts</EmptyTitle>
        <EmptyDescription className="text-fg-muted">Try a different email, or show all accounts.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button type="button" variant="outline" size="sm" className="border-hairline-strong" onClick={onClear}>
          Clear search and filter
        </Button>
      </EmptyContent>
    </Empty>
  );
}

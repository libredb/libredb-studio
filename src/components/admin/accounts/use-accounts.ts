"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { appFetch } from "@/lib/config/base-path";
import type { PublicAccount } from "@/lib/local-accounts";

/**
 * Everything the Accounts screen does, kept apart from how it looks. Each mutation resolves to an
 * error message, or null on success, so the caller can show the refusal next to the control that
 * caused it; a success is announced with a toast.
 */

export type AccountsView =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; accounts: PublicAccount[] };

/** A change that needs nothing beyond the account it applies to. */
export type AccountAction = "make-admin" | "make-user" | "disable" | "enable" | "clear-totp" | "delete";

interface ActionSpec {
  body: Record<string, unknown> | null;
  success: (email: string) => string;
  failure: string;
}

const ACTIONS: Record<AccountAction, ActionSpec> = {
  "make-admin": {
    body: { role: "admin" },
    success: (email) => `${email} is now an admin`,
    failure: "Could not change the role",
  },
  "make-user": {
    body: { role: "user" },
    success: (email) => `${email} is now a user`,
    failure: "Could not change the role",
  },
  disable: {
    body: { disabled: true },
    success: (email) => `${email} is disabled`,
    failure: "Could not update the account",
  },
  enable: {
    body: { disabled: false },
    success: (email) => `${email} is enabled`,
    failure: "Could not update the account",
  },
  "clear-totp": {
    body: { clearTotp: true },
    success: (email) => `Two-factor cleared for ${email}`,
    failure: "Could not clear the authenticator",
  },
  delete: {
    body: null,
    success: (email) => `${email} was deleted`,
    failure: "Could not delete the account",
  },
};

/** The role toggle a row offers, named by what it would do. */
export function roleAction(account: PublicAccount): AccountAction {
  return account.role === "admin" ? "make-user" : "make-admin";
}

/** The access toggle a row offers, named by what it would do. */
export function accessAction(account: PublicAccount): AccountAction {
  return account.disabled ? "enable" : "disable";
}

export interface NewAccount {
  email: string;
  password: string;
  role: "admin" | "user";
}

/** The shortest password the admin API accepts (src/lib/local-accounts.ts refuses anything shorter). */
export const PASSWORD_MIN_LENGTH = 8;

async function readError(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error;
  } catch {
    return undefined;
  }
}

function accountPath(email: string): string {
  return `/api/admin/accounts/${encodeURIComponent(email)}`;
}

export function useAccounts() {
  const [view, setView] = useState<AccountsView>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [me, setMe] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch(`/api/admin/accounts?r=${reload}`);
        const body = (await res.json()) as { error?: string; accounts?: PublicAccount[] };
        if (cancelled) return;
        if (res.status === 409) {
          setView({ kind: "unavailable", message: body.error ?? "Accounts are not available on this server." });
          return;
        }
        if (!res.ok || !body.accounts) {
          setView({ kind: "error", message: body.error ?? "Could not load accounts" });
          return;
        }
        setView({ kind: "ready", accounts: body.accounts });
      } catch {
        if (!cancelled) setView({ kind: "error", message: "Could not load accounts" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/auth/me");
        if (!res.ok) return;
        const body = (await res.json()) as { user?: { username?: string } };
        if (!cancelled && body.user?.username) setMe(body.user.username.toLowerCase());
      } catch {
        // Only the "You" marker reads this, and the screen is complete without it.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function refresh() {
    setReload((value) => value + 1);
  }

  function retry() {
    setView({ kind: "loading" });
    refresh();
  }

  function isMe(account: PublicAccount): boolean {
    return me !== null && account.email.toLowerCase() === me;
  }

  async function run(account: PublicAccount, action: AccountAction): Promise<string | null> {
    const spec = ACTIONS[action];
    try {
      const res =
        spec.body === null
          ? await appFetch(accountPath(account.email), { method: "DELETE" })
          : await appFetch(accountPath(account.email), {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(spec.body),
            });
      if (!res.ok) return (await readError(res)) ?? spec.failure;
      toast.success(spec.success(account.email));
      refresh();
      return null;
    } catch {
      return spec.failure;
    }
  }

  async function create(input: NewAccount): Promise<string | null> {
    try {
      const res = await appFetch("/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) return (await readError(res)) ?? "Could not create the account";
      toast.success(`Account created for ${input.email.trim()}`);
      refresh();
      return null;
    } catch {
      return "Could not create the account";
    }
  }

  async function setPassword(account: PublicAccount, password: string): Promise<string | null> {
    try {
      const res = await appFetch(accountPath(account.email), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) return (await readError(res)) ?? "Could not set the password";
      toast.success(`New password set for ${account.email}`);
      refresh();
      return null;
    } catch {
      return "Could not set the password";
    }
  }

  return { view, isMe, retry, run, create, setPassword };
}

export type AccountsController = ReturnType<typeof useAccounts>;

"use client";

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AuthenticatorSettings } from "@/components/auth/AuthenticatorSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appFetch } from "@/lib/config/base-path";
import type { PublicAccount } from "@/lib/local-accounts";

type View =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; accounts: PublicAccount[] };

async function readBody(res: Response): Promise<{ error?: string; accounts?: PublicAccount[] }> {
  return (await res.json()) as { error?: string; accounts?: PublicAccount[] };
}

export function AccountsTab() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch(`/api/admin/accounts?r=${reload}`);
        const body = await readBody(res);
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

  function refresh(message: string | null) {
    setNotice(message);
    setReload((value) => value + 1);
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    const res = await appFetch("/api/admin/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, role }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      refresh(body.error ?? "Could not create the account");
      return;
    }
    setEmail("");
    setPassword("");
    refresh(null);
  }

  async function patch(accountEmail: string, body: Record<string, unknown>, failure: string) {
    const res = await appFetch(`/api/admin/accounts/${encodeURIComponent(accountEmail)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await readBody(res);
    refresh(res.ok ? null : (payload.error ?? failure));
  }

  async function remove(accountEmail: string) {
    const res = await appFetch(`/api/admin/accounts/${encodeURIComponent(accountEmail)}`, { method: "DELETE" });
    const payload = await readBody(res);
    refresh(res.ok ? null : (payload.error ?? "Could not delete the account"));
  }

  if (view.kind === "loading") {
    return <p className="text-sm text-fg-muted">Loading accounts…</p>;
  }
  if (view.kind === "unavailable") {
    return (
      <p className="text-sm text-fg-muted" data-testid="accounts-unavailable">
        {view.message}
      </p>
    );
  }
  if (view.kind === "error") {
    return (
      <p className="text-sm text-danger" data-testid="accounts-error">
        {view.message}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-fg">Accounts</h2>
        <p className="text-sm text-fg-muted">
          Local email and password accounts. Each one keeps its own saved connections.
        </p>
      </div>
      {notice ? (
        <p className="text-sm text-danger" role="alert">
          {notice}
        </p>
      ) : null}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-fg-muted">
            <th className="py-2 pr-3 font-medium">Email</th>
            <th className="py-2 pr-3 font-medium">Role</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium">MFA</th>
            <th className="py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {view.accounts.map((account) => (
            <tr key={account.email} className="border-t border-hairline">
              <td className="py-2 pr-3">{account.email}</td>
              <td className="py-2 pr-3">{account.role}</td>
              <td className="py-2 pr-3">{account.disabled ? "Disabled" : "Active"}</td>
              <td className="py-2 pr-3">{account.totpEnabled ? "On" : "Off"}</td>
              <td className="py-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`role-${account.email}`}
                    onClick={() =>
                      void patch(
                        account.email,
                        { role: account.role === "admin" ? "user" : "admin" },
                        "Could not change the role",
                      )
                    }
                  >
                    {account.role === "admin" ? "Make user" : "Make admin"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`disabled-${account.email}`}
                    onClick={() =>
                      void patch(account.email, { disabled: !account.disabled }, "Could not update the account")
                    }
                  >
                    {account.disabled ? "Enable" : "Disable"}
                  </Button>
                  {account.totpEnabled ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid={`clear-totp-${account.email}`}
                      onClick={() =>
                        void patch(account.email, { clearTotp: true }, "Could not clear the authenticator")
                      }
                    >
                      Clear MFA
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid={`delete-${account.email}`}
                    onClick={() => setPendingDelete(account.email)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent className="bg-surface border-hairline-strong">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-fg">Delete account?</AlertDialogTitle>
            <AlertDialogDescription className="text-fg-tertiary">
              <span className="font-mono text-fg">{pendingDelete}</span> can no longer sign in, and its saved
              connections, history and saved queries are removed. This cannot be undone. Disable the account instead to
              keep them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-hairline-strong text-fg-tertiary">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) void remove(pendingDelete);
                setPendingDelete(null);
              }}
              className="bg-danger-solid text-white hover:bg-danger-solid-hover"
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => void onCreate(event)}>
        <Input
          aria-label="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="email"
          className="w-56"
        />
        <Input
          aria-label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="password"
          className="w-48"
        />
        <select
          aria-label="Role"
          value={role}
          onChange={(event) => setRole(event.target.value === "admin" ? "admin" : "user")}
          className="h-9 rounded-md border border-hairline-strong bg-panel px-2 text-sm"
        >
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <Button type="submit">Create account</Button>
      </form>
      <AuthenticatorSettings />
    </div>
  );
}

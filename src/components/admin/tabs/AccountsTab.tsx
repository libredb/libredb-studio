"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appFetch } from "@/lib/config/base-path";
import type { PublicAccount } from "@/lib/local-accounts";

type View =
  | { kind: "loading" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; accounts: PublicAccount[] };

async function readBody(
  res: Response,
): Promise<{ error?: string; accounts?: PublicAccount[]; secret?: string; otpauthUrl?: string }> {
  return (await res.json()) as { error?: string; accounts?: PublicAccount[]; secret?: string; otpauthUrl?: string };
}

export function AccountsTab() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

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
    setSecret(null);
    setOtpauthUrl(null);
    setCode("");
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

  async function beginEnrol() {
    const res = await appFetch("/api/auth/totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "begin" }),
    });
    const body = await readBody(res);
    if (!res.ok || !body.secret) {
      refresh(body.error ?? "Could not start authenticator setup");
      return;
    }
    setSecret(body.secret);
    setOtpauthUrl(body.otpauthUrl ?? null);
  }

  async function confirmEnrol(event: React.FormEvent) {
    event.preventDefault();
    const res = await appFetch("/api/auth/totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", code }),
    });
    const body = await readBody(res);
    if (!res.ok) {
      setNotice(body.error ?? "Invalid authentication code");
      return;
    }
    refresh(null);
  }

  async function disableEnrol() {
    const res = await appFetch("/api/auth/totp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disable" }),
    });
    const body = await readBody(res);
    refresh(res.ok ? null : (body.error ?? "Could not turn off the authenticator"));
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
                    onClick={() => void remove(account.email)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-fg">Your authenticator</h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void beginEnrol()}>
            Set up authenticator
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void disableEnrol()}>
            Turn off authenticator
          </Button>
        </div>
        {secret ? (
          <form className="space-y-2" onSubmit={(event) => void confirmEnrol(event)}>
            <p className="text-sm text-fg-muted">
              Add this secret to your authenticator app, then enter the 6-digit code.
            </p>
            <code data-testid="totp-secret">{secret}</code>
            {otpauthUrl ? <p className="text-xs text-fg-muted break-all">{otpauthUrl}</p> : null}
            <Input
              aria-label="Authentication code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              className="w-40"
            />
            <Button type="submit" size="sm">
              Confirm code
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

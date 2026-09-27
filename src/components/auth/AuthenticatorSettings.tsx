"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { appFetch } from "@/lib/config/base-path";
import type { OwnFactorStatus } from "@/lib/local-accounts";

/**
 * The signed-in account's own authenticator, in its simplest form (#784). Shared by the admin
 * Accounts tab and /settings/authenticator, so a user without admin rights can set one up too.
 *
 * Setup and turning off both ask for the current password, and turning off asks for a current
 * code as well: the server refuses either change on the session cookie alone.
 */

type View =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; status: OwnFactorStatus };

interface TotpResponse {
  error?: string;
  secret?: string;
  otpauthUrl?: string;
}

async function post(body: Record<string, string>): Promise<{ ok: boolean; body: TotpResponse }> {
  const res = await appFetch("/api/auth/totp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, body: (await res.json()) as TotpResponse };
}

export function AuthenticatorSettings() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await appFetch("/api/auth/totp");
        const body = (await res.json()) as OwnFactorStatus & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setView({ kind: "error", message: body.error ?? "Could not read the authenticator status" });
          return;
        }
        setView({ kind: "loaded", status: body });
      } catch {
        if (!cancelled) setView({ kind: "error", message: "Could not read the authenticator status" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

  function done() {
    setNotice(null);
    setPassword("");
    setCurrentCode("");
    setSecret(null);
    setOtpauthUrl(null);
    setCode("");
    setReload((value) => value + 1);
  }

  async function begin() {
    const result = await post({ action: "begin", password });
    if (!result.ok || !result.body.secret) {
      setNotice(result.body.error ?? "Could not start authenticator setup");
      return;
    }
    setNotice(null);
    setSecret(result.body.secret);
    setOtpauthUrl(result.body.otpauthUrl ?? null);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    const result = await post({ action: "confirm", code });
    if (!result.ok) {
      setNotice(result.body.error ?? "Invalid authentication code");
      return;
    }
    done();
  }

  async function turnOff() {
    const result = await post({ action: "disable", password, code: currentCode });
    if (!result.ok) {
      setNotice(result.body.error ?? "Could not turn off the authenticator");
      return;
    }
    done();
  }

  if (view.kind === "loading") return <p className="text-sm text-fg-muted">Loading authenticator status…</p>;
  if (view.kind === "error") {
    return (
      <p className="text-sm text-danger" data-testid="authenticator-error">
        {view.message}
      </p>
    );
  }
  const { status } = view;

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-fg">Your authenticator</h3>
      {!status.available ? (
        <p className="text-sm text-fg-muted" data-testid="authenticator-unavailable">
          {status.reason}
        </p>
      ) : (
        <>
          <p className="text-sm text-fg-muted">
            Status: <span className="text-fg">{status.enabled ? "On" : "Off"}</span>
          </p>
          {notice ? (
            <p className="text-sm text-danger" role="alert">
              {notice}
            </p>
          ) : null}
          <div className="flex flex-wrap items-end gap-2">
            <Input
              aria-label="Current password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="current password"
              className="w-48"
            />
            {status.enabled ? (
              <>
                <Input
                  aria-label="Current code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={currentCode}
                  onChange={(event) => setCurrentCode(event.target.value)}
                  placeholder="current code"
                  className="w-32"
                />
                <Button type="button" variant="outline" size="sm" onClick={() => void turnOff()}>
                  Turn off authenticator
                </Button>
              </>
            ) : (
              <Button type="button" variant="outline" size="sm" onClick={() => void begin()}>
                Set up authenticator
              </Button>
            )}
          </div>
          {secret ? (
            <form className="space-y-2" onSubmit={(event) => void confirm(event)}>
              <p className="text-sm text-fg-muted">
                Add this secret to your authenticator app, then enter the 6-digit code.
              </p>
              <code data-testid="totp-secret">{secret}</code>
              {otpauthUrl ? <p className="text-xs text-fg-muted break-all">{otpauthUrl}</p> : null}
              <Input
                aria-label="Authentication code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="w-40"
              />
              <Button type="submit" size="sm">
                Confirm code
              </Button>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

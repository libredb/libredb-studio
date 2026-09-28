"use client";

import { useEffect, useState } from "react";
import { Copy, Info } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { appFetch } from "@/lib/config/base-path";
import { cn } from "@/lib/utils";
import type { OwnFactorStatus } from "@/lib/local-accounts";

/**
 * The signed-in account's own authenticator (#784). Shared by the admin Accounts tab and
 * /settings/authenticator, so a user without admin rights can set one up too.
 *
 * Setup and turning off both ask for the current password, and turning off asks for a current
 * code as well: the server refuses either change on the session cookie alone.
 */

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; status: OwnFactorStatus };

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

const INPUT_CLASS = "border-hairline-strong bg-panel";

function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "on" | "off" | "pending" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "on" && "border-success-tint/25 bg-success-tint/10 text-success",
        tone === "off" && "border-hairline-strong text-fg-muted",
        tone === "pending" && "border-warning-tint/25 bg-warning-tint/10 text-warning",
      )}
    >
      {label}
    </Badge>
  );
}

function Step({ index, title, children }: { index: number; title: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[1.5rem_1fr] gap-x-3 gap-y-2">
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-full border border-hairline-strong text-xs font-medium text-fg-muted"
      >
        {index}
      </span>
      <p className="self-center text-sm font-medium text-fg">{title}</p>
      <div className="col-start-2 min-w-0 space-y-3">{children}</div>
    </li>
  );
}

export function AuthenticatorSettings() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [currentCode, setCurrentCode] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // `r` is read so the reload counter is a real input of this effect, not a bare trigger.
        const res = await appFetch(`/api/auth/totp?r=${reload}`);
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

  function reset() {
    setNotice(null);
    setPassword("");
    setCurrentCode("");
    setSecret(null);
    setOtpauthUrl(null);
    setCode("");
  }

  function done(message: string) {
    reset();
    toast.success(message);
    setReload((value) => value + 1);
  }

  async function begin(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await post({ action: "begin", password });
    setBusy(false);
    if (!result.ok || !result.body.secret) {
      setNotice(result.body.error ?? "Could not start authenticator setup");
      return;
    }
    setNotice(null);
    setPassword("");
    setSecret(result.body.secret);
    setOtpauthUrl(result.body.otpauthUrl ?? null);
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await post({ action: "confirm", code });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.body.error ?? "Invalid authentication code");
      // A refused code is spent; clearing it lets the next one be typed straight into the first slot.
      setCode("");
      return;
    }
    done("Authenticator is on");
  }

  async function turnOff(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await post({ action: "disable", password, code: currentCode });
    setBusy(false);
    if (!result.ok) {
      setNotice(result.body.error ?? "Could not turn off the authenticator");
      return;
    }
    done("Authenticator is off");
  }

  async function copySecret(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Key copied");
    } catch {
      toast.error("Could not copy the key. Select it and copy it by hand.");
    }
  }

  const status = view.kind === "loaded" ? view.status : null;
  let badge: React.ReactNode = null;
  if (status?.available) {
    if (secret) badge = <StatusBadge label="Setting up" tone="pending" />;
    else badge = <StatusBadge label={status.enabled ? "On" : "Off"} tone={status.enabled ? "on" : "off"} />;
  }

  let body: React.ReactNode;
  if (view.kind === "loading") {
    body = (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">Loading authenticator status</span>
        <Skeleton className="h-4 w-2/3 bg-fill-strong" />
        <Skeleton className="h-9 w-full max-w-sm bg-fill-strong" />
      </div>
    );
  } else if (view.kind === "error") {
    body = (
      <p className="text-sm text-danger" data-testid="authenticator-error">
        {view.message}
      </p>
    );
  } else if (!view.status.available) {
    body = (
      <div className="flex gap-2 text-sm text-fg-muted">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p data-testid="authenticator-unavailable">{view.status.reason}</p>
      </div>
    );
  } else if (secret) {
    body = (
      <form className="space-y-5" onSubmit={(event) => void confirm(event)}>
        <ol className="space-y-5">
          <Step index={1} title="Add LibreDB to your authenticator app">
            <p className="text-sm text-fg-muted">Type this key into the app, or open the setup link on this device.</p>
            <div className="flex max-w-md items-center gap-2">
              <code
                data-testid="totp-secret"
                className="min-w-0 flex-1 rounded-md border border-hairline-strong bg-fill-subtle px-3 py-2 font-mono text-sm tracking-wider break-all text-fg"
              >
                {secret}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Copy key"
                className="border-hairline-strong"
                onClick={() => void copySecret(secret)}
              >
                <Copy />
              </Button>
            </div>
            {otpauthUrl ? (
              <a
                href={otpauthUrl}
                className="block font-mono text-xs break-all text-fg-muted underline-offset-4 hover:text-fg-secondary hover:underline"
              >
                {otpauthUrl}
              </a>
            ) : null}
          </Step>
          <Step index={2} title="Enter the 6-digit code it shows">
            <InputOTP
              maxLength={6}
              value={code}
              onChange={setCode}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="^[0-9]*$"
              aria-label="Authentication code"
            >
              <InputOTPGroup>
                {[0, 1, 2, 3, 4, 5].map((index) => (
                  <InputOTPSlot key={index} index={index} className="border-hairline-strong" />
                ))}
              </InputOTPGroup>
            </InputOTP>
          </Step>
        </ol>
        <Notice message={notice} />
        <div className="flex flex-wrap gap-2 pl-9">
          <Button type="submit" disabled={busy} className="bg-brand-solid text-white hover:bg-brand-solid-hover">
            {busy ? <Spinner aria-hidden /> : null}
            Confirm code
          </Button>
          <Button type="button" variant="ghost" className="text-fg-muted hover:text-fg-secondary" onClick={reset}>
            Cancel
          </Button>
        </div>
      </form>
    );
  } else if (view.status.enabled) {
    body = (
      <form className="space-y-4" onSubmit={(event) => void turnOff(event)}>
        <p className="text-sm text-fg-muted">
          Every sign-in asks for a code after your password. To turn it off, confirm your password and a current code.
        </p>
        <div className="grid gap-3 @xl:grid-cols-[minmax(0,16rem)_minmax(0,9rem)_auto] @xl:items-end">
          <Field className="gap-2">
            <FieldLabel htmlFor="authenticator-password">Current password</FieldLabel>
            <Input
              id="authenticator-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
            />
          </Field>
          <Field className="gap-2">
            <FieldLabel htmlFor="authenticator-current-code">Current code</FieldLabel>
            <Input
              id="authenticator-current-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={currentCode}
              onChange={(event) => setCurrentCode(event.target.value)}
              placeholder="123456"
              className={cn(INPUT_CLASS, "font-mono tracking-widest")}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={busy}
            className="justify-self-start border-hairline-strong text-danger hover:bg-danger-tint/10 hover:text-danger"
          >
            {busy ? <Spinner aria-hidden /> : null}
            Turn off authenticator
          </Button>
        </div>
        <Notice message={notice} />
      </form>
    );
  } else {
    body = (
      <form className="space-y-4" onSubmit={(event) => void begin(event)}>
        <div className="grid gap-3 @md:grid-cols-[minmax(0,16rem)_auto] @md:items-end">
          <Field className="gap-2">
            <FieldLabel htmlFor="authenticator-password">Current password</FieldLabel>
            <Input
              id="authenticator-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={INPUT_CLASS}
            />
          </Field>
          <Button type="submit" variant="outline" disabled={busy} className="justify-self-start border-hairline-strong">
            {busy ? <Spinner aria-hidden /> : null}
            Set up authenticator
          </Button>
        </div>
        <FieldDescription className="text-fg-muted">
          Confirm your password first. You will need an app such as 1Password, Google Authenticator or Authy.
        </FieldDescription>
        <Notice message={notice} />
      </form>
    );
  }

  return (
    <section aria-labelledby="authenticator-heading" className="@container rounded-xl border border-hairline bg-panel">
      <div className="flex items-start justify-between gap-4 p-5">
        <div className="min-w-0 space-y-1">
          <h3 id="authenticator-heading" className="text-sm font-semibold text-fg">
            Your authenticator
          </h3>
          <p className="text-sm text-fg-muted">
            A 6-digit code from an app on your phone, asked for after your password.
          </p>
        </div>
        {badge}
      </div>
      <div className="border-t border-hairline p-5">{body}</div>
    </section>
  );
}

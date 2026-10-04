"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { appFetch } from "@/lib/config/base-path";
import type { PasskeyStatus, PublicPasskey } from "@/lib/passkey/api-types";
import {
  beginPasskeyCreation,
  finishPasskeyCreation,
  PAGE_IP_ADDRESS,
  PAGE_PLAIN_HTTP,
  passkeyPageBlocker,
  passkeysUsableHere,
  type PasskeySetup,
  removePasskey,
  renamePasskey,
  UNSUPPORTED_BROWSER,
} from "@/lib/passkey/client";
import { PASSKEY_NAME_MAX_LENGTH } from "@/lib/passkey/policy";
import { cn } from "@/lib/utils";

/**
 * The signed-in account's own passkeys (#785), below the authenticator on the same pages. The
 * states follow one order: what the page itself cannot do is said before any server reason, so
 * nobody is sent after a server variable that cannot help on an IP address or plain http.
 *
 * Adding and removing ask for the password (and a code when the server says so); adding keeps the
 * setup it got, so a cancelled browser prompt is retried without re-sending a spent code.
 */

type View = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; status: PasskeyStatus };

const INPUT_CLASS = "border-hairline-strong bg-panel";
const PRIMARY_BUTTON = "bg-brand-solid text-white hover:bg-brand-solid-hover";
const CANCEL_BUTTON = "border-hairline-strong text-fg-tertiary";
const PASSWORD_LINE = "Adding or removing a passkey asks for your password. Forgot it? An admin can set a new one.";
const TOTP_NOTICE = "Your passkeys sign you in without the authenticator code. Remove any you do not recognise.";
const REMOVED_REMINDER =
  "Delete it from your password manager or security key too. MCP tokens you created stop working; create a new one under MCP.";

function Notice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function Reason({ text }: { text: string }) {
  return (
    <div className="flex gap-2 text-sm text-fg-muted">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <p>{text}</p>
    </div>
  );
}

function PasskeyBadge({ label, tone }: { label: string; tone: "on" | "off" | "pending" | "danger" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === "on" && "border-success-tint/25 bg-success-tint/10 text-success",
        tone === "off" && "border-hairline-strong text-fg-muted",
        tone === "pending" && "border-warning-tint/25 bg-warning-tint/10 text-warning",
        tone === "danger" && "border-danger-tint/25 bg-danger-tint/10 text-danger",
      )}
    >
      {label}
    </Badge>
  );
}

// Backup eligibility says whether it can sync at all, backup state whether it has.
function SyncBadge({ passkey }: { passkey: PublicPasskey }) {
  if (!passkey.backupEligible) return <PasskeyBadge label="This device only" tone="off" />;
  if (passkey.backupState) return <PasskeyBadge label="Synced" tone="on" />;
  return <PasskeyBadge label="Not synced yet" tone="pending" />;
}

function PasswordFields({
  prefix,
  password,
  onPassword,
  code,
  onCode,
  codeRequired,
}: {
  prefix: string;
  password: string;
  onPassword: (value: string) => void;
  code: string;
  onCode: (value: string) => void;
  codeRequired: boolean;
}) {
  return (
    <>
      <Field className="gap-2">
        <FieldLabel htmlFor={`${prefix}-password`}>Current password</FieldLabel>
        <Input
          id={`${prefix}-password`}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => onPassword(event.target.value)}
          className={INPUT_CLASS}
        />
      </Field>
      {codeRequired ? (
        <Field className="gap-2">
          <FieldLabel htmlFor={`${prefix}-code`}>Current code</FieldLabel>
          <Input
            id={`${prefix}-code`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => onCode(event.target.value)}
            placeholder="123456"
            className={cn(INPUT_CLASS, "font-mono tracking-widest")}
          />
        </Field>
      ) : null}
      <FieldDescription className="text-fg-muted">{PASSWORD_LINE}</FieldDescription>
    </>
  );
}

function AddPasskeyForm({ totpEnabled, onDone }: { totpEnabled: boolean; onDone: (added: boolean) => void }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(totpEnabled);
  // Set only while the last browser prompt failed and the server's ceremony is still fresh.
  const [setup, setSetup] = useState<PasskeySetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish(current: PasskeySetup) {
    const result = await finishPasskeyCreation(current, name.trim() === "" ? undefined : name);
    if (result.ok) {
      toast.success("Passkey added");
      onDone(true);
      return;
    }
    setError(result.message);
    // A refused verify or an expired setup goes back to the password step; the code it used is spent.
    setSetup(result.retry ? current : null);
    if (!result.retry) setCode("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const begun = await beginPasskeyCreation(codeRequired ? { password, code } : { password });
    if (begun.ok) {
      await finish(begun.setup);
    } else {
      setError(begun.message);
      setCodeRequired(codeRequired || begun.codeRequired);
      setCode("");
    }
    setBusy(false);
  }

  async function retry() {
    setBusy(true);
    // finishPasskeyCreation refuses an expired setup before the prompt, and finish() acts on that answer.
    await finish(setup as PasskeySetup);
    setBusy(false);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-6">
      <DialogHeader>
        <DialogTitle className="text-fg">Add a passkey</DialogTitle>
        <DialogDescription className="text-fg-muted">
          Your browser or password manager creates it after you confirm your password.
        </DialogDescription>
      </DialogHeader>
      {setup ? null : (
        <div className="grid gap-5">
          <Field className="gap-2">
            <FieldLabel htmlFor="passkey-add-name">Name</FieldLabel>
            <Input
              id="passkey-add-name"
              maxLength={PASSKEY_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Passkey"
              className={INPUT_CLASS}
            />
          </Field>
          <PasswordFields
            prefix="passkey-add"
            password={password}
            onPassword={setPassword}
            code={code}
            onCode={setCode}
            codeRequired={codeRequired}
          />
        </div>
      )}
      <Notice message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" className={CANCEL_BUTTON} onClick={() => onDone(false)}>
          Cancel
        </Button>
        {setup ? (
          <Button type="button" disabled={busy} className={PRIMARY_BUTTON} onClick={() => void retry()}>
            {busy ? <Spinner aria-hidden /> : null}
            Try again
          </Button>
        ) : (
          <Button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
            {busy ? <Spinner aria-hidden /> : null}
            Create passkey
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

function RenamePasskeyForm({ passkey, onDone }: { passkey: PublicPasskey; onDone: (renamed: boolean) => void }) {
  const [name, setName] = useState(passkey.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await renamePasskey(passkey.id, name);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    toast.success("Passkey renamed");
    onDone(true);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-6">
      <DialogHeader>
        <DialogTitle className="text-fg">Rename passkey</DialogTitle>
        <DialogDescription className="text-fg-muted">A name that tells your devices apart.</DialogDescription>
      </DialogHeader>
      <Field className="gap-2">
        <FieldLabel htmlFor="passkey-rename-name">Name</FieldLabel>
        <Input
          id="passkey-rename-name"
          maxLength={PASSKEY_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className={INPUT_CLASS}
        />
      </Field>
      <Notice message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" className={CANCEL_BUTTON} onClick={() => onDone(false)}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {busy ? <Spinner aria-hidden /> : null}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function RemovePasskeyForm({
  passkey,
  last,
  totpEnabled,
  onDone,
}: {
  passkey: PublicPasskey;
  last: boolean;
  totpEnabled: boolean;
  onDone: (removed: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeRequired, setCodeRequired] = useState(totpEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const result = await removePasskey(
      codeRequired ? { id: passkey.id, password, code } : { id: passkey.id, password },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      setCodeRequired(codeRequired || result.codeRequired);
      setCode("");
      return;
    }
    toast.success("Passkey removed", { description: REMOVED_REMINDER });
    onDone(true);
  }

  return (
    <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
      <AlertDialogHeader>
        <AlertDialogTitle className="text-fg">Remove {passkey.name}?</AlertDialogTitle>
        <AlertDialogDescription className="text-fg-tertiary">
          It stops working at once. Every other session of your account signs out, and MCP tokens you created stop
          working; create a new one under MCP. Delete it from your password manager or security key too.
          {last ? ` After this you sign in with your password${totpEnabled ? " and authenticator code" : ""}.` : null}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <PasswordFields
        prefix="passkey-remove"
        password={password}
        onPassword={setPassword}
        code={code}
        onCode={setCode}
        codeRequired={codeRequired}
      />
      <Notice message={error} />
      <AlertDialogFooter>
        <AlertDialogCancel type="button" className={CANCEL_BUTTON}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" disabled={busy} className="bg-danger-solid text-white hover:bg-danger-solid-hover">
          {busy ? <Spinner aria-hidden /> : null}
          Remove passkey
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

interface Opening<T> {
  target: T;
  open: boolean;
  /** Remounts the dialog's body on every opening, so a refusal or a typed value never carries over. */
  key: number;
}

function closed<T>(current: Opening<T> | null): Opening<T> | null {
  return current ? { ...current, open: false } : current;
}

function PasskeyRow({
  passkey,
  onRename,
  onRemove,
}: {
  passkey: PublicPasskey;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 py-3 @md:flex-row @md:items-center @md:justify-between">
      <div className="min-w-0 space-y-1.5">
        <p className="truncate text-sm font-medium text-fg">{passkey.name}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
          <span>Added {new Date(passkey.createdAt).toLocaleDateString()}</span>
          <span>
            {passkey.lastUsedAt ? `Last used ${new Date(passkey.lastUsedAt).toLocaleDateString()}` : "Never used"}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <SyncBadge passkey={passkey} />
          {/* null means usability cannot be judged while passkeys are off, which is no reason to delete one. */}
          {passkey.usable === false ? <PasskeyBadge label="Not usable on this server" tone="danger" /> : null}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Rename ${passkey.name}`}
          className="border-hairline-strong"
          onClick={onRename}
        >
          Rename
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-label={`Remove ${passkey.name}`}
          className="border-hairline-strong text-danger hover:bg-danger-tint/10 hover:text-danger"
          onClick={onRemove}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}

/** `onChange` hears every add, rename and remove, so a page showing the passkey count can re-read it. */
export function PasskeySettings({ reloadSignal, onChange }: { reloadSignal: number; onChange?: () => void }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [reload, setReload] = useState(0);
  const [openings, setOpenings] = useState(0);
  const [adding, setAdding] = useState<Opening<null> | null>(null);
  const [renaming, setRenaming] = useState<Opening<PublicPasskey> | null>(null);
  const [removing, setRemoving] = useState<Opening<PublicPasskey> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Both counters are read, so each is a real input of this effect, not a bare trigger.
        const res = await appFetch(`/api/auth/passkey?r=${reload}-${reloadSignal}`);
        const body = (await res.json()) as PasskeyStatus & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setView({ kind: "error", message: body.error ?? "Could not read the passkey status" });
          return;
        }
        setView({ kind: "loaded", status: body });
      } catch {
        if (!cancelled) setView({ kind: "error", message: "Could not read the passkey status" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload, reloadSignal]);

  function opening<T>(target: T): Opening<T> {
    setOpenings(openings + 1);
    return { target, open: true, key: openings };
  }

  function finished(changed: boolean) {
    if (!changed) return;
    setReload((value) => value + 1);
    onChange?.();
  }

  let body: React.ReactNode;
  let dialogs: React.ReactNode = null;
  if (view.kind === "loading") {
    body = (
      <div className="space-y-3" aria-busy="true">
        <span className="sr-only">Loading passkeys</span>
        <Skeleton className="h-4 w-2/3 bg-fill-strong" />
        <Skeleton className="h-9 w-full max-w-sm bg-fill-strong" />
      </div>
    );
  } else if (view.kind === "error") {
    body = (
      <p className="text-sm text-danger" data-testid="passkeys-error">
        {view.message}
      </p>
    );
  } else {
    const status = view.status;
    // Loaded state exists only after mount, so reading the page's own address here never runs on the server.
    const blocker = passkeyPageBlocker();
    if (!status.available && status.mode === "oidc") {
      body = <Reason text={status.reason} />;
    } else if (blocker !== null) {
      body = <Reason text={blocker === "ip-address" ? PAGE_IP_ADDRESS : PAGE_PLAIN_HTTP} />;
    } else if (!status.available) {
      body = <Reason text={status.reason} />;
    } else {
      let add: React.ReactNode;
      if (!status.canAdd) add = <Reason text={status.reason} />;
      else if (!passkeysUsableHere(status.origin)) {
        // A wrong address is named first: on the right one, the only remaining cause is the browser.
        const here = window.location.origin;
        add = (
          <Reason
            text={
              here === status.origin
                ? UNSUPPORTED_BROWSER
                : `This page is open at ${here}, but passkeys on this server work at ${status.origin}. Open Studio there to add or use a passkey.`
            }
          />
        );
      } else {
        add = (
          <Button
            type="button"
            variant="outline"
            className="justify-self-start border-hairline-strong"
            onClick={() => setAdding(opening(null))}
          >
            Add passkey
          </Button>
        );
      }

      body = (
        <div className="grid gap-4">
          {status.totpEnabled && status.passkeys.length > 0 ? (
            <p className="rounded-md border border-warning-tint/25 bg-warning-tint/10 px-3 py-2 text-sm text-warning">
              {TOTP_NOTICE}
            </p>
          ) : null}
          {status.passkeys.length === 0 ? (
            <p className="text-sm text-fg-muted">No passkeys yet. Add one on each device you sign in from.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {status.passkeys.map((passkey) => (
                <PasskeyRow
                  key={passkey.id}
                  passkey={passkey}
                  onRename={() => setRenaming(opening(passkey))}
                  onRemove={() => setRemoving(opening(passkey))}
                />
              ))}
            </ul>
          )}
          {add}
        </div>
      );

      dialogs = (
        <>
          <Dialog open={adding?.open ?? false} onOpenChange={(open) => !open && setAdding(closed)}>
            <DialogContent className="border-hairline-strong bg-surface sm:max-w-md">
              {adding ? (
                <AddPasskeyForm
                  key={adding.key}
                  totpEnabled={status.totpEnabled}
                  onDone={(added) => {
                    setAdding(closed);
                    finished(added);
                  }}
                />
              ) : null}
            </DialogContent>
          </Dialog>
          <Dialog open={renaming?.open ?? false} onOpenChange={(open) => !open && setRenaming(closed)}>
            <DialogContent className="border-hairline-strong bg-surface sm:max-w-md">
              {renaming ? (
                <RenamePasskeyForm
                  key={renaming.key}
                  passkey={renaming.target}
                  onDone={(renamed) => {
                    setRenaming(closed);
                    finished(renamed);
                  }}
                />
              ) : null}
            </DialogContent>
          </Dialog>
          <AlertDialog open={removing?.open ?? false} onOpenChange={(open) => !open && setRemoving(closed)}>
            <AlertDialogContent className="border-hairline-strong bg-surface sm:max-w-md">
              {removing ? (
                <RemovePasskeyForm
                  key={removing.key}
                  passkey={removing.target}
                  last={status.passkeys.length === 1}
                  totpEnabled={status.totpEnabled}
                  onDone={(removed) => {
                    setRemoving(closed);
                    finished(removed);
                  }}
                />
              ) : null}
            </AlertDialogContent>
          </AlertDialog>
        </>
      );
    }
  }

  return (
    <section aria-labelledby="passkeys-heading" className="@container rounded-xl border border-hairline bg-panel">
      <div className="space-y-1 p-5">
        <h3 id="passkeys-heading" className="text-sm font-semibold text-fg">
          Passkeys
        </h3>
        <p className="text-sm text-fg-muted">
          Sign in with your fingerprint, face or device PIN instead of a password and code.
        </p>
      </div>
      <div className="border-t border-hairline p-5">{body}</div>
      {dialogs}
    </section>
  );
}

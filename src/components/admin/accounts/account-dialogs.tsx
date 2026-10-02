"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { PublicAccount } from "@/lib/local-accounts";
import { FormError, TypedConfirmDialog } from "@/components/typed-confirm";
import { MonoEmail, passkeyPhrase } from "./account-parts";
import { PASSWORD_MIN_LENGTH, type AccountAction, type AccountsController, type NewAccount } from "./use-accounts";

/**
 * The dialogs the Accounts screen opens. A refusal from the server (the last enabled admin, a
 * duplicate email, a short password) stays inside the dialog that caused it, so the reader sees it
 * next to the button they pressed rather than in a toast that fades.
 */

const INPUT_CLASS = "border-hairline-strong bg-panel";
const PRIMARY_BUTTON = "bg-brand-solid text-white hover:bg-brand-solid-hover";
const CANCEL_BUTTON = "border-hairline-strong text-fg-tertiary";

/** Every action except enabling asks for the email to be typed first. */
type ConfirmedAction = Exclude<AccountAction, "enable">;

interface ConfirmCopy {
  title: string;
  /** Receives the account too, so a description can name what still signs in (its passkeys). */
  description: (email: React.ReactNode, isMe: boolean, account: PublicAccount) => React.ReactNode;
  confirm: string;
  destructive: boolean;
}

// Kept whole in constants: bun's coverage maps a wrapped JSX text line in this entry as never run.
const CLEAR_PASSKEYS_TAIL =
  " can no longer sign in with a passkey, and every session and MCP token they hold ends. Their password and authenticator stay.";
// An admin's change to their own account re-issues this session's cookie, so only the others end.
const CLEAR_OWN_PASSKEYS_TAIL =
  ") can no longer sign in with a passkey. Your other sessions and MCP tokens end; this one continues. Your password and authenticator stay.";

const CONFIRM_COPY: Record<ConfirmedAction, ConfirmCopy> = {
  "make-admin": {
    title: "Make this account an admin?",
    description: (email) => (
      <>
        {email} gets the admin dashboard, including this screen. Every session and MCP token they hold ends, so they
        sign in again.
      </>
    ),
    confirm: "Make admin",
    destructive: false,
  },
  "make-user": {
    title: "Remove admin access?",
    description: (email, isMe) =>
      isMe ? (
        <>You ({email}) lose the admin dashboard as soon as this is saved. Your other sessions and MCP tokens end.</>
      ) : (
        <>{email} loses the admin dashboard. Every session and MCP token they hold ends, so they sign in again.</>
      ),
    confirm: "Make user",
    destructive: true,
  },
  disable: {
    title: "Disable this account?",
    description: (email) => (
      <>
        {email} loses every session and MCP token and cannot sign in until an admin enables the account again. Saved
        connections, history and queries are kept.
      </>
    ),
    confirm: "Disable account",
    destructive: true,
  },
  "clear-totp": {
    title: "Clear two-factor?",
    description: (email, _isMe, account) =>
      account.passkeys > 0 ? (
        <>
          {email} signs in with the password alone, or with{" "}
          {account.passkeys === 1 ? "their passkey" : `one of their ${passkeyPhrase(account.passkeys)}`}, until they set
          up a new authenticator. If the lost device also held a passkey, use Remove passkeys too.
        </>
      ) : (
        <>
          {email} signs in with the password alone until they set up a new authenticator. Use this when the device with
          the app is lost.
        </>
      ),
    confirm: "Clear two-factor",
    destructive: true,
  },
  "clear-passkeys": {
    title: "Remove every passkey?",
    description: (email, isMe) =>
      isMe ? (
        <>
          You ({email}
          {CLEAR_OWN_PASSKEYS_TAIL}
        </>
      ) : (
        <>
          {email}
          {CLEAR_PASSKEYS_TAIL}
        </>
      ),
    confirm: "Remove passkeys",
    destructive: true,
  },
  delete: {
    title: "Delete this account?",
    description: (email) => (
      <>
        {email} loses every session and MCP token, and their saved connections, history and saved queries are removed.
        This cannot be undone.
      </>
    ),
    confirm: "Delete account",
    destructive: true,
  },
};

function CreateAccountForm({
  onCreate,
  onDone,
}: {
  onCreate: (input: NewAccount) => Promise<string | null>;
  onDone: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<NewAccount["role"]>("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const failure = await onCreate({ email, password, role });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-6">
      <DialogHeader>
        <DialogTitle className="text-fg">Add account</DialogTitle>
        <DialogDescription className="text-fg-muted">
          A local email and password sign-in. The new account starts with no saved connections.
        </DialogDescription>
      </DialogHeader>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="new-account-email">Email</FieldLabel>
          <Input
            id="new-account-email"
            type="email"
            autoComplete="off"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="name@example.com"
            className={INPUT_CLASS}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-account-password">Password</FieldLabel>
          <Input
            id="new-account-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className={INPUT_CLASS}
          />
          <FieldDescription className="text-fg-muted">
            At least {PASSWORD_MIN_LENGTH} characters. Share it with them directly.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="new-account-role">Role</FieldLabel>
          <Select value={role} onValueChange={(value) => setRole(value === "admin" ? "admin" : "user")}>
            <SelectTrigger id="new-account-role" className={cn("w-full", INPUT_CLASS)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-hairline-strong bg-raised text-fg-secondary">
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription className="text-fg-muted">
            Admins also get this dashboard: accounts, operations, security and audit.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" className={CANCEL_BUTTON} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
          {busy ? <Spinner aria-hidden /> : null}
          Create account
        </Button>
      </DialogFooter>
    </form>
  );
}

function SetPasswordForm({
  account,
  isMe,
  onSubmit,
  onDone,
}: {
  account: PublicAccount;
  /** The admin's own row: the route re-issues their cookie, so this session continues. */
  isMe: boolean;
  onSubmit: (account: PublicAccount, password: string, keepPasskeys: boolean) => Promise<string | null>;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  // A password set is a recovery (docs/PASSKEYS.md, "Admin actions and recovery"), so removing the passkeys is the default.
  const [removePasskeys, setRemovePasskeys] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passkeys = passkeyPhrase(account.passkeys);

  const verb = account.passkeys === 1 ? "is" : "are";
  let consequence: React.ReactNode;
  if (isMe) {
    const ends = "Your other sessions and MCP tokens end; this one continues.";
    consequence = `${ends} Next time you sign in with the new password.`;
    if (account.passkeys > 0) {
      consequence = removePasskeys
        ? `${ends} Your ${passkeys} ${verb} removed, and next time you sign in with the new password.`
        : `${ends} Next time you sign in with the new password or ${account.passkeys === 1 ? "your passkey" : `one of your ${passkeys}`}; keep the passkeys only when you know the account is not compromised.`;
    }
  } else {
    consequence = "Every session and MCP token they hold ends, and they sign in with the new password.";
    if (account.passkeys > 0) {
      consequence = removePasskeys
        ? `Every session and MCP token they hold ends, their ${passkeys} ${verb} removed, and they sign in with the new password.`
        : `Every session and MCP token they hold ends. They sign in with the new password or ${account.passkeys === 1 ? "their passkey" : `one of their ${passkeys}`}; keep the passkeys only when you know the account is not compromised.`;
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    const failure = await onSubmit(account, password, account.passkeys > 0 && !removePasskeys);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-6">
      <DialogHeader>
        <DialogTitle className="text-fg">Set a new password</DialogTitle>
        <DialogDescription className="text-fg-muted">
          For <MonoEmail value={account.email} />. {consequence}
        </DialogDescription>
      </DialogHeader>
      <Field>
        <FieldLabel htmlFor="set-password-value">New password</FieldLabel>
        <Input
          id="set-password-value"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={INPUT_CLASS}
        />
        <FieldDescription className="text-fg-muted">At least {PASSWORD_MIN_LENGTH} characters.</FieldDescription>
      </Field>
      {account.passkeys > 0 ? (
        <Field orientation="horizontal">
          <Checkbox
            id="set-password-remove-passkeys"
            checked={removePasskeys}
            onCheckedChange={(checked) => setRemovePasskeys(checked === true)}
          />
          <FieldLabel htmlFor="set-password-remove-passkeys" className="font-normal">
            Also remove {isMe ? "your" : "their"} {passkeys}
          </FieldLabel>
        </Field>
      ) : null}
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" className={CANCEL_BUTTON} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || password.length < PASSWORD_MIN_LENGTH} className={PRIMARY_BUTTON}>
          {busy ? <Spinner aria-hidden /> : null}
          Set password
        </Button>
      </DialogFooter>
    </form>
  );
}

interface Opening<T> {
  target: T;
  open: boolean;
  /** Remounts the dialog's body on every opening, so a refusal or a typed value never carries over. */
  key: number;
}

/**
 * The dialog state behind the Accounts screen. `request` asks for the typed email before any change
 * that ends someone's sessions or weakens their sign-in; enabling an account is the one change that
 * runs at once, and its refusal (if any) arrives as a toast because there is no dialog to hold it.
 * `open: false` keeps a dialog's content in place while it animates out.
 */
export function useAccountActions(controller: AccountsController) {
  const [openings, setOpenings] = useState(0);
  const [confirm, setConfirm] = useState<Opening<{ account: PublicAccount; action: ConfirmedAction }> | null>(null);
  const [create, setCreate] = useState<Opening<null> | null>(null);
  const [password, setPassword] = useState<Opening<PublicAccount> | null>(null);

  function next(): number {
    setOpenings(openings + 1);
    return openings;
  }

  function request(account: PublicAccount, action: AccountAction) {
    if (action === "enable") {
      void controller.run(account, action).then((failure) => {
        if (failure) toast.error(failure);
      });
      return;
    }
    setConfirm({ target: { account, action }, open: true, key: next() });
  }

  function openCreate() {
    setCreate({ target: null, open: true, key: next() });
  }

  function openPassword(account: PublicAccount) {
    setPassword({ target: account, open: true, key: next() });
  }

  function closed<T>(current: Opening<T> | null): Opening<T> | null {
    return current ? { ...current, open: false } : current;
  }

  let confirmDialog: React.ReactNode = null;
  if (confirm) {
    const { account, action } = confirm.target;
    const copy = CONFIRM_COPY[action];
    confirmDialog = (
      <TypedConfirmDialog
        key={confirm.key}
        open={confirm.open}
        onOpenChange={(open) => !open && setConfirm(closed)}
        title={copy.title}
        description={copy.description(<MonoEmail value={account.email} />, controller.isMe(account), account)}
        expected={account.email}
        match="case-insensitive"
        confirmLabel={copy.confirm}
        destructive={copy.destructive}
        onConfirm={() => controller.run(account, action)}
      />
    );
  }

  const dialogs = (
    <>
      {confirmDialog}
      <Dialog open={create?.open ?? false} onOpenChange={(open) => !open && setCreate(closed)}>
        <DialogContent className="border-hairline-strong bg-surface sm:max-w-md">
          {create ? (
            <CreateAccountForm key={create.key} onCreate={controller.create} onDone={() => setCreate(closed)} />
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={password?.open ?? false} onOpenChange={(open) => !open && setPassword(closed)}>
        <DialogContent className="border-hairline-strong bg-surface sm:max-w-md">
          {password ? (
            <SetPasswordForm
              key={password.key}
              account={password.target}
              isMe={controller.isMe(password.target)}
              onSubmit={controller.setPassword}
              onDone={() => setPassword(closed)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );

  return { request, openCreate, openPassword, dialogs };
}

export type AccountActions = ReturnType<typeof useAccountActions>;

"use client";

import { useId, useLayoutEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useReturnFocus } from "@/hooks/use-return-focus";

/**
 * The one typed confirmation of this product: a value typed by hand before a change that one click must not make.
 *
 * Three surfaces ask for it. The account dialogs ask for the account's email, the Operations tab's declared
 * maintenance cards for the connection's name, and the editor's confirmation gate, `QuerySafetyDialog`, which holds
 * the field alone inside a dialog of its own, for a key prefix, a start key, a lease id or the connection's name
 * (#1089, section 5.5). It began under `admin/accounts/` and lives here, beside `QuerySafetyDialog.tsx`, because the
 * published package ships that gate and a shared component imports nothing from a feature folder; and not under
 * `ui/`, which is vendored shadcn code that the coverage gate and Sonar leave out and for which `.oxlintrc.json`
 * turns accessibility rules off.
 */

/**
 * How a typed value is compared. Every caller names it and nothing defaults it, so a new caller cannot inherit the
 * weaker rule by leaving it out: an email is compared trimmed and case-folded, and a key or a connection's name
 * exactly, because an etcd key is bytes and `/app/` and `/App/` are two different prefixes.
 */
export type TypedConfirmMatch = "exact" | "case-insensitive";

/**
 * Whether `typed` confirms `expected` under `match`.
 *
 * An empty typed value never matches, under either rule, and neither does one that `"case-insensitive"` trims to
 * nothing. An empty `expected` throws, because exact equality would let an empty field confirm it; every caller
 * shows a sentence in place of the field when it has nothing to ask for, so the throw is a programming error that
 * no rendered path reaches.
 */
export function typedValueMatches(typed: string, expected: string, match: TypedConfirmMatch): boolean {
  if (expected === "") {
    throw new Error("typedValueMatches was given an empty expected value, which an empty field would confirm");
  }
  if (match === "exact") return typed === expected;
  const folded = typed.trim().toLowerCase();
  return folded !== "" && folded === expected.trim().toLowerCase();
}

/** A refusal shown next to the control that caused it. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

export interface TypedConfirmFieldProps {
  /** What the person types. Never empty, and drawn with its whitespace kept, since a leading space is part of a key. */
  expected: string;
  match: TypedConfirmMatch;
  /** Told whether the typed value matches: once when the field mounts, and again whenever that answer changes. */
  onMatchChange: (matches: boolean) => void;
}

/**
 * The label, the input and the match state of a typed confirmation, with no dialog around it.
 *
 * What was typed is this field's own state, so it starts empty whenever the field mounts: inside an
 * `AlertDialogContent`, which unmounts on close, that is every opening of the dialog around it.
 */
export function TypedConfirmField({ expected, match, onMatchChange }: TypedConfirmFieldProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const matches = typedValueMatches(typed, expected, match);
  // A layout effect, so the dialog around the field hears the answer before it paints: a field that mounts empty
  // says "no match" before the button it holds can be seen enabled.
  useLayoutEffect(() => {
    onMatchChange(matches);
  }, [matches, onMatchChange]);

  return (
    <Field className="gap-2">
      <FieldLabel htmlFor={inputId} className="block font-normal text-fg-secondary">
        Type <span className="font-mono font-medium whitespace-pre-wrap break-all text-fg">{expected}</span> to confirm
      </FieldLabel>
      <Input
        id={inputId}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="border-hairline-strong bg-panel font-mono"
      />
    </Field>
  );
}

export interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  expected: string;
  /** Required, with no default: see `TypedConfirmMatch`. */
  match: TypedConfirmMatch;
  /**
   * Said in place of the typed field when there is nothing the person could type, with the button kept disabled;
   * `expected` is not read then. The Operations tab sets it for a stored connection whose name is empty (#1089).
   */
  unavailable?: string;
  confirmLabel: string;
  destructive: boolean;
  /** Resolves to an error message to show in the dialog, or null when the change was made. */
  onConfirm: () => Promise<string | null>;
}

/**
 * A confirmation that asks for a value to be typed by hand before a change that cannot be taken back with one click.
 * The button stays disabled until the typed value matches under the caller's `match`.
 *
 * A refusal from `onConfirm` stays inside the dialog, next to the button that caused it. The caller remounts the
 * dialog (a new `key`) for each opening, so neither the match nor a refusal carries over. Every caller opens it from
 * app state rather than an `AlertDialogTrigger`, so it hands focus back itself on Cancel and on Escape (#1198).
 */
export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  expected,
  match,
  unavailable,
  confirmLabel,
  destructive,
  onConfirm,
}: TypedConfirmDialogProps) {
  const [matches, setMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnFocus = useReturnFocus();
  // The field reports its match only while it is mounted, so a sentence that replaces a matched field is never a
  // match, whatever the field said last.
  const confirmable = unavailable === undefined && matches;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Enter in the field submits the form even while the button is disabled.
    if (!confirmable) return;
    setBusy(true);
    const failure = await onConfirm();
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="border-hairline-strong bg-surface sm:max-w-md" {...returnFocus}>
        <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-fg">{title}</AlertDialogTitle>
            <AlertDialogDescription className="text-fg-tertiary">{description}</AlertDialogDescription>
          </AlertDialogHeader>
          {unavailable === undefined ? (
            <TypedConfirmField expected={expected} match={match} onMatchChange={setMatches} />
          ) : (
            <p className="text-sm text-fg-secondary">{unavailable}</p>
          )}
          <FormError message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button" className="border-hairline-strong text-fg-tertiary">
              Cancel
            </AlertDialogCancel>
            <Button
              type="submit"
              disabled={!confirmable || busy}
              className={
                destructive
                  ? "bg-danger-solid text-white hover:bg-danger-solid-hover"
                  : "bg-brand-solid text-white hover:bg-brand-solid-hover"
              }
            >
              {busy ? <Spinner aria-hidden /> : null}
              {confirmLabel}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

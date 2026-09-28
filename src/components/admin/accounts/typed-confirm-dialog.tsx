"use client";

import { useId, useState } from "react";
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
import { FormError } from "./account-parts";

/**
 * A confirmation that asks the admin to type a value by hand, the email of the account in
 * practice, before a change that cannot be taken back with one click. The button stays disabled
 * until the typed value matches, ignoring surrounding whitespace and case.
 *
 * A refusal from `onConfirm` stays inside the dialog, next to the button that caused it. The
 * caller remounts the dialog (a new `key`) for each opening, so nothing typed carries over.
 */

export interface TypedConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  expected: string;
  confirmLabel: string;
  destructive: boolean;
  /** Resolves to an error message to show in the dialog, or null when the change was made. */
  onConfirm: () => Promise<string | null>;
}

export function typedValueMatches(typed: string, expected: string): boolean {
  return typed.trim().toLowerCase() === expected.trim().toLowerCase();
}

export function TypedConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  expected,
  confirmLabel,
  destructive,
  onConfirm,
}: TypedConfirmDialogProps) {
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typedValueMatches(typed, expected);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // Enter in the field submits the form even while the button is disabled.
    if (!matches) return;
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
      <AlertDialogContent className="border-hairline-strong bg-surface sm:max-w-md">
        <form className="grid gap-5" onSubmit={(event) => void submit(event)}>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-fg">{title}</AlertDialogTitle>
            <AlertDialogDescription className="text-fg-tertiary">{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <Field className="gap-2">
            <FieldLabel htmlFor={inputId} className="block font-normal text-fg-secondary">
              Type <span className="font-mono font-medium break-all text-fg">{expected}</span> to confirm
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
          <FormError message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button" className="border-hairline-strong text-fg-tertiary">
              Cancel
            </AlertDialogCancel>
            <Button
              type="submit"
              disabled={!matches || busy}
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

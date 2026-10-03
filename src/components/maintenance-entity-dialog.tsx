"use client";

import { useEffect, useState } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { FormError, TypedConfirmDialog, TypedConfirmField } from "@/components/typed-confirm";
import { useReturnFocus } from "@/hooks/use-return-focus";
import { useStableCallback } from "@/hooks/use-stable-callback";
import {
  maintenanceControl,
  type MaintenanceOperation,
  type MaintenancePreview,
  type ProviderCapabilities,
} from "@/lib/db/types";

/**
 * The dialog a per-row maintenance control opens when its operation's spec asks for one (spec 3.11): the object's own
 * name typed exactly (`confirmation: "typed-target"`), the provider's preview read before the confirm button is
 * offered (`preview: true`), or both.
 *
 * Shared by the two surfaces that run a per-row operation, the Operations tab and the monitoring Tables tab; the two
 * row menus open the Operations tab on the row instead of running anything. A control whose spec asks for neither
 * opens no dialog and sends with one click, which is every shipped provider's controls.
 */

/** Everything the dialog needs about one per-row request, read from the operation's spec by `entityRequest`. */
export interface MaintenanceEntityRequest {
  readonly type: MaintenanceOperation;
  /** The spec's label: the confirm button's words, and the title where the spec declares none. */
  readonly label: string;
  readonly title?: string;
  readonly description?: string;
  /** The row's own name: what a typed target asks for, and the object the preview reads. */
  readonly target: string;
  /** The row's container, sent beside the target exactly as the one-click controls send it. */
  readonly container?: string;
  readonly typedTarget: boolean;
  readonly preview: boolean;
}

/** Reads one per-row operation's preview: `useMonitoringData().previewMaintenance`, on both surfaces. */
export type LoadMaintenancePreview = (
  type: MaintenanceOperation,
  target: string,
  container?: string,
) => Promise<MaintenancePreview>;

/** One opening of the dialog, keyed so that every opening mounts a fresh one, as the Operations tab's typed cards are. */
export interface EntityDialogOpening {
  readonly request: MaintenanceEntityRequest;
  /** False keeps the dialog in place while it animates out. */
  readonly open: boolean;
  readonly key: number;
}

/**
 * The request a per-row control's click makes, or `null` when the operation's spec asks for neither a typed target nor
 * a preview, so the control sends with one click. Read through `maintenanceControl`, the gate every maintenance
 * surface asks.
 */
export function entityRequest(
  capabilities: ProviderCapabilities | undefined,
  type: MaintenanceOperation,
  target: string,
  container?: string,
): MaintenanceEntityRequest | null {
  const control = maintenanceControl(capabilities, type, "perEntity");
  const typedTarget = control.confirmation === "typed-target";
  const preview = control.preview === true;
  if (!typedTarget && !preview) return null;
  return {
    type,
    label: control.label ?? type,
    title: control.title,
    description: control.description,
    target,
    container,
    typedTarget,
    preview,
  };
}

/** The same opening, closed. */
export function closedEntityDialog(current: EntityDialogOpening | null): EntityDialogOpening | null {
  return current ? { ...current, open: false } : current;
}

/** Said in place of the typed field for a row whose name is empty: there is nothing to type. */
const UNNAMED_TARGET = "This operation is confirmed by typing the object's name, and this row has none.";

export interface MaintenanceEntityDialogProps {
  readonly request: MaintenanceEntityRequest;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Required for a request that asks for a preview; a surface that cannot read one does not offer the control. */
  readonly loadPreview?: LoadMaintenancePreview;
  /** Resolves to an error message to show in the dialog, or null when the operation was sent. */
  readonly onConfirm: () => Promise<string | null>;
}

export function MaintenanceEntityDialog({
  request,
  open,
  onOpenChange,
  loadPreview,
  onConfirm,
}: MaintenanceEntityDialogProps) {
  const title = request.title ?? request.label;
  const description = request.description ?? `${request.label} runs on ${request.target} only.`;
  if (!request.preview) {
    // A typed target alone is the shared typed confirmation, asking for the row's own name and never the connection's.
    return (
      <TypedConfirmDialog
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        description={description}
        expected={request.target}
        match="exact"
        unavailable={request.target === "" ? UNNAMED_TARGET : undefined}
        confirmLabel={request.label}
        destructive
        onConfirm={onConfirm}
      />
    );
  }
  if (loadPreview === undefined) {
    throw new Error(`${request.label} declares a preview, and this surface was handed no way to read one`);
  }
  return (
    <MaintenancePreviewDialog
      request={request}
      title={title}
      description={description}
      open={open}
      onOpenChange={onOpenChange}
      loadPreview={loadPreview}
      onConfirm={onConfirm}
    />
  );
}

type PreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: MaintenancePreview }
  | { readonly status: "failed"; readonly message: string };

/** What the preview says, or why there is none yet. */
function PreviewBody({ state }: Readonly<{ state: PreviewState }>) {
  if (state.status === "loading") {
    return (
      <output className="flex items-center gap-2 text-sm text-fg-secondary">
        <Spinner aria-hidden />
        Reading the preview from the server
      </output>
    );
  }
  if (state.status === "failed") return <FormError message={state.message} />;
  const { preview } = state;
  return (
    <div className="grid gap-3" data-testid="maintenance-preview">
      <p className="text-sm text-fg">{preview.summary}</p>
      {preview.facts.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {preview.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-fg-tertiary">{fact.label}</dt>
              <dd className="font-mono break-all text-fg">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {preview.note !== undefined && <p className="text-xs text-fg-muted">{preview.note}</p>}
      {preview.refusal !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {preview.refusal}
        </p>
      )}
    </div>
  );
}

interface MaintenancePreviewDialogProps {
  readonly request: MaintenanceEntityRequest;
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly loadPreview: LoadMaintenancePreview;
  readonly onConfirm: () => Promise<string | null>;
}

/**
 * The preview, then the typed target where the spec asks for one, then the confirm button: offered only once the
 * preview has arrived and refused nothing, so a loading, failed or refused preview can never be confirmed.
 */
function MaintenancePreviewDialog({
  request,
  title,
  description,
  open,
  onOpenChange,
  loadPreview,
  onConfirm,
}: MaintenancePreviewDialogProps) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const [matches, setMatches] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const returnFocus = useReturnFocus();
  // One identity for the dialog's life, so a caller's inline function does not read the preview again on a re-render.
  const load = useStableCallback(loadPreview);
  const { type, target, container } = request;

  // Read once per opening: both callers key the dialog per opening, so a mount is an opening. `current` drops an
  // answer that arrives after the dialog is gone.
  useEffect(() => {
    let current = true;
    load(type, target, container).then(
      (preview) => {
        if (current) setState({ status: "ready", preview });
      },
      (failure: unknown) => {
        const message = failure instanceof Error ? failure.message : String(failure);
        if (current) setState({ status: "failed", message });
      },
    );
    return () => {
      current = false;
    };
  }, [load, type, target, container]);

  const offersConfirm = state.status === "ready" && state.preview.refusal === undefined && target !== "";
  const confirmable = offersConfirm && (!request.typedTarget || matches);

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
          <PreviewBody state={state} />
          {offersConfirm && request.typedTarget ? (
            <TypedConfirmField expected={target} match="exact" onMatchChange={setMatches} />
          ) : null}
          <FormError message={error} />
          <AlertDialogFooter>
            <AlertDialogCancel type="button" className="border-hairline-strong text-fg-tertiary">
              Cancel
            </AlertDialogCancel>
            {offersConfirm ? (
              <Button
                type="submit"
                disabled={!confirmable || busy}
                className="bg-danger-solid text-white hover:bg-danger-solid-hover"
              >
                {busy ? <Spinner aria-hidden /> : null}
                {request.label}
              </Button>
            ) : null}
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

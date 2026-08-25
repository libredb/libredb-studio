"use client";

import { loader } from "@monaco-editor/react";
import { useEffect, useState } from "react";
import type * as Monaco from "monaco-editor";

/*
  A replacement for `@monaco-editor/react`'s own `useMonaco`, which loses the
  cancellation its sibling `Editor` component handles.

  Both entry points call the same `loader.init()`, which `@monaco-editor/loader` wraps
  in `makeCancelable`. `Editor` filters the resulting rejection; `useMonaco` attaches no
  rejection handler at all, so every unmount that outruns the load reports the abandoned
  promise as an unhandled rejection. That is a false alarm in a terminal we read for real
  ones. Known upstream since 2023 (suren-atoyan/monaco-react#440, #575), closed twice by a
  stale bot without a fix, and `4.8.0-rc.3` carries the same code — so a version bump does
  not retire this file. See issue #492 for the full account.
*/

/** The Monaco namespace, as the loader hands it over. */
type MonacoNamespace = typeof Monaco;

/*
  The marker `makeCancelable` rejects with:
  `{ type: 'cancelation', msg: 'operation is manually canceled' }`.
  A plain object, not an Error — which is why matching on a message or on `error.name`
  (the workaround suggested upstream) cannot recognise it.
*/
const CANCELLATION_TYPE = "cancelation";

/**
 * Silences the loader's own cancellation and lets every other rejection through.
 *
 * Rethrowing rather than logging is deliberate: a Monaco that genuinely failed to load
 * means a dead editor, and the failure has to stay loud. It escapes as an unhandled
 * rejection rather than as a render-time throw because `QueryEditor` sits outside any
 * error boundary — throwing during render would replace the whole studio page with an
 * error screen over a broken editor pane, which trades one broken surface for six.
 *
 * The match is positive: only the loader's marker is silenced, so a rejection carrying
 * no inspectable value stays a failure instead of passing as a cancellation.
 */
export function rethrowUnlessCancelled(error: unknown): void {
  if ((error as { type?: unknown } | null | undefined)?.type === CANCELLATION_TYPE) return;
  throw error;
}

/**
 * The Monaco namespace once its AMD bundle has loaded, or `null` until then.
 *
 * Monaco is a singleton, so an editor mounted after the first one gets the instance
 * synchronously and never re-enters the loader.
 */
export function useMonacoInstance(): MonacoNamespace | null {
  const [monaco, setMonaco] = useState<MonacoNamespace | null>(
    () => loader.__getMonacoInstance() as MonacoNamespace | null,
  );

  useEffect(() => {
    if (monaco) return;
    const pending = loader.init();
    pending.then((instance) => setMonaco(instance as MonacoNamespace)).catch(rethrowUnlessCancelled);
    return () => pending.cancel();
  }, [monaco]);

  return monaco;
}

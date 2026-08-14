import { toast } from "sonner";
import { REPO_URL } from "./repo";
import { dismissStarPrompt, recordQuerySuccess } from "./star-prompt";

/**
 * The one-shot star invitation. It waits for the user (duration Infinity) and
 * both paths - starring and declining - mark the prompt handled, so it is asked
 * once per browser and never again.
 */
export function showStarPromptToast(): void {
  toast("LibreDB Studio is open source and free. A star on GitHub helps other teams find it.", {
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Star on GitHub",
      onClick: () => {
        dismissStarPrompt();
        window.open(REPO_URL, "_blank", "noopener,noreferrer");
      },
    },
    cancel: {
      label: "Not now",
      onClick: () => {
        dismissStarPrompt();
      },
    },
  });
}

/**
 * Count one successful query and, on the single run that earns it, offer the
 * invitation. This is the ONLY entry point query paths should use.
 *
 * It cannot throw. Both query paths call it from inside the try block that owns
 * the query result, so an exception here would be caught by their error handler
 * and reported to the user as a failed query - for a query that actually
 * succeeded, and in playground mode with a second rollback POST behind it. A
 * nudge is never worth a lost result.
 */
export function maybeInviteToStar(): void {
  try {
    if (recordQuerySuccess()) showStarPromptToast();
  } catch {
    // Deliberately silent: the user came here to run a query, not to be asked
    // for a favour, and a broken favour must not become a broken query.
  }
}

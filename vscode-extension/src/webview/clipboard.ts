// Copy through the host: the webview never writes the system clipboard itself.
// The host's vscode.env.clipboard.writeText is the only writer (part 4 "Copy and export", controller decision 3),
// so a copy event the grid built is relayed with its data cleared, and the browser writes nothing of its own.
import { RESULTS_LIMITS } from "../results-protocol";
import { postToHost } from "./host-channel";
import { COPY_FAILED_SENTENCE } from "./notices";

let nextRequestId = 0;
const pending = new Map<number, (ok: boolean) => void>();

/**
 * Posts copy { requestId, text } and resolves with the host's copied.ok for that requestId.
 * A text longer than the host's guard accepts resolves false without posting, since the host would refuse it.
 */
export function requestCopy(text: string): Promise<boolean> {
  if (text.length > RESULTS_LIMITS.copyTextChars) return Promise.resolve(false);
  const requestId = nextRequestId++;
  postToHost({ v: 1, type: "copy", requestId, text });
  return new Promise((resolve) => pending.set(requestId, resolve));
}

/** Copies through requestCopy and, when the host did not write the text, says so with notify at level error. */
export function copyOrReport(text: string): void {
  void requestCopy(text).then((ok) => {
    if (!ok) postToHost({ v: 1, type: "notify", level: "error", message: COPY_FAILED_SENTENCE });
  });
}

/** Resolves the pending request; an unknown requestId is reported through reportError, never thrown into the page. */
export function settleCopy(requestId: number, ok: boolean): void {
  const resolve = pending.get(requestId);
  if (!resolve) {
    postToHost({
      v: 1,
      type: "reportError",
      message: `The host settled copy request ${requestId}, which this view never made.`,
    });
    return;
  }
  pending.delete(requestId);
  resolve(ok);
}

/**
 * Fires a copy event that reached the document unhandled again at the focused element, unless it already passed that
 * element or text is selected, which the browser copies itself. VS Code desktop delivers Ctrl+C to a webview as
 * document.execCommand("copy") (its host page's execCommand message), which Chromium fires at the selection's start,
 * or at the body when nothing is selected, where a key press fires it at the focused element; fired again, the copy
 * reaches the grid's handler as a key press does. The original is prevented when the second one was.
 */
function refireAtFocus(document: Document, event: Event): void {
  const focused = document.activeElement;
  if (!focused || focused.contains(event.target as Node) || document.getSelection()?.type === "Range") return;
  const again = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
  focused.dispatchEvent(again);
  if (again.defaultPrevented) event.preventDefault();
}

/**
 * Listens for the copy event on `document` in the bubble phase, after React's root listener; when the grid's handler
 * has set text/plain and called preventDefault, posts that text to the host and clears the event's data, so the
 * host's write is the only one. An unhandled copy goes through refireAtFocus first. Returns the remover.
 */
export function installCopyRelay(document: Document): () => void {
  const relay = (event: Event) => {
    if (!event.defaultPrevented) {
      refireAtFocus(document, event);
      return;
    }
    const data = (event as ClipboardEvent).clipboardData;
    if (!data) return;
    const text = data.getData("text/plain");
    if (!text) return;
    data.clearData();
    event.preventDefault();
    copyOrReport(text);
  };
  document.addEventListener("copy", relay);
  return () => document.removeEventListener("copy", relay);
}

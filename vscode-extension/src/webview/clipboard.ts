// Copy through the host: the webview never writes the system clipboard itself.
// The host's vscode.env.clipboard.writeText is the only writer (part 4 "Copy and export", controller decision 3),
// so a copy event the grid built is relayed with its data cleared, and the browser writes nothing of its own.
import { RESULTS_LIMITS } from "../results-protocol";
import { postToHost } from "./host-channel";

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
 * Listens for the copy event on `target` in the bubble phase, after React's root listener; when the grid's handler
 * has set text/plain and called preventDefault, posts that text to the host and clears the event's data, so the
 * host's write is the only one. Returns the remover.
 */
export function installCopyRelay(target: Pick<Document, "addEventListener" | "removeEventListener">): () => void {
  const relay = (event: Event) => {
    const data = (event as ClipboardEvent).clipboardData;
    if (!event.defaultPrevented || !data) return;
    const text = data.getData("text/plain");
    if (!text) return;
    data.clearData();
    event.preventDefault();
    void requestCopy(text);
  };
  target.addEventListener("copy", relay);
  return () => target.removeEventListener("copy", relay);
}

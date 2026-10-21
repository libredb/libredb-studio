// The one way webview code reaches the host: the store connects acquireVsCodeApi()'s postMessage once,
// and the shims and the copy relay post through it.
import type { WebviewToHost } from "../results-protocol";

export type PostToHost = (message: WebviewToHost) => void;

let post: PostToHost | undefined;

/** Connects the host's post function, or disconnects with undefined. */
export function connectHost(next: PostToHost | undefined): void {
  post = next;
}

/** Throws while no post function is connected: a message with nowhere to go is a broken view, not a quiet one. */
export function postToHost(message: WebviewToHost): void {
  if (!post) throw new Error("The LibreDB Results view is not connected to its host.");
  post(message);
}

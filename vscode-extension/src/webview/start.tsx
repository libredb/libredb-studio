// The Results webview's start (part 4 "The entry and the grid's props"): main.tsx calls it with the page's globals,
// so the unit leg reaches every line of it.
import { setNonce } from "get-nonce";
import { createRoot } from "react-dom/client";
import { installCopyRelay } from "./clipboard";
import { ResultsApp } from "./results-app";
import { createResultsStore, type ResultsStore, type VsCodeApi } from "./results-store";

export const NO_NONCE = "The LibreDB Results script has no nonce.";
export const NO_ROOT = "The LibreDB Results page has no #root element.";

export interface ResultsPageEnv {
  window: Window;
  document: Document;
  acquireVsCodeApi: () => VsCodeApi;
}

/**
 * Reads the nonce, sets it for get-nonce, creates the store, attaches the message listener and the copy relay,
 * renders, then posts ready. acquireVsCodeApi is called exactly once, since VS Code allows one call per document.
 */
export function startResultsView(env: ResultsPageEnv): ResultsStore {
  const { document } = env;
  // get-nonce hands this to react-style-singleton, whose <style> the CSP admits only with the script's nonce.
  const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce;
  if (!nonce) throw new Error(NO_NONCE);
  const container = document.getElementById("root");
  if (!container) throw new Error(NO_ROOT);
  setNonce(nonce);
  const store = createResultsStore(env.acquireVsCodeApi(), document.documentElement);
  env.window.addEventListener("message", (event) => store.receive(event.data));
  installCopyRelay(document);
  createRoot(container).render(<ResultsApp store={store} />);
  store.post({ v: 1, type: "ready" });
  return store;
}

// The webview's one store: every host message is parsed, then applied through resultsReducer, and React reads it
// through useSyncExternalStore, so messages that arrive before React mounts are not lost (part 4).
import {
  type HostToWebview,
  INITIAL_VIEW_STATE,
  parseHostMessage,
  parseViewState,
  RESULTS_LIMITS,
  ResultsProtocolError,
  type ResultsViewState,
  type WebviewToHost,
} from "../results-protocol";
import { settleCopy } from "./clipboard";
import { connectHost } from "./host-channel";
import { INITIAL_RESULTS_STATE, type ResultsState, resultsReducer } from "./results-reducer";
import { applyTheme } from "./theme";

/** The part of acquireVsCodeApi()'s object the view uses. */
export interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface ResultsStore {
  /** Parses with parseHostMessage; a refusal posts reportError "Refused a host message: <error message>" and changes nothing. */
  receive(raw: unknown): void;
  post(message: WebviewToHost): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): ResultsState;
  viewState(): ResultsViewState;
  /** Writes through api.setState; only the three fields of ResultsViewState ever reach it. */
  setViewState(next: ResultsViewState): void;
}

/** A guard's refusal, as its message; anything else a guard throws is a defect and is thrown on. */
function refusal(error: unknown): string {
  if (!(error instanceof ResultsProtocolError)) throw error;
  return error.message;
}

/** Connects the host channel to api.postMessage, reads the saved state once, and applies themes to `root`. */
export function createResultsStore(api: VsCodeApi, root: HTMLElement): ResultsStore {
  const post = (message: WebviewToHost) => api.postMessage(message);
  connectHost(post);
  // A refused message's report is cut to the host's bound, since the refusal can echo a long type or key.
  const report = (message: string) =>
    post({ v: 1, type: "reportError", message: message.slice(0, RESULTS_LIMITS.reportErrorChars) });

  let state = INITIAL_RESULTS_STATE;
  const listeners = new Set<() => void>();

  let saved: ResultsViewState;
  try {
    saved = parseViewState(api.getState());
  } catch (error) {
    // VS Code may hand back a state an older build wrote: logged through the host, not silent.
    report(`Ignored the saved view state: ${refusal(error)}`);
    saved = INITIAL_VIEW_STATE;
  }

  const apply = (message: HostToWebview) => {
    if (message.type === "copied") {
      settleCopy(message.requestId, message.ok);
      return;
    }
    const next = resultsReducer(state, message);
    if (next === state) return;
    const themeChanged = next.theme !== state.theme;
    state = next;
    if (themeChanged && next.theme) applyTheme(root, next.theme);
    for (const listener of listeners) listener();
  };

  return {
    receive(raw) {
      let message: HostToWebview;
      try {
        message = parseHostMessage(raw);
      } catch (error) {
        report(`Refused a host message: ${refusal(error)}`);
        return;
      }
      apply(message);
    },
    post,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    viewState: () => saved,
    setViewState(next) {
      saved = {
        v: 1,
        maskingEnabled: next.maskingEnabled,
        scroll: next.scroll && { runId: next.scroll.runId, top: next.scroll.top, left: next.scroll.left },
      };
      api.setState(saved);
    },
  };
}

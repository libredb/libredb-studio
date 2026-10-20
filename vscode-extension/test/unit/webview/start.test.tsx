import assert from "node:assert/strict";
import { act } from "@testing-library/react";
import { getNonce, setNonce } from "get-nonce";
import { connectHost } from "../../../src/webview/host-channel";
import { EMPTY_SENTENCE } from "../../../src/webview/notices";
import type { VsCodeApi } from "../../../src/webview/results-store";
import { useDom } from "../../setup/dom";

// The entry reaches the grid, and Radix picks its layout effect at module load, so it is imported once the DOM exists
// (results-app.test.tsx says why).
let start: typeof import("../../../src/webview/start");

describe("the results webview's entry", () => {
  useDom();
  before(async function () {
    this.timeout(30_000);
    start = await import("../../../src/webview/start");
  });

  let posted: unknown[];
  let acquired: number;
  let onPost: (message: unknown) => void;
  const api: VsCodeApi = {
    postMessage: (message) => {
      posted.push(message);
      onPost(message);
    },
    getState: () => undefined,
    setState: () => {},
  };
  const acquireVsCodeApi = () => {
    acquired++;
    return api;
  };

  const setScript = (nonce: string | null) => {
    let script: HTMLScriptElement | null = null;
    if (nonce !== null) {
      script = document.createElement("script");
      script.nonce = nonce;
    }
    Object.defineProperty(document, "currentScript", { value: script, configurable: true });
  };

  beforeEach(() => {
    posted = [];
    acquired = 0;
    onPost = () => {};
    document.body.innerHTML = '<div id="root"></div>';
    setNonce("");
  });

  afterEach(() => {
    connectHost(undefined);
    document.body.innerHTML = "";
    document.documentElement.className = "";
    delete (document as { currentScript?: unknown }).currentScript;
    delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
  });

  // The React root stays on the detached #root once afterEach clears the body; the empty view it shows holds no timer.
  const startNow = () =>
    act(() => {
      start.startResultsView({ window, document, acquireVsCodeApi });
    });

  it("sets the script's nonce, renders the empty view, and posts ready once", () => {
    setScript("abc");
    startNow();
    assert.deepEqual(posted, [{ v: 1, type: "ready" }]);
    assert.equal(getNonce(), "abc");
    assert.equal(acquired, 1);
    assert.equal(document.getElementById("root")?.textContent, EMPTY_SENTENCE);
  });

  it("relays a copy the page's handlers built to the host", () => {
    setScript("abc");
    startNow();
    const root = document.getElementById("root")!;
    const handler = (event: ClipboardEvent) => {
      event.clipboardData?.setData("text/plain", "a\tb");
      event.preventDefault();
    };
    root.addEventListener("copy", handler);
    root.dispatchEvent(
      new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }),
    );
    root.removeEventListener("copy", handler);
    const copy = posted.at(-1) as { requestId: number };
    assert.deepEqual(copy, { v: 1, type: "copy", requestId: copy.requestId, text: "a\tb" });
  });

  it("listens for host messages before it posts ready", () => {
    setScript("abc");
    onPost = (message) => {
      if ((message as { type: string }).type === "ready") {
        window.dispatchEvent(new MessageEvent("message", { data: { v: 1, type: "init", theme: "dark" } }));
      }
    };
    startNow();
    assert.equal(document.documentElement.classList.contains("dark"), true);
  });

  it("refuses to start without a nonce and posts nothing", () => {
    for (const nonce of [null, ""]) {
      setScript(nonce);
      assert.throws(() => start.startResultsView({ window, document, acquireVsCodeApi }), { message: start.NO_NONCE });
      assert.deepEqual(posted, []);
      assert.equal(acquired, 0);
    }
    assert.equal(start.NO_NONCE, "The LibreDB Results script has no nonce.");
  });

  it("refuses to start without its root element", () => {
    setScript("abc");
    document.body.innerHTML = "";
    assert.throws(() => start.startResultsView({ window, document, acquireVsCodeApi }), {
      message: start.NO_ROOT,
    });
    assert.deepEqual(posted, []);
  });

  it("starts from the entry module with the page's globals", async () => {
    setScript("abc");
    (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = acquireVsCodeApi;
    await act(async () => {
      await import("../../../src/webview/main");
    });
    assert.deepEqual(posted, [{ v: 1, type: "ready" }]);
  });
});

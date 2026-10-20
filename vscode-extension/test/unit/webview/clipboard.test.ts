import assert from "node:assert/strict";
import type { WebviewToHost } from "../../../src/results-protocol";
import { installCopyRelay, settleCopy } from "../../../src/webview/clipboard";
import { connectHost } from "../../../src/webview/host-channel";
import { useDom } from "../../setup/dom";

describe("the copy relay", () => {
  useDom();
  // Registered after useDom's own after hook, so it runs after happy-dom is unregistered.
  after(() => assert.equal(typeof globalThis.document, "undefined"));

  const posted: WebviewToHost[] = [];
  let remove: () => void = () => undefined;
  let cell: HTMLDivElement;

  beforeEach(() => {
    posted.length = 0;
    connectHost((message) => posted.push(message));
    cell = document.createElement("div");
    document.body.append(cell);
    remove = installCopyRelay(document);
  });

  afterEach(() => {
    remove();
    cell.remove();
    connectHost(undefined);
  });

  /** A copy event on the cell, whose own listener acts as the grid's handleGridCopy does when `text` is given. */
  function copyOnCell(text: string | undefined, prevent = text !== undefined): ClipboardEvent {
    const handler = (event: ClipboardEvent) => {
      if (text !== undefined) event.clipboardData?.setData("text/plain", text);
      if (prevent) event.preventDefault();
    };
    cell.addEventListener("copy", handler);
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    cell.dispatchEvent(event);
    cell.removeEventListener("copy", handler);
    return event;
  }

  it("posts the text the grid built to the host, which is the only writer", async () => {
    const event = copyOnCell("a\tb");
    assert.equal(posted.length, 1);
    const request = posted[0];
    assert.ok(request.type === "copy");
    assert.deepEqual(request, { v: 1, type: "copy", requestId: request.requestId, text: "a\tb" });
    // The browser writes nothing of its own: the event stays prevented with its data cleared.
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.clipboardData?.getData("text/plain"), "");
    settleCopy(request.requestId, true);
    await Promise.resolve();
    assert.equal(posted.length, 1);
  });

  it("posts nothing for a copy nobody prevented, or one with no text", () => {
    copyOnCell("a", false);
    copyOnCell(undefined, true);
    copyOnCell("", true);
    copyOnCell(undefined, false);
    assert.deepEqual(posted, []);
  });

  it("posts nothing for a prevented copy event that carries no clipboard data", () => {
    const handler = (event: Event) => event.preventDefault();
    cell.addEventListener("copy", handler);
    cell.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true }));
    cell.removeEventListener("copy", handler);
    assert.deepEqual(posted, []);
  });

  describe('a copy fired at the body, as VS Code desktop\'s execCommand("copy") fires it with nothing selected', () => {
    let grid: HTMLDivElement;
    let fired: number;

    beforeEach(() => {
      fired = 0;
      grid = document.createElement("div");
      grid.tabIndex = 0;
      grid.addEventListener("copy", (event) => {
        fired++;
        if (grid.dataset.text === undefined) return;
        event.clipboardData?.setData("text/plain", grid.dataset.text);
        event.preventDefault();
      });
      document.body.append(grid);
    });

    afterEach(() => {
      grid.remove();
      document.getSelection()?.removeAllRanges();
    });

    function copyOnBody(): ClipboardEvent {
      const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      document.body.dispatchEvent(event);
      return event;
    }

    it("is fired again at the focused element, whose handler builds the text the host writes", () => {
      grid.dataset.text = "Ada\nLin";
      grid.focus();
      const event = copyOnBody();
      assert.equal(fired, 1);
      assert.equal(posted.length, 1);
      assert.deepEqual(posted[0], {
        v: 1,
        type: "copy",
        requestId: (posted[0] as { requestId: number }).requestId,
        text: "Ada\nLin",
      });
      // The browser writes nothing of its own for the original event either.
      assert.equal(event.defaultPrevented, true);
    });

    it("stays unhandled when the focused element builds nothing", () => {
      grid.focus();
      const event = copyOnBody();
      assert.equal(fired, 1);
      assert.deepEqual(posted, []);
      assert.equal(event.defaultPrevented, false);
    });

    it("is not fired again when nothing has focus, when it already passed the focused element, or when text is selected", () => {
      grid.dataset.text = "Ada";
      copyOnBody();
      assert.equal(fired, 0);

      grid.focus();
      delete grid.dataset.text;
      grid.dispatchEvent(
        new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() }),
      );
      assert.equal(fired, 1);

      // Selected text is the browser's to copy, as a key press would copy it.
      grid.dataset.text = "Ada";
      cell.textContent = "selected";
      document.getSelection()?.selectAllChildren(cell);
      assert.equal(document.getSelection()?.type, "Range");
      copyOnBody();
      assert.equal(fired, 1);
      assert.deepEqual(posted, []);
    });
  });

  it("stops relaying once removed", () => {
    remove();
    copyOnCell("a\tb");
    assert.deepEqual(posted, []);
  });
});
